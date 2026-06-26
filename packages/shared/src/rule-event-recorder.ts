// Created by dev on 2026/05/09
// Copyright © 2026
// 规则事件批量记录器 — 供 memory-service 和 rules-engine 共用
// 直接操作 memory.rule_events + memory.rules 表，避免跨包依赖

import { randomUUID } from 'node:crypto';
import { getPool } from './db.js';
import { getLogger } from './logger.js';

const logger = getLogger('rule-event-recorder');

type EventType = 'applied' | 'violated' | 'accepted' | 'rejected' | 'auto_fixed';

interface BatchEventInput {
  ruleId: string;
  eventType: EventType;
  filePath?: string | null;
  codeSnippet?: string | null;
  userId?: string | null;
  metadata?: Record<string, unknown>;
}

const COUNTER_FIELDS: Record<string, string> = {
  applied: 'applied_count',
  violated: 'violated_count',
  accepted: 'accepted_count',
  rejected: 'rejected_count',
  auto_fixed: 'applied_count',
};

/**
 * 批量记录规则事件并递增计数器。
 * 内部使用事务保证一致性，失败时静默降级不影响主流程。
 */
export async function batchRecordRuleEvents(events: BatchEventInput[]): Promise<number> {
  if (events.length === 0) return 0;

  const pool = getPool();
  const client = await pool.connect();
  let recorded = 0;

  try {
    await client.query('BEGIN');

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const savepoint = `ev_${i}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const id = randomUUID();
        const now = new Date().toISOString();

        await client.query(
          `INSERT INTO memory.rule_events (id, rule_id, event_type, file_path, code_snippet, user_id, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, ev.ruleId, ev.eventType, ev.filePath ?? null, ev.codeSnippet ?? null,
           ev.userId ?? null, JSON.stringify(ev.metadata ?? {}), now],
        );

        const counterField = COUNTER_FIELDS[ev.eventType];
        if (!counterField) {
          throw new Error(`未知的规则事件类型，无法更新计数器: ${ev.eventType}`);
        }
        await client.query(
          `UPDATE memory.rules SET ${counterField} = ${counterField} + 1, updated_at = NOW() WHERE id = $1`,
          [ev.ruleId],
        );

        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        recorded++;
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch((err) => {
          logger.debug({ err, savepoint }, '回滚 savepoint 失败');
        });
        logger.error({ err, event: ev, index: i }, '规则事件单条记录失败，已跳过');
      }
    }

    await client.query('COMMIT');
    if (recorded > 0) {
      logger.info({ recorded, failed: events.length - recorded, types: [...new Set(events.map(e => e.eventType))] }, '规则事件批量记录完成');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch((err) => {
      logger.debug({ err }, '规则事件批量记录事务 ROLLBACK 失败');
    });
    logger.error({ err: String(err), attempted: events.length, recorded }, '规则事件批量记录事务失败');
    recorded = 0;
  } finally {
    client.release();
  }

  return recorded;
}

/**
 * 快捷方法：为一批规则 ID 记录同一类型的事件
 */
export async function recordAppliedForRules(
  ruleIds: string[],
  userId?: string | null,
): Promise<number> {
  const events: BatchEventInput[] = ruleIds.map(ruleId => ({
    ruleId,
    eventType: 'applied' as const,
    userId: userId ?? null,
  }));
  return batchRecordRuleEvents(events);
}

/**
 * 快捷方法：为匹配到的规则记录 violated 事件
 */
export async function recordViolatedForRules(
  matches: Array<{ ruleId: string; filePath?: string; codeSnippet?: string }>,
  userId?: string | null,
): Promise<number> {
  const events: BatchEventInput[] = matches.map(m => ({
    ruleId: m.ruleId,
    eventType: 'violated' as const,
    filePath: m.filePath ?? null,
    codeSnippet: m.codeSnippet ?? null,
    userId: userId ?? null,
  }));
  return batchRecordRuleEvents(events);
}
