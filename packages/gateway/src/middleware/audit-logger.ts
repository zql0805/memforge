// Created by dev on 2026/04/05
// Copyright © 2026
// 审计日志中间件 — 写入 PostgreSQL audit_logs 表

import { query, getLogger } from '@memforgeai/shared';

const logger = getLogger('audit');

export interface AuditEvent {
  orgId: string | null;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * 审计日志服务。
 * 异步写入数据库，不阻塞主请求流程。
 */
export class AuditLogger {
  private readonly buffer: AuditEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private readonly maxBufferSize: number;

  constructor(options?: { flushIntervalMs?: number; maxBufferSize?: number }) {
    this.flushIntervalMs = options?.flushIntervalMs ?? 5000;
    this.maxBufferSize = options?.maxBufferSize ?? 100;
    this.startAutoFlush();
  }

  log(event: AuditEvent): void {
    this.buffer.push(event);

    if (this.buffer.length >= this.maxBufferSize) {
      this.flush().catch(err => {
        logger.error({ error: err }, '审计日志批量写入失败');
      });
    }
  }

  /** MCP 工具调用审计快捷方法 */
  logToolCall(params: {
    orgId: string | null;
    userId: string | null;
    tool: string;
    args: Record<string, unknown>;
    success: boolean;
    durationMs: number;
    ipAddress: string | null;
    userAgent: string | null;
  }): void {
    this.log({
      orgId: params.orgId,
      userId: params.userId,
      action: params.success ? 'TOOL_CALL' : 'TOOL_CALL_FAILED',
      resourceType: 'tool',
      resourceId: null,
      details: {
        tool: params.tool,
        args_summary: summarizeArgs(params.args),
        duration_ms: params.durationMs,
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  /** 认证事件审计 */
  logAuthEvent(params: {
    action: 'LOGIN' | 'TOKEN_ISSUED' | 'TOKEN_REFRESHED' | 'TOKEN_REVOKED' | 'AUTH_FAILED' | 'AUTH_RATE_LIMITED' | 'AUTH_LOCKED' | 'ACCOUNT_UNLOCKED' | 'USER_REGISTERED' | 'PASSWORD_CHANGED' | 'PASSWORD_RESET' | 'API_KEY_CREATED' | 'API_KEY_REVOKED' | 'DEVICE_PENDING' | 'DEVICE_APPROVED' | 'DEVICE_REVOKED';
    userId: string | null;
    details: Record<string, unknown>;
    ipAddress: string | null;
    userAgent: string | null;
  }): void {
    this.log({
      orgId: null,
      userId: params.userId,
      action: params.action,
      resourceType: 'auth',
      resourceId: null,
      details: params.details,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const events = this.buffer.splice(0, this.buffer.length);

    try {
      // 批量插入，单次最多 100 条
      const values: unknown[] = [];
      const placeholders: string[] = [];

      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        const offset = i * 8;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`
        );
        values.push(
          e.orgId,
          e.userId,
          e.action,
          e.resourceType,
          e.resourceId,
          e.details ? JSON.stringify(e.details) : null,
          e.ipAddress,
          e.userAgent,
        );
      }

      await query(
        `INSERT INTO memory.audit_logs (org_id, user_id, action, resource_type, resource_id, details, ip_address, user_agent)
         VALUES ${placeholders.join(', ')}`,
        values,
      );

      logger.debug({ count: events.length }, '审计日志已写入');
    } catch (err) {
      logger.error({ error: err, count: events.length }, '审计日志写入失败，重新入队');
      // 写入失败则放回缓冲区（避免丢失）
      this.buffer.unshift(...events);
    }
  }

  private startAutoFlush(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(err => {
        logger.error({ error: err }, '定时刷新审计日志失败');
      });
    }, this.flushIntervalMs);

    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  async destroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

/** 截取参数摘要，避免审计日志存入过长内容 */
function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 200) {
      summary[key] = value.slice(0, 200) + `... (${value.length} chars)`;
    } else {
      summary[key] = value;
    }
  }
  return summary;
}
