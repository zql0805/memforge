// Created by dev on 2026/05/18
// Copyright © 2026
// Embedding 向量双层缓存（L1 进程内 + L2 Redis）

import { createHash } from 'node:crypto';
import { CacheManager } from './redis.js';
import { getLogger } from './logger.js';

const logger = getLogger('embedding-cache');

export type EmbeddingCacheKind = 'query' | 'passage' | 'raw';

export interface EmbeddingCacheOptions {
  /** 默认 true；设 EMBEDDING_CACHE=off 可关闭 */
  enabled?: boolean;
  /** L2 TTL（秒），默认 3600 */
  ttlSeconds?: number;
  l1MaxSize?: number;
  l1TtlMs?: number;
}

export interface EmbeddingCacheStats {
  hits: number;
  misses: number;
}

/**
 * 按 model + 文本内容缓存 embedding 向量，减少重复 API 调用。
 */
export class EmbeddingVectorCache {
  private readonly cache: CacheManager;
  private readonly enabled: boolean;
  private readonly ttlSeconds: number;
  private readonly model: string;
  private hits = 0;
  private misses = 0;

  constructor(model: string, options?: EmbeddingCacheOptions) {
    this.model = model;
    const envOff = process.env.EMBEDDING_CACHE === 'off';
    this.enabled = options?.enabled ?? !envOff;
    this.ttlSeconds = options?.ttlSeconds
      ?? parseInt(process.env.EMBEDDING_CACHE_TTL_SECONDS ?? '3600', 10);
    this.cache = new CacheManager({
      l1MaxSize: options?.l1MaxSize
        ?? parseInt(process.env.EMBEDDING_CACHE_L1_SIZE ?? '2000', 10),
      l1TtlMs: options?.l1TtlMs
        ?? parseInt(process.env.EMBEDDING_CACHE_L1_TTL_MS ?? '300000', 10),
    });
  }

  /** 供测试与监控 */
  buildKey(kind: EmbeddingCacheKind, text: string): string {
    const hash = createHash('sha256').update(text).digest('hex');
    return `emb:v1:${this.model}:${kind}:${hash}`;
  }

  async get(kind: EmbeddingCacheKind, text: string): Promise<number[] | null> {
    if (!this.enabled) return null;
    const vec = await this.cache.get<number[]>(this.buildKey(kind, text));
    if (vec && vec.length > 0) {
      this.hits++;
      return vec;
    }
    this.misses++;
    return null;
  }

  async set(kind: EmbeddingCacheKind, text: string, vector: number[]): Promise<void> {
    if (!this.enabled || vector.length === 0) return;
    await this.cache.set(this.buildKey(kind, text), vector, this.ttlSeconds);
  }

  getStats(): EmbeddingCacheStats {
    return { hits: this.hits, misses: this.misses };
  }

  logStatsIfNeeded(): void {
    const { hits, misses } = this.getStats();
    const total = hits + misses;
    if (total > 0 && total % 500 === 0) {
      logger.debug({ hits, misses, model: this.model }, 'Embedding 缓存统计');
    }
  }
}
