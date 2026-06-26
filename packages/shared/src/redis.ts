// Created by dev on 2026/04/05
// Copyright © 2026
// Redis 缓存客户端 — M3c 多层缓存支持

import { Redis } from 'ioredis';
import { getLogger } from './logger.js';

const logger = getLogger('redis');

let redisClient: Redis | null = null;

export interface RedisConfig {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  maxRetriesPerRequest?: number;
  connectTimeout?: number;
}

/** 从环境变量解析 Redis 配置；未设置 REDIS_URL 时返回 null */
export function loadRedisConfig(): RedisConfig | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return {
    url,
    keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'mf:',
    maxRetriesPerRequest: parseIntEnv('REDIS_MAX_RETRIES', 3),
    connectTimeout: parseIntEnv('REDIS_CONNECT_TIMEOUT_MS', 10_000),
  };
}

function parseIntEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/** 初始化 Redis 客户端（全局单例） */
export function initRedis(config: RedisConfig): Redis {
  if (redisClient) return redisClient;

  const clientOptions = {
    keyPrefix: config.keyPrefix,
    maxRetriesPerRequest: config.maxRetriesPerRequest ?? 3,
    connectTimeout: config.connectTimeout ?? 10_000,
    lazyConnect: true,
  };

  if (config.url) {
    redisClient = new Redis(config.url, clientOptions);
  } else {
    redisClient = new Redis({
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 6379,
      password: config.password,
      db: config.db ?? 0,
      ...clientOptions,
    });
  }

  redisClient.on('connect', () => logger.info('Redis 已连接'));
  redisClient.on('error', (err: Error) => logger.error({ error: err }, 'Redis 连接异常'));
  redisClient.on('close', () => logger.info('Redis 连接已关闭'));

  return redisClient;
}

/** 获取已初始化的 Redis 客户端，未连接时返回 null */
export function getRedis(): Redis | null {
  return redisClient;
}

/** 关闭 Redis 连接并释放单例 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis 客户端已关闭');
  }
}

/** 连接 Redis（可选）；失败时降级为仅 L1 进程内缓存 */
export async function ensureRedisConnected(): Promise<void> {
  const redisConfig = loadRedisConfig();
  if (!redisConfig) return;

  const redis = initRedis(redisConfig);
  await redis.connect().catch((err: Error) => {
    logger.warn({ err: err.message }, 'Redis 连接失败，降级为进程内缓存');
  });
}

/**
 * 双层缓存：L1 进程内 + L2 Redis。
 * 用于记忆检索结果、活跃规则列表等热点数据。
 */
export class CacheManager {
  /** L1: 进程内 LRU 缓存 */
  private readonly l1 = new Map<string, { value: string; expiresAt: number }>();
  private readonly l1MaxSize: number;
  private readonly l1TtlMs: number;

  constructor(options?: { l1MaxSize?: number; l1TtlMs?: number }) {
    this.l1MaxSize = options?.l1MaxSize ?? 1000;
    this.l1TtlMs = options?.l1TtlMs ?? 5 * 60 * 1000;
  }

  private parseCachedJson<T>(raw: string, key: string): T | null {
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.warn({ error: err, key }, '缓存 JSON 解析失败，视为 miss');
      return null;
    }
  }

  /**
   * 读取缓存（L1 → L2 → miss）
   */
  async get<T>(key: string): Promise<T | null> {
    // L1
    const l1Entry = this.l1.get(key);
    if (l1Entry && l1Entry.expiresAt > Date.now()) {
      const parsed = this.parseCachedJson<T>(l1Entry.value, key);
      if (parsed === null) this.l1.delete(key);
      return parsed;
    }
    if (l1Entry) this.l1.delete(key);

    // L2
    const redis = getRedis();
    if (!redis) return null;

    try {
      const raw = await redis.get(key);
      if (!raw) return null;

      const parsed = this.parseCachedJson<T>(raw, key);
      if (parsed !== null) {
        this.setL1(key, raw);
      }
      return parsed;
    } catch (err) {
      logger.warn({ error: err, key }, 'Redis GET 失败，降级为无缓存');
      return null;
    }
  }

  /**
   * 写入缓存（同时写 L1 + L2）
   * @param ttlSeconds L2 TTL（秒），默认 30 分钟
   */
  async set(key: string, value: unknown, ttlSeconds = 1800): Promise<void> {
    const json = JSON.stringify(value);

    // L1
    this.setL1(key, json);

    // L2
    const redis = getRedis();
    if (!redis) return;

    try {
      await redis.set(key, json, 'EX', ttlSeconds);
    } catch (err) {
      logger.warn({ error: err, key }, 'Redis SET 失败');
    }
  }

  /**
   * 删除缓存（L1 + L2）
   */
  async del(key: string): Promise<void> {
    this.l1.delete(key);

    const redis = getRedis();
    if (!redis) return;

    try {
      await redis.del(key);
    } catch (err) {
      logger.warn({ error: err, key }, 'Redis DEL 失败');
    }
  }

  /**
   * 按前缀批量失效
   */
  async invalidateByPrefix(prefix: string): Promise<void> {
    // L1
    for (const key of this.l1.keys()) {
      if (key.startsWith(prefix)) this.l1.delete(key);
    }

    // L2
    const redis = getRedis();
    if (!redis) return;

    try {
      const stream = redis.scanStream({ match: `${prefix}*`, count: 100 });
      for await (const batch of stream) {
        if (!Array.isArray(batch) || batch.length === 0) continue;
        const pipeline = redis.pipeline();
        for (const k of batch) {
          pipeline.del(k);
        }
        await pipeline.exec();
      }
    } catch (err) {
      logger.warn({ error: err, prefix }, 'Redis 批量失效失败');
    }
  }

  private setL1(key: string, json: string): void {
    if (this.l1.size >= this.l1MaxSize) {
      // 简易 LRU：删除最早的 25% 条目
      const keys = Array.from(this.l1.keys());
      const deleteCount = Math.floor(this.l1MaxSize * 0.25);
      for (let i = 0; i < deleteCount; i++) {
        this.l1.delete(keys[i]);
      }
    }
    this.l1.set(key, { value: json, expiresAt: Date.now() + this.l1TtlMs });
  }
}
