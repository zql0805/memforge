// Created by dev on 2026/04/04
// Copyright © 2026
// PostgreSQL 连接池 — 共享数据库访问层

import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { getLogger } from './logger.js';

const logger = getLogger('db');

const SCHEMA_NAME_RE = /^[a-z_][a-z0-9_]*$/;

function assertValidSchemaName(schema: string): string {
  if (!SCHEMA_NAME_RE.test(schema)) {
    throw new Error(`非法 schema 名称: ${schema}`);
  }
  return schema;
}

// ── RLS 上下文（通过 AsyncLocalStorage 线程安全传递） ──
export interface RLSContext {
  userId: string;
  orgId: string;
  userRole: string;
}

interface RLSStore {
  ctx: RLSContext;
  client?: pg.PoolClient;
}

const SET_RLS_SQL =
  "SELECT set_config('app.current_user_id', $1, false), set_config('app.current_org_id', $2, false), set_config('app.current_user_role', $3, false)";
const CLEAR_RLS_SQL =
  "SELECT set_config('app.current_user_id', '', false), set_config('app.current_org_id', '', false), set_config('app.current_user_role', '', false)";

const rlsStorage = new AsyncLocalStorage<RLSStore>();

/**
 * 在 RLS 上下文中执行回调（同步，不绑定连接）。
 * 高并发请求请改用 runWithRLSAsync，避免 queryWithRLS 每次独占连接。
 */
export function runWithRLS<T>(ctx: RLSContext, fn: () => T): T {
  return rlsStorage.run({ ctx }, fn);
}

/**
 * 在 RLS 上下文中执行异步回调，请求级复用同一连接。
 * 回调内 queryWithRLS() 共享该连接上的 session 变量，避免每查一连接。
 */
export async function runWithRLSAsync<T>(ctx: RLSContext, fn: () => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(SET_RLS_SQL, [ctx.userId, ctx.orgId, ctx.userRole]);
    return await rlsStorage.run({ ctx, client }, fn);
  } finally {
    await client.query(CLEAR_RLS_SQL).catch((err) => {
      logger.debug({ err }, '清除 RLS session 变量失败（连接释放前，通常无害）');
    });
    client.release();
  }
}

/** 获取当前请求的 RLS 上下文（无上下文时返回 undefined） */
export function getRLSContext(): RLSContext | undefined {
  return rlsStorage.getStore()?.ctx;
}

/**
 * 在设置了 RLS session 变量的连接上执行查询。
 * runWithRLSAsync 包裹的请求复用同一连接；否则每次查询独占连接（兼容旧调用）。
 */
export async function queryWithRLS<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const store = rlsStorage.getStore();
  if (!store) {
    return getPool().query<T>(text, params);
  }

  if (store.client) {
    return store.client.query<T>(text, params);
  }

  const client = await getPool().connect();
  try {
    await client.query(SET_RLS_SQL, [store.ctx.userId, store.ctx.orgId, store.ctx.userRole]);
    return await client.query<T>(text, params);
  } finally {
    await client.query(CLEAR_RLS_SQL).catch((err) => {
      logger.debug({ err }, '清除 RLS session 变量失败（连接释放前，通常无害）');
    });
    client.release();
  }
}

let pool: pg.Pool | null = null;

export interface DbConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | pg.ConnectionConfig['ssl'];
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  schema?: string;
}

/**
 * 初始化 PostgreSQL 连接池（全局单例）。
 * memory-service 和 rules-engine 共用同一数据库不同表。
 */
export function initPool(config: DbConfig): pg.Pool {
  if (pool) return pool;

  pool = new pg.Pool({
    connectionString: config.connectionString,
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl,
    max: config.max ?? 20,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
  });

  pool.on('error', (err) => {
    logger.error({ error: err }, 'PostgreSQL 连接池异常');
  });

  const schema = assertValidSchemaName(config.schema ?? 'memory');
  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${schema}, public`).catch((err) => {
      logger.warn({ error: err }, '设置 search_path 失败');
    });
  });

  logger.info({
    host: config.host ?? '(connection string)',
    database: config.database ?? '(connection string)',
    max: config.max ?? 20,
    schema,
  }, 'PostgreSQL 连接池已初始化');

  return pool;
}

/** 获取已初始化的连接池 */
export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error('PostgreSQL 连接池未初始化，请先调用 initPool()');
  }
  return pool;
}

/** 执行查询（简写） */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/** 事务辅助：自动 BEGIN/COMMIT/ROLLBACK */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** 关闭连接池 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('PostgreSQL 连接池已关闭');
  }
}
