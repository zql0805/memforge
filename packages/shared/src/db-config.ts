// Created by dev on 2026/04/04
// Copyright © 2026
// 数据库连接配置 — 从环境变量解析

import type { DbConfig } from './db.js';

function isDevOrTest(): boolean {
  const env = process.env.NODE_ENV;
  return env === 'development' || env === 'test';
}

function resolveDbPassword(): string {
  const password = process.env.DB_PASSWORD;
  if (password) return password;
  if (isDevOrTest()) return 'memforge_dev';
  throw new Error('生产环境必须设置 DB_PASSWORD 环境变量');
}

/**
 * 从环境变量解析数据库连接配置。
 * 优先使用 DATABASE_URL，若未设置则回退到分离变量。
 */
export function loadDbConfig(): DbConfig {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    return {
      connectionString: databaseUrl,
      max: parseIntEnv('DB_POOL_MAX', 20),
      schema: process.env.DB_SCHEMA ?? 'memory',
    };
  }

  return {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseIntEnv('DB_PORT', 5432),
    database: process.env.DB_NAME ?? 'memforge',
    user: process.env.DB_USER ?? 'memforge',
    password: resolveDbPassword(),
    ssl: process.env.DB_SSL === 'true',
    max: parseIntEnv('DB_POOL_MAX', 20),
    schema: process.env.DB_SCHEMA ?? 'memory',
  };
}

function parseIntEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}
