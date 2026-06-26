// Created by dev on 2026/04/11
// Copyright © 2026
// 登录端点专用限流器（独立于 MCP 工具限流）

import { getLogger } from '@memforgeai/shared';

const logger = getLogger('login-rate-limiter');

const BUCKET_MAX_AGE_MS = 5 * 60 * 1000;
const BUCKET_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface LoginRateLimitConfig {
  /** 单 IP 每分钟最大登录尝试（默认 10） */
  perIpRpm: number;
  /** 单账号每分钟最大登录尝试（默认 5） */
  perAccountRpm: number;
  /** 全局每分钟最大登录尝试（默认 100） */
  globalRpm: number;
}

const DEFAULT_CONFIG: LoginRateLimitConfig = {
  perIpRpm: 10,
  perAccountRpm: 5,
  globalRpm: 100,
};

export interface LoginRateLimitResult {
  reason: 'ip' | 'account' | 'global';
  retryAfterMs: number;
}

/**
 * 登录端点限流器。
 * 仅限流密码认证（client_credentials + password），不影响 refresh_token / authorization_code / API Key。
 */
export class LoginRateLimiter {
  private readonly globalBucket: Bucket;
  private readonly ipBuckets = new Map<string, Bucket>();
  private readonly accountBuckets = new Map<string, Bucket>();
  private readonly config: LoginRateLimitConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<LoginRateLimitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.globalBucket = { tokens: this.config.globalRpm, lastRefill: Date.now() };
    this.startCleanup();
  }

  /**
   * 检查登录请求是否被允许。
   * @returns null 表示允许，否则返回拒绝原因和重试时间
   */
  check(ip: string, externalId: string): LoginRateLimitResult | null {
    const now = Date.now();

    // 全局限流
    if (!this.tryConsume(this.globalBucket, this.config.globalRpm, now)) {
      logger.warn({ ip, externalId }, '登录全局限流触发');
      return {
        reason: 'global',
        retryAfterMs: this.getRefillTime(this.globalBucket, this.config.globalRpm, now),
      };
    }

    // IP 限流
    if (!this.ipBuckets.has(ip)) {
      this.ipBuckets.set(ip, { tokens: this.config.perIpRpm, lastRefill: now });
    }
    const ipBucket = this.ipBuckets.get(ip)!;
    if (!this.tryConsume(ipBucket, this.config.perIpRpm, now)) {
      this.globalBucket.tokens++;
      logger.warn({ ip, externalId }, '登录 IP 限流触发');
      return {
        reason: 'ip',
        retryAfterMs: this.getRefillTime(ipBucket, this.config.perIpRpm, now),
      };
    }

    // 账号限流
    if (!this.accountBuckets.has(externalId)) {
      this.accountBuckets.set(externalId, { tokens: this.config.perAccountRpm, lastRefill: now });
    }
    const acctBucket = this.accountBuckets.get(externalId)!;
    if (!this.tryConsume(acctBucket, this.config.perAccountRpm, now)) {
      this.globalBucket.tokens++;
      ipBucket.tokens++;
      logger.warn({ ip, externalId }, '登录账号限流触发');
      return {
        reason: 'account',
        retryAfterMs: this.getRefillTime(acctBucket, this.config.perAccountRpm, now),
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
    const refillRate = maxTokens / 60_000;
    const tokensToAdd = elapsed * refillRate;
    if (tokensToAdd >= 1) {
      bucket.tokens = Math.min(maxTokens, bucket.tokens + Math.floor(tokensToAdd));
      bucket.lastRefill = now;
    }
  }

  private getRefillTime(bucket: Bucket, maxTokens: number, now: number): number {
    const refillRate = maxTokens / 60_000;
    this.refill(bucket, maxTokens, now);
    if (bucket.tokens > 0) return 0;
    return Math.ceil(1 / refillRate);
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.ipBuckets) {
        if (now - bucket.lastRefill > BUCKET_MAX_AGE_MS) this.ipBuckets.delete(key);
      }
      for (const [key, bucket] of this.accountBuckets) {
        if (now - bucket.lastRefill > BUCKET_MAX_AGE_MS) this.accountBuckets.delete(key);
      }
    }, BUCKET_CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
