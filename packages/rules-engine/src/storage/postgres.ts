// Created by dev on 2026/04/04
// Copyright © 2026
// PostgreSQL 存储层 — rules-engine（pgvector）

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { getLogger, getPool, queryWithRLS, getRLSContext } from '@memforgeai/shared';
import type {
  Rule, RuleVote, RuleEvent,
  RuleStatus, RuleSeverity, RuleCategory, RuleType, RuleEventType,
  MemorySource, VoterRole,
} from '@memforgeai/shared';

const logger = getLogger('rules-postgres');

export class RulesPostgresStorage {
  private pool: pg.Pool;

  constructor() {
    this.pool = getPool();
  }

  private async q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
    if (getRLSContext()) return queryWithRLS<T>(text, params);
    return this.pool.query<T>(text, params);
  }

  async initialize(): Promise<void> {
    logger.info('Rules PostgreSQL 存储层已就绪（DDL 由 init.sql 管理）');
  }

  // ─── 规则 CRUD ─────────────────────────────────────────────

  async storeRule(rule: Omit<Rule, 'id' | 'createdAt' | 'updatedAt' | 'appliedCount' | 'violatedCount' | 'acceptedCount' | 'rejectedCount' | 'activatedAt' | 'deprecatedAt'>): Promise<Rule> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const embeddingLiteral = rule.embedding ? pgvectorLiteral(rule.embedding) : null;

    await this.q(
      `INSERT INTO memory.rules
        (id, project_id, rule_type, title, description, rationale, example_good, example_bad,
         auto_fix, category, language, severity, status, source, source_ref,
         embedding, created_by, team_id, visibility, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)`,
      [
        id, rule.projectId, rule.ruleType, rule.title, rule.description, rule.rationale,
        rule.exampleGood, rule.exampleBad, rule.autoFix,
        rule.category, rule.language, rule.severity, rule.status,
        rule.source, rule.sourceRef ? JSON.stringify(rule.sourceRef) : null,
        embeddingLiteral, rule.createdBy, rule.teamId ?? null, rule.visibility ?? 'personal', now,
      ],
    );

    return {
      ...rule,
      id,
      appliedCount: 0, violatedCount: 0, acceptedCount: 0, rejectedCount: 0,
      activatedAt: null, deprecatedAt: null,
      createdAt: now, updatedAt: now,
    };
  }

  async getRuleById(id: string): Promise<Rule | null> {
    const { rows } = await this.q(
      'SELECT * FROM memory.rules WHERE id = $1',
      [id],
    );
    return rows[0] ? rowToRule(rows[0]) : null;
  }

  async getRulesByIds(ids: string[]): Promise<Rule[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.q(
      'SELECT * FROM memory.rules WHERE id = ANY($1)',
      [ids],
    );
    return rows.map(rowToRule);
  }

  async listRules(params: {
    projectIds?: string[];
    status?: RuleStatus;
    category?: RuleCategory;
    ruleTypes?: RuleType[];
    language?: string;
    severity?: RuleSeverity;
    search?: string;
    sortBy?: string;
    limit?: number;
    offset?: number;
    teamFilter?: { teamIds?: string[]; userId?: string };
  }): Promise<{ rules: Rule[]; total: number }> {
    const conditions: string[] = [];
    const bindings: unknown[] = [];
    let idx = 1;

    // 统一访问控制：projectIds + teamFilter 合并为一个条件
    // global 规则不受 project_id 限制；其余 visibility 受 project_id 过滤
    if (params.projectIds && params.projectIds.length > 0 && params.teamFilter) {
      const projectIdx = idx++;
      bindings.push(params.projectIds);
      const accessClauses: string[] = [
        "visibility = 'global'",
        `(visibility = 'product_line' AND project_id = ANY($${projectIdx}))`,
      ];
      if (params.teamFilter.teamIds && params.teamFilter.teamIds.length > 0) {
        accessClauses.push(`(visibility = 'team' AND team_id = ANY($${idx++}))`);
        bindings.push(params.teamFilter.teamIds);
      }
      if (params.teamFilter.userId) {
        accessClauses.push(`(visibility = 'personal' AND created_by = $${idx++})`);
        bindings.push(params.teamFilter.userId);
      }
      conditions.push(`(${accessClauses.join(' OR ')})`);
    } else {
      if (params.projectIds && params.projectIds.length > 0) { conditions.push(`project_id = ANY($${idx++})`); bindings.push(params.projectIds); }
      if (params.teamFilter) {
        const visClauses: string[] = ["visibility = 'global'", "visibility = 'product_line'"];
        if (params.teamFilter.teamIds && params.teamFilter.teamIds.length > 0) {
          visClauses.push(`(visibility = 'team' AND team_id = ANY($${idx++}))`);
          bindings.push(params.teamFilter.teamIds);
        }
        if (params.teamFilter.userId) {
          visClauses.push(`(visibility = 'personal' AND created_by = $${idx++})`);
          bindings.push(params.teamFilter.userId);
        }
        conditions.push(`(${visClauses.join(' OR ')})`);
      }
    }

    if (params.status) { conditions.push(`status = $${idx++}`); bindings.push(params.status); }
    if (params.category) { conditions.push(`category = $${idx++}`); bindings.push(params.category); }
    if (params.ruleTypes && params.ruleTypes.length > 0) { conditions.push(`rule_type = ANY($${idx++})`); bindings.push(params.ruleTypes); }
    if (params.language) { conditions.push(`(language = $${idx++} OR language IS NULL)`); bindings.push(params.language); }
    if (params.severity) { conditions.push(`severity = $${idx++}`); bindings.push(params.severity); }
    if (params.search) {
      const pattern = `%${params.search}%`;
      conditions.push(`(title ILIKE $${idx} OR description ILIKE $${idx})`);
      bindings.push(pattern);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = params.sortBy === 'created_at' ? 'created_at DESC' : 'updated_at DESC';
    const limit = params.limit ?? 20;
    const offset = params.offset ?? 0;

    const countResult = await this.q(
      `SELECT COUNT(*)::int as cnt FROM memory.rules ${where}`, bindings,
    );
    const dataResult = await this.q(
      `SELECT * FROM memory.rules ${where} ORDER BY ${orderBy} LIMIT $${idx++} OFFSET $${idx++}`,
      [...bindings, limit, offset],
    );

    return { rules: dataResult.rows.map(rowToRule), total: countResult.rows[0].cnt };
  }

  async getActiveRules(projectIds?: string[], language?: string, teamFilter?: { teamIds?: string[]; userId?: string }): Promise<Rule[]> {
    const conditions: string[] = ["status = 'active'"];
    const bindings: unknown[] = [];
    let idx = 1;

    if (projectIds && projectIds.length > 0) {
      conditions.push(`project_id = ANY($${idx++})`);
      bindings.push(projectIds);
    }
    if (language) {
      conditions.push(`(language = $${idx++} OR language IS NULL)`);
      bindings.push(language);
    }

    if (teamFilter) {
      const visClauses: string[] = ["visibility = 'global'", "visibility = 'product_line'"];
      if (teamFilter.teamIds && teamFilter.teamIds.length > 0) {
        visClauses.push(`(visibility = 'team' AND team_id = ANY($${idx++}))`);
        bindings.push(teamFilter.teamIds);
      }
      if (teamFilter.userId) {
        visClauses.push(`(visibility = 'personal' AND created_by = $${idx++})`);
        bindings.push(teamFilter.userId);
      }
      conditions.push(`(${visClauses.join(' OR ')})`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const { rows } = await this.q(
      `SELECT * FROM memory.rules ${where} ORDER BY severity ASC, category`,
      bindings,
    );
    return rows.map(rowToRule);
  }

  async updateRule(id: string, fields: Partial<Pick<Rule, 'title' | 'description' | 'rationale' | 'exampleGood' | 'exampleBad' | 'autoFix' | 'category' | 'language' | 'severity' | 'embedding' | 'ruleType'>>): Promise<Rule | null> {
    const sets: string[] = [];
    const bindings: unknown[] = [];
    let idx = 1;

    if (fields.title !== undefined) { sets.push(`title = $${idx++}`); bindings.push(fields.title); }
    if (fields.description !== undefined) { sets.push(`description = $${idx++}`); bindings.push(fields.description); }
    if (fields.rationale !== undefined) { sets.push(`rationale = $${idx++}`); bindings.push(fields.rationale); }
    if (fields.exampleGood !== undefined) { sets.push(`example_good = $${idx++}`); bindings.push(fields.exampleGood); }
    if (fields.exampleBad !== undefined) { sets.push(`example_bad = $${idx++}`); bindings.push(fields.exampleBad); }
    if (fields.autoFix !== undefined) { sets.push(`auto_fix = $${idx++}`); bindings.push(fields.autoFix); }
    if (fields.category !== undefined) { sets.push(`category = $${idx++}`); bindings.push(fields.category); }
    if (fields.language !== undefined) { sets.push(`language = $${idx++}`); bindings.push(fields.language); }
    if (fields.severity !== undefined) { sets.push(`severity = $${idx++}`); bindings.push(fields.severity); }
    if (fields.ruleType !== undefined) { sets.push(`rule_type = $${idx++}`); bindings.push(fields.ruleType); }
    if (fields.embedding !== undefined) {
      sets.push(`embedding = $${idx++}`);
      bindings.push(fields.embedding === null ? null : pgvectorLiteral(fields.embedding));
    }

    if (sets.length === 0) return this.getRuleById(id);

    sets.push('updated_at = NOW()');
    bindings.push(id);
    await this.q(
      `UPDATE memory.rules SET ${sets.join(', ')} WHERE id = $${idx}`,
      bindings,
    );
    return this.getRuleById(id);
  }

  async updateRuleStatus(id: string, status: RuleStatus): Promise<boolean> {
    const extra: string[] = [];
    if (status === 'active') extra.push('activated_at = NOW()');
    if (status === 'deprecated') extra.push('deprecated_at = NOW()');

    const setClauses = ['status = $1', 'updated_at = NOW()', ...extra].join(', ');
    const result = await this.q(
      `UPDATE memory.rules SET ${setClauses} WHERE id = $2`,
      [status, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteRule(id: string): Promise<boolean> {
    try {
      await this.q('BEGIN');
      await this.q('DELETE FROM memory.rule_votes WHERE rule_id = $1', [id]);
      await this.q('DELETE FROM memory.rule_events WHERE rule_id = $1', [id]);
      const result = await this.q('DELETE FROM memory.rules WHERE id = $1', [id]);
      await this.q('COMMIT');
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      await this.q('ROLLBACK').catch((err) => {
        logger.warn({ err }, 'deleteRule 事务回滚失败');
      });
      throw error;
    }
  }

  private static readonly COUNTER_FIELDS = new Set([
    'applied_count', 'violated_count', 'accepted_count', 'rejected_count',
  ]);

  async incrementRuleCounter(ruleId: string, field: 'applied_count' | 'violated_count' | 'accepted_count' | 'rejected_count'): Promise<void> {
    if (!RulesPostgresStorage.COUNTER_FIELDS.has(field)) {
      throw new Error(`不允许的计数器字段: ${field}`);
    }
    await this.q(
      `UPDATE memory.rules SET ${field} = ${field} + 1, updated_at = NOW() WHERE id = $1`,
      [ruleId],
    );
  }

  /**
   * pgvector 语义搜索规则 embedding
   */
  async searchRuleEmbeddings(
    queryEmbedding: number[],
    minSimilarity: number,
    status?: RuleStatus,
  ): Promise<Array<{ id: string; similarity: number }>> {
    const embLiteral = pgvectorLiteral(queryEmbedding);
    const conditions: string[] = [
      'embedding IS NOT NULL',
      `(1 - (embedding <=> $1)) >= $2`,
    ];
    const bindings: unknown[] = [embLiteral, minSimilarity];
    let idx = 3;

    if (status) {
      conditions.push(`status = $${idx++}`);
      bindings.push(status);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const { rows } = await this.q<{ id: string; similarity: number }>(
      `SELECT id, (1 - (embedding <=> $1)) as similarity
       FROM memory.rules ${where}
       ORDER BY embedding <=> $1 ASC
       LIMIT 50`,
      bindings,
    );

    return rows.map(r => ({ id: r.id, similarity: Number(r.similarity) }));
  }

  /**
   * 兼容旧接口：获取全部规则 embedding（仅在无法使用 pgvector 搜索时使用）
   */
  async getAllRuleEmbeddings(status?: RuleStatus): Promise<Array<{ id: string; embedding: number[] }>> {
    const condition = status
      ? 'WHERE status = $1 AND embedding IS NOT NULL'
      : 'WHERE embedding IS NOT NULL';
    const bindings: unknown[] = status ? [status] : [];
    const { rows } = await this.q<{ id: string; embedding: string }>(
      `SELECT id, embedding::text FROM memory.rules ${condition}`,
      bindings,
    );

    return rows.map(r => ({
      id: r.id,
      embedding: parseVector(r.embedding),
    }));
  }

  // ─── 投票 ──────────────────────────────────────────────────

  async castVote(vote: Omit<RuleVote, 'id' | 'createdAt'>): Promise<RuleVote> {
    const id = randomUUID();
    const now = new Date().toISOString();

    await this.q(
      `INSERT INTO memory.rule_votes (id, rule_id, user_id, role, vote, comment, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(rule_id, user_id) DO UPDATE SET
         vote = EXCLUDED.vote,
         role = EXCLUDED.role,
         comment = EXCLUDED.comment,
         created_at = EXCLUDED.created_at`,
      [id, vote.ruleId, vote.userId, vote.role, vote.vote, vote.comment, now],
    );

    return { ...vote, id, createdAt: now };
  }

  async getVotesForRule(ruleId: string): Promise<RuleVote[]> {
    const { rows } = await this.q(
      'SELECT * FROM memory.rule_votes WHERE rule_id = $1 ORDER BY created_at',
      [ruleId],
    );
    return rows.map(rowToVote);
  }

  async getVoteCount(ruleId: string): Promise<{ total: number; approve: number; reject: number; abstain: number }> {
    const { rows } = await this.q<{ vote: number; cnt: number }>(
      'SELECT vote, COUNT(*)::int as cnt FROM memory.rule_votes WHERE rule_id = $1 GROUP BY vote',
      [ruleId],
    );
    const result = { total: 0, approve: 0, reject: 0, abstain: 0 };
    for (const r of rows) {
      result.total += r.cnt;
      if (r.vote === 1) result.approve = r.cnt;
      else if (r.vote === -1) result.reject = r.cnt;
      else result.abstain = r.cnt;
    }
    return result;
  }

  // ─── 事件 ──────────────────────────────────────────────────

  async recordEvent(event: Omit<RuleEvent, 'id' | 'createdAt'>): Promise<RuleEvent> {
    const [recorded] = await this.recordEvents([event]);
    return recorded;
  }

  async recordEvents(events: Array<Omit<RuleEvent, 'id' | 'createdAt'>>): Promise<RuleEvent[]> {
    if (events.length === 0) return [];

    const now = new Date().toISOString();
    const recorded: RuleEvent[] = events.map(event => ({
      ...event,
      id: randomUUID(),
      createdAt: now,
    }));

    const counterIncrements = new Map<string, Map<'applied_count' | 'violated_count' | 'accepted_count' | 'rejected_count', number>>();

    for (const event of events) {
      const counterField = resolveEventCounterField(event.eventType);
      if (!counterField) continue;
      const byRule = counterIncrements.get(event.ruleId) ?? new Map();
      byRule.set(counterField, (byRule.get(counterField) ?? 0) + 1);
      counterIncrements.set(event.ruleId, byRule);
    }

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;
    for (const event of recorded) {
      placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      values.push(
        event.id,
        event.ruleId,
        event.eventType,
        event.filePath,
        event.codeSnippet,
        event.userId,
        JSON.stringify(event.metadata),
        now,
      );
    }

    try {
      await this.q('BEGIN');
      await this.q(
        `INSERT INTO memory.rule_events (id, rule_id, event_type, file_path, code_snippet, user_id, metadata, created_at)
         VALUES ${placeholders.join(', ')}`,
        values,
      );
      for (const [ruleId, counters] of counterIncrements) {
        for (const [counterField, increment] of counters) {
          await this.q(
            `UPDATE memory.rules SET ${counterField} = ${counterField} + $1, updated_at = NOW() WHERE id = $2`,
            [increment, ruleId],
          );
        }
      }
      await this.q('COMMIT');
    } catch (err) {
      await this.q('ROLLBACK').catch((rollbackErr) => {
        logger.warn({ err: rollbackErr }, 'recordEvents 事务回滚失败');
      });
      throw err;
    }

    return recorded;
  }

  async getEventsByRule(ruleId: string, limit = 50): Promise<RuleEvent[]> {
    const { rows } = await this.q(
      'SELECT * FROM memory.rule_events WHERE rule_id = $1 ORDER BY created_at DESC LIMIT $2',
      [ruleId, limit],
    );
    return rows.map(rowToEvent);
  }

  async getEventCountByType(ruleId: string, eventType: RuleEventType, daysAgo?: number): Promise<number> {
    let sql = 'SELECT COUNT(*)::int as cnt FROM memory.rule_events WHERE rule_id = $1 AND event_type = $2';
    const bindings: unknown[] = [ruleId, eventType];

    if (daysAgo !== undefined) {
      sql += ` AND created_at >= NOW() - INTERVAL '${daysAgo} days'`;
    }

    const { rows } = await this.q<{ cnt: number }>(sql, bindings);
    return rows[0].cnt;
  }

  async getGlobalEventCounts(daysAgo?: number): Promise<Record<RuleEventType, number>> {
    let timeFilter = '';
    if (daysAgo !== undefined) {
      timeFilter = `WHERE created_at >= NOW() - INTERVAL '${daysAgo} days'`;
    }

    const { rows } = await this.q<{ event_type: string; cnt: number }>(
      `SELECT event_type, COUNT(*)::int as cnt FROM memory.rule_events ${timeFilter} GROUP BY event_type`,
    );

    const result: Record<string, number> = { applied: 0, violated: 0, accepted: 0, rejected: 0, auto_fixed: 0 };
    for (const r of rows) {
      result[r.event_type] = r.cnt;
    }
    return result as Record<RuleEventType, number>;
  }

  async getTimedOutVotingRules(timeoutDays: number): Promise<Rule[]> {
    const { rows } = await this.q(
      `SELECT * FROM memory.rules
       WHERE status = 'voting' AND updated_at <= NOW() - INTERVAL '${timeoutDays} days'`,
    );
    return rows.map(rowToRule);
  }

  async getUserAccessibleProductLines(teamId: string): Promise<string[]> {
    const { rows } = await this.q<{ product_line: string }>(
      `SELECT product_line FROM memory.team_product_lines WHERE team_id = $1`,
      [teamId],
    );
    return rows.map(r => r.product_line);
  }

  async getCategoryLanguageCombinations(): Promise<{ active: number; total: number }> {
    const activeResult = await this.q<{ cnt: number }>(
      `SELECT COUNT(DISTINCT category || '|' || COALESCE(language, '*'))::int as cnt
       FROM memory.rules WHERE status = 'active'`,
    );
    const totalResult = await this.q<{ cnt: number }>(
      `SELECT COUNT(DISTINCT category || '|' || COALESCE(language, '*'))::int as cnt
       FROM memory.rules WHERE status != 'rejected'`,
    );

    return {
      active: activeResult.rows[0].cnt,
      total: Math.max(totalResult.rows[0].cnt, 1),
    };
  }
}

function pgvectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

function parseVector(v: string): number[] {
  if (typeof v !== 'string') return [];
  const inner = v.replace(/^\[/, '').replace(/\]$/, '');
  return inner.split(',').map(Number);
}

function rowToRule(row: Record<string, unknown>): Rule {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    ruleType: (row.rule_type as RuleType) ?? 'coding',
    title: row.title as string,
    description: row.description as string,
    rationale: (row.rationale as string) ?? null,
    exampleGood: (row.example_good as string) ?? null,
    exampleBad: (row.example_bad as string) ?? null,
    autoFix: (row.auto_fix as string) ?? null,
    category: row.category as RuleCategory,
    language: (row.language as string) ?? null,
    severity: row.severity as RuleSeverity,
    status: row.status as RuleStatus,
    source: row.source as MemorySource,
    sourceRef: (row.source_ref as Record<string, unknown>) ?? null,
    embedding: row.embedding ? parseVector(String(row.embedding)) : null,
    appliedCount: row.applied_count as number,
    violatedCount: row.violated_count as number,
    acceptedCount: row.accepted_count as number,
    rejectedCount: row.rejected_count as number,
    activatedAt: row.activated_at ? (row.activated_at as Date).toISOString() : null,
    deprecatedAt: row.deprecated_at ? (row.deprecated_at as Date).toISOString() : null,
    createdBy: (row.created_by as string) ?? null,
    teamId: (row.team_id as string) ?? null,
    visibility: (row.visibility as Rule['visibility']) ?? 'global',
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function rowToVote(row: Record<string, unknown>): RuleVote {
  return {
    id: row.id as string,
    ruleId: row.rule_id as string,
    userId: row.user_id as string,
    role: row.role as VoterRole,
    vote: row.vote as -1 | 0 | 1,
    comment: (row.comment as string) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function rowToEvent(row: Record<string, unknown>): RuleEvent {
  return {
    id: row.id as string,
    ruleId: row.rule_id as string,
    eventType: row.event_type as RuleEventType,
    filePath: (row.file_path as string) ?? null,
    codeSnippet: (row.code_snippet as string) ?? null,
    userId: (row.user_id as string) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function resolveEventCounterField(
  eventType: RuleEventType,
): 'applied_count' | 'violated_count' | 'accepted_count' | 'rejected_count' | null {
  if (!['applied', 'violated', 'accepted', 'rejected', 'auto_fixed'].includes(eventType)) {
    return null;
  }
  const field = eventType === 'auto_fixed' ? 'applied' : eventType;
  return `${field}_count` as 'applied_count' | 'violated_count' | 'accepted_count' | 'rejected_count';
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
