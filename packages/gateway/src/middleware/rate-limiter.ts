// Created by dev on 2026/04/05
// Copyright © 2026
// 分层速率限制器（Token Bucket 算法）

import { getLogger } from '@memforgeai/shared';

const logger = getLogger('rate-limiter');

const BUCKET_MAX_AGE_MS = 5 * 60 * 1000;
const BUCKET_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Token Bucket 速率限制器。
 * 支持三层限流：全局 / 用户 / 工具。
 */
export class RateLimiter {
  private readonly globalBucket: Bucket;
  private readonly userBuckets = new Map<string, Bucket>();
  private readonly toolBuckets = new Map<string, Bucket>();

  /** 清理过期桶的定时器 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly globalRpm: number,
    private readonly perUserRpm: number,
    private readonly perToolRpm: number,
  ) {
    this.globalBucket = { tokens: globalRpm, lastRefill: Date.now() };
    this.startCleanup();
  }

  /**
   * 检查请求是否被允许。
   * @returns null 表示允许，否则返回拒绝原因和重试时间
   */
  check(userId: string, tool: string): RateLimitResult | null {
    const now = Date.now();

    // 全局限流
    const globalResult = this.tryConsume(this.globalBucket, this.globalRpm, now);
    if (!globalResult) {
      logger.warn({ userId, tool }, '全局速率限制触发');
      return {
        reason: 'global',
        retryAfterMs: this.getRefillTime(this.globalBucket, this.globalRpm, now),
      };
    }

    // 用户限流
    const userKey = userId;
    if (!this.userBuckets.has(userKey)) {
      this.userBuckets.set(userKey, { tokens: this.perUserRpm, lastRefill: now });
    }
    const userBucket = this.userBuckets.get(userKey)!;
    const userResult = this.tryConsume(userBucket, this.perUserRpm, now);
    if (!userResult) {
      // 回退全局令牌
      this.globalBucket.tokens++;
      logger.warn({ userId, tool }, '用户速率限制触发');
      return {
        reason: 'user',
        retryAfterMs: this.getRefillTime(userBucket, this.perUserRpm, now),
      };
    }

    // 工具限流（按 userId:tool 维度）
    const toolKey = `${userId}:${tool}`;
    if (!this.toolBuckets.has(toolKey)) {
      this.toolBuckets.set(toolKey, { tokens: this.perToolRpm, lastRefill: now });
    }
    const toolBucket = this.toolBuckets.get(toolKey)!;
    const toolResult = this.tryConsume(toolBucket, this.perToolRpm, now);
    if (!toolResult) {
      // 回退上层令牌
      this.globalBucket.tokens++;
      userBucket.tokens++;
      logger.warn({ userId, tool }, '工具速率限制触发');
      return {
        reason: 'tool',
        retryAfterMs: this.getRefillTime(toolBucket, this.perToolRpm, now),
      };
    }

    return null;
  }

  private tryConsume(bucket: Bucket, maxTokens: number, now: number): boolean {
    this.refill(bucket, maxTokens, now);
    if (bucket.tokens > 0) {
      bucket.tokens--;
      return true;
    }
    return false;
  }

  private refill(bucket: Bucket, maxTokens: number, now: number): void {
    const elapsed = now - bucket.lastRefill;
    const refillRate = maxTokens / 60000; // 每毫秒补充的令牌数
    const tokensToAdd = elapsed * refillRate;

    if (tokensToAdd >= 1) {
      bucket.tokens = Math.min(maxTokens, bucket.tokens + Math.floor(tokensToAdd));
      bucket.lastRefill = now;
    }
  }

  private getRefillTime(bucket: Bucket, maxTokens: number, now: number): number {
    const refillRate = maxTokens / 60000;
    const timeForOneToken = 1 / refillRate;
    this.refill(bucket, maxTokens, now);
    if (bucket.tokens > 0) return 0;
    return Math.ceil(timeForOneToken);
  }

  private startCleanup(): void {
    // 每 5 分钟清理不活跃的桶
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();

      for (const [key, bucket] of this.userBuckets) {
        if (now - bucket.lastRefill > BUCKET_MAX_AGE_MS) {
          this.userBuckets.delete(key);
        }
      }
      for (const [key, bucket] of this.toolBuckets) {
        if (now - bucket.lastRefill > BUCKET_MAX_AGE_MS) {
          this.toolBuckets.delete(key);
        }
      }
    }, BUCKET_CLEANUP_INTERVAL_MS);

    // 不阻止进程退出
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

export interface RateLimitResult {
  reason: 'global' | 'user' | 'tool';
  retryAfterMs: number;
}
