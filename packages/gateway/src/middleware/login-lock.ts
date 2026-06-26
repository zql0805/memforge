// Created by dev on 2026/04/11
// Copyright © 2026
// 登录失败锁定（基于内存，进程重启自动清零）

import { getLogger } from '@memforgeai/shared';

const logger = getLogger('login-lock');

interface LockRecord {
  failCount: number;
  lockedUntil: number;
}

export interface LoginLockConfig {
  maxAttempts: number;
  lockDurationMs: number;
}

export interface LockCheckResult {
  locked: boolean;
  retryAfterMs: number;
  remainingAttempts: number;
}

/**
 * 基于 external_id 的登录失败锁定器。
 * 连续失败 N 次后锁定账号一段时间。成功登录后清除失败计数。
 *
 * TODO: 当前使用进程内 Map 存储，多 Gateway 实例部署时锁定状态不共享。
 * 后续应迁移到 Redis（项目已有 REDIS_URL / ioredis 依赖），以支持跨实例防暴力破解。
 */
export class LoginLock {
  private readonly records = new Map<string, LockRecord>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: LoginLockConfig) {
    this.startCleanup();
  }

  /** 检查账号是否被锁定 */
  check(externalId: string): LockCheckResult {
    const record = this.records.get(externalId);
    if (!record) {
      return { locked: false, retryAfterMs: 0, remainingAttempts: this.config.maxAttempts };
    }

    const now = Date.now();
    if (record.lockedUntil > 0 && record.lockedUntil > now) {
      return {
        locked: true,
        retryAfterMs: record.lockedUntil - now,
        remainingAttempts: 0,
      };
    }

    // 锁定已过期，重置
    if (record.lockedUntil > 0 && record.lockedUntil <= now) {
      this.records.delete(externalId);
      return { locked: false, retryAfterMs: 0, remainingAttempts: this.config.maxAttempts };
    }

    return {
      locked: false,
      retryAfterMs: 0,
      remainingAttempts: Math.max(0, this.config.maxAttempts - record.failCount),
    };
  }

  /** 记录一次登录失败 */
  recordFailure(externalId: string): LockCheckResult {
    const record = this.records.get(externalId) ?? { failCount: 0, lockedUntil: 0 };
    record.failCount++;

    if (record.failCount >= this.config.maxAttempts) {
      record.lockedUntil = Date.now() + this.config.lockDurationMs;
      logger.warn(
        { externalId, failCount: record.failCount, lockDurationMs: this.config.lockDurationMs },
        '账号因连续登录失败被锁定',
      );
    }

    this.records.set(externalId, record);

    return {
      locked: record.lockedUntil > Date.now(),
      retryAfterMs: record.lockedUntil > Date.now() ? record.lockedUntil - Date.now() : 0,
      remainingAttempts: Math.max(0, this.config.maxAttempts - record.failCount),
    };
  }

  /** 登录成功后清除失败计数 */
  clearOnSuccess(externalId: string): void {
    this.records.delete(externalId);
  }

  /** 管理员强制解除锁定 */
  clearLock(externalId: string): boolean {
    const existed = this.records.has(externalId);
    this.records.delete(externalId);
    if (existed) {
      logger.info({ externalId }, '管理员解除账号锁定');
    }
    return existed;
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, record] of this.records) {
        // 清理已过期的锁定记录和长期不活跃的记录
        if (record.lockedUntil > 0 && record.lockedUntil < now - this.config.lockDurationMs) {
          this.records.delete(key);
        }
      }
    }, 5 * 60 * 1000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
