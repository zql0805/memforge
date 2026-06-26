// Created by dev on 2026/05/09
// Copyright © 2026
// 将 Code Review findings 与 memory.rules 做向量匹配，
// 匹配成功后记录 violated 事件。供 store_code_review 和 store_structured_memory 共用。

import { getLogger, getPool, recordViolatedForRules } from '@memforgeai/shared';
import type { ToolContext } from '../tools/types.js';

const logger = getLogger('service:rule-matcher');

const RULE_MATCH_THRESHOLD = 0.78;
const MAX_FINDINGS_TO_MATCH = 10;

export interface FindingInput {
  category: string;
  file: string;
  line?: number;
  description: string;
}

export interface RuleMatch {
  findingDesc: string;
  findingFile: string;
  ruleId: string;
  ruleTitle: string;
  similarity: number;
}

/**
 * 将 findings 与已有 active 规则做向量匹配
 */
export async function matchFindingsAgainstRules(
  ctx: ToolContext,
  findings: FindingInput[],
): Promise<RuleMatch[]> {
  const pool = getPool();
  const toMatch = findings.slice(0, MAX_FINDINGS_TO_MATCH);

  const matchTasks = toMatch.map(async (f) => {
    const queryText = `${f.category}: ${f.description}`;
    const embedding = await ctx.embedding.embedQuery(queryText);
    const vectorStr = `[${embedding.join(',')}]`;

    const { rows } = await pool.query<{ id: string; title: string; similarity: number }>(
      `SELECT id, title, 1 - (embedding <=> $1::vector) AS similarity
       FROM memory.rules
       WHERE status = 'active' AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
      [vectorStr],
    );

    if (rows.length > 0 && rows[0].similarity >= RULE_MATCH_THRESHOLD) {
      return {
        findingDesc: f.description.slice(0, 100),
        findingFile: f.file,
        ruleId: rows[0].id,
        ruleTitle: rows[0].title,
        similarity: Math.round(rows[0].similarity * 100) / 100,
      };
    }
    return null;
  });

  const settled = await Promise.allSettled(matchTasks);
  const results = settled
    .filter((r): r is PromiseFulfilledResult<NonNullable<Awaited<typeof matchTasks[0]>>> =>
      r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);

  if (results.length > 0) {
    logger.info({ matched: results.length, total: toMatch.length }, 'findings 匹配到已有规则');
  }

  return results;
}

/**
 * 匹配 findings 并自动记录 violated 事件。
 * 调用方只需传入 findings 列表，此函数完成匹配 + 事件记录。
 */
export async function matchAndRecordViolations(
  ctx: ToolContext,
  findings: FindingInput[],
): Promise<RuleMatch[]> {
  let matchedRules: RuleMatch[] = [];
  try {
    matchedRules = await matchFindingsAgainstRules(ctx, findings);
  } catch (err) {
    logger.warn({ err: String(err) }, '规则库对比失败（不影响存储结果）');
    return [];
  }

  if (matchedRules.length > 0) {
    const violationEntries = matchedRules.map(m => ({
      ruleId: m.ruleId,
      filePath: m.findingFile,
    }));
    recordViolatedForRules(violationEntries, ctx.userId).catch(err => {
      logger.warn({ err: String(err) }, '记录规则 violated 事件失败（不影响存储结果）');
    });
  }

  return matchedRules;
}
