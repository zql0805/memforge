// Created by dev on 2026/04/09
// API Key 存储层 — 生成、验证、管理

import { createHash, randomBytes } from 'node:crypto';
import { query, getLogger, ApiKeyCreationScope, type ApiKeyCreationScope as ApiKeyCreationScopeValue } from '@memforgeai/shared';

const logger = getLogger('api-key-store');

const API_KEY_PREFIX = 'mfk_';

export function parseApiKeyScope(scope: unknown): ApiKeyCreationScopeValue {
  if (scope === undefined || scope === null || scope === '') {
    return 'readwrite';
  }
  const parsed = ApiKeyCreationScope.safeParse(scope);
  if (!parsed.success) {
    throw new Error(`无效的 API Key scope: ${String(scope)}，合法值: ${ApiKeyCreationScope.options.join(', ')}`);
  }
  return parsed.data;
}

export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  scope: ApiKeyCreationScopeValue;
  lastUsedAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface ApiKeyVerifyResult {
  userId: string;
  scope: ApiKeyCreationScopeValue;
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scope: string;
  last_used_at: string | null;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
}

export class ApiKeyStore {
  /**
   * 生成新的 API Key。返回完整密钥（仅此一次可见）和记录信息。
   */
  async generate(
    userId: string,
    name: string,
    expiresAt?: Date,
    scope: ApiKeyCreationScopeValue = 'readwrite',
  ): Promise<{
    key: string;
    record: ApiKeyRecord;
  }> {
    const rawKey = randomBytes(32).toString('base64url');
    const fullKey = `${API_KEY_PREFIX}${rawKey}`;
    const keyPrefix = fullKey.slice(0, 12);
    const keyHash = hashKey(fullKey);

    const result = await query<ApiKeyRow>(
      `INSERT INTO memory.api_keys (user_id, name, key_prefix, key_hash, expires_at, scope)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, name, keyPrefix, keyHash, expiresAt?.toISOString() ?? null, scope],
    );

    logger.info({ userId, name, keyPrefix }, 'API Key 已生成');

    return {
      key: fullKey,
      record: mapRow(result.rows[0]),
    };
  }

  /**
   * 验证 API Key，返回对应的 userId 或 null。
   * 验证通过后自动更新 last_used_at。
   */
  async verify(key: string): Promise<ApiKeyVerifyResult | null> {
    if (!key.startsWith(API_KEY_PREFIX)) return null;

    const keyPrefix = key.slice(0, 12);
    const keyHash = hashKey(key);

    const result = await query<{ user_id: string; expires_at: string | null; scope: string }>(
      `SELECT user_id, expires_at, scope FROM memory.api_keys
       WHERE key_prefix = $1 AND key_hash = $2 AND is_active = TRUE`,
      [keyPrefix, keyHash],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];

    // 过期检查
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return null;
    }

    const scope = parseApiKeyScope(row.scope);

    // 异步更新 last_used_at（不阻塞验证流程）
    query(
      `UPDATE memory.api_keys SET last_used_at = NOW() WHERE key_prefix = $1 AND key_hash = $2`,
      [keyPrefix, keyHash],
    ).catch((err) => {
      logger.debug({ err }, '更新 API Key last_used_at 失败（非阻塞）');
    });

    return { userId: row.user_id, scope };
  }

  /** 列出用户的所有 API Key（不含密钥原文） */
  async listByUser(userId: string): Promise<ApiKeyRecord[]> {
    const result = await query<ApiKeyRow>(
      `SELECT * FROM memory.api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows.map(mapRow);
  }

  /** 撤销 API Key */
  async revoke(keyId: string, userId: string): Promise<boolean> {
    const result = await query(
      `UPDATE memory.api_keys SET is_active = FALSE WHERE id = $1 AND user_id = $2`,
      [keyId, userId],
    );
    const done = (result.rowCount ?? 0) > 0;
    if (done) logger.info({ keyId, userId }, 'API Key 已撤销');
    return done;
  }
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function mapRow(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scope: parseApiKeyScope(row.scope),
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}
