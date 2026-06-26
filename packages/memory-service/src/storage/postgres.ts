// Created by dev on 2026/04/04
// Copyright © 2026
// PostgreSQL 存储层 — memory-service（pgvector + FTS）

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { getLogger, getPool, queryWithRLS, getRLSContext, buildVisibilityClause } from '@memforgeai/shared';
import type { MemoryEntry, MemoryScope, MemorySource, MemoryVisibility, VisibilityFilterParams } from '@memforgeai/shared';

const logger = getLogger('postgres-storage');

export class PostgresStorage {
  private pool: pg.Pool;

  constructor() {
    this.pool = getPool();
  }

  /**
   * RLS 感知的查询方法：有 RLS 上下文时自动设置 session 变量。
   * 替代直接的 this.q()，所有业务查询应使用此方法。
   */
  private async q<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>> {
    if (getRLSContext()) {
      return queryWithRLS<T>(text, params);
    }
    return this.pool.query<T>(text, params);
  }

  async initialize(): Promise<void> {
    logger.info('PostgreSQL 存储层已就绪（DDL 由 init.sql 管理）');
  }

  async validateEmbeddingDimensions(dimensions: number): Promise<void> {
    const { rows } = await this.q<{ value: string }>(
      "SELECT value FROM memory.embedding_meta WHERE key = 'embedding_dimensions'",
    );

    if (rows.length > 0) {
      const stored = parseInt(rows[0].value, 10);
      if (stored !== dimensions) {
        throw new Error(
          `Embedding 维度不匹配！数据库中存储的是 ${stored} 维，当前模型是 ${dimensions} 维。` +
          `\n切换模型层级需要执行数据库迁移。`,
        );
      }
    } else {
      await this.q(
        `INSERT INTO memory.embedding_meta (key, value, updated_at) VALUES ('embedding_dimensions', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [String(dimensions)],
      );
    }
  }

  async getEmbeddingMeta(key: string): Promise<string | null> {
    const { rows } = await this.q<{ value: string }>(
      'SELECT value FROM memory.embedding_meta WHERE key = $1',
      [key],
    );
    return rows[0]?.value ?? null;
  }

  async setEmbeddingMeta(key: string, value: string): Promise<void> {
    await this.q(
      `INSERT INTO memory.embedding_meta (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value],
    );
  }

  async store(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'isVerified' | 'orgId' | 'teamId' | 'visibility'> & { isVerified?: boolean; orgId?: string | null; teamId?: string | null; visibility?: MemoryVisibility }): Promise<MemoryEntry> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const embeddingLiteral = entry.embedding ? pgvectorLiteral(entry.embedding) : null;
    const abstract = generateAbstract(entry.title, entry.content);

    await this.q(
      `INSERT INTO memory.entries
        (id, project_id, branch_id, title, content, abstract, scope, source, tags, embedding, metadata, is_archived, archived_reason, created_by, created_at, updated_at, expires_at, org_id, team_id, visibility)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15, $16, $17, $18, $19)`,
      [
        id, entry.projectId, entry.branchId,
        entry.title, entry.content, abstract, entry.scope, entry.source,
        entry.tags, embeddingLiteral,
        JSON.stringify(entry.metadata),
        entry.isArchived, entry.archivedReason,
        entry.createdBy ?? null,
        now, entry.expiresAt,
        entry.orgId ?? null, entry.teamId ?? null, entry.visibility ?? 'personal',
      ],
    );

    return {
      ...entry,
      id,
      isVerified: entry.isVerified ?? false,
      createdAt: now,
      updatedAt: now,
      orgId: entry.orgId ?? null,
      teamId: entry.teamId ?? null,
      visibility: entry.visibility ?? 'personal',
    };
  }

  async getById(id: string): Promise<MemoryEntry | null> {
    const { rows } = await this.q(
      'SELECT * FROM memory.entries WHERE id = $1',
      [id],
    );
    return rows[0] ? rowToEntry(rows[0]) : null;
  }

  async getByIds(ids: string[]): Promise<Map<string, MemoryEntry>> {
    const result = new Map<string, MemoryEntry>();
    if (ids.length === 0) return result;
    const { rows } = await this.q(
      'SELECT * FROM memory.entries WHERE id = ANY($1)',
      [ids],
    );
    for (const row of rows) {
      const entry = rowToEntry(row);
      result.set(entry.id, entry);
    }
    return result;
  }

  async list(params: {
    projectIds?: string[];
    branchId?: string | null;
    scope?: MemoryScope;
    source?: MemorySource;
    tags?: string[];
    includeArchived?: boolean;
    sortBy?: string;
    limit?: number;
    offset?: number;
    createdBy?: string | null;
    includeLegacy?: boolean;
    /** @deprecated 请使用 visibilityFilters。仅过滤 personal，不过滤 team/product_line */
    visibilityUserId?: string | null;
    /** 完整的可见性过滤（personal + team + product_line），优先于 visibilityUserId */
    visibilityFilters?: VisibilityFilterParams;
  }): Promise<{ entries: MemoryEntry[]; total: number }> {
    const conditions: string[] = [];
    const bindings: unknown[] = [];
    let idx = 1;

    if (params.projectIds && params.projectIds.length > 0) {
      conditions.push(`project_id = ANY($${idx++})`);
      bindings.push(params.projectIds);
    }
    if (params.branchId !== undefined) {
      if (params.branchId === null) {
        conditions.push('branch_id IS NULL');
      } else {
        conditions.push(`(branch_id = $${idx++} OR branch_id IS NULL)`);
        bindings.push(params.branchId);
      }
    }
    if (params.scope) {
      conditions.push(`scope = $${idx++}`);
      bindings.push(params.scope);
    }
    if (params.source) {
      conditions.push(`source = $${idx++}`);
      bindings.push(params.source);
    }
    if (params.tags && params.tags.length > 0) {
      conditions.push(`tags @> $${idx++}`);
      bindings.push(params.tags);
    }
    if (!params.includeArchived) {
      conditions.push('is_archived = FALSE');
    }
    if (params.createdBy) {
      if (params.includeLegacy) {
        conditions.push(`(created_by = $${idx++} OR (created_by IS NULL AND (visibility IS NULL OR visibility != 'personal')))`);
      } else {
        conditions.push(`created_by = $${idx++}`);
      }
      bindings.push(params.createdBy);
    }

    // 可见性过滤：优先使用完整的 visibilityFilters，回退到旧版 visibilityUserId
    if (params.visibilityFilters) {
      const { clause, nextIdx } = buildVisibilityClause(params.visibilityFilters, bindings, idx);
      idx = nextIdx;
      conditions.push(clause);
    } else if (params.visibilityUserId) {
      // 向后兼容：仅 superAdmin 审计模式可能走到这里（visibilityUserId 通常为 null）
      conditions.push(`(visibility IS NULL OR visibility != 'personal' OR created_by = $${idx++})`);
      bindings.push(params.visibilityUserId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = params.sortBy === 'created_at' ? 'created_at DESC' : 'updated_at DESC';
    const limit = params.limit ?? 20;
    const offset = params.offset ?? 0;

    const countResult = await this.q(
      `SELECT COUNT(*)::int as cnt FROM memory.entries ${where}`,
      bindings,
    );
    const dataResult = await this.q(
      `SELECT * FROM memory.entries ${where} ORDER BY ${orderBy} LIMIT $${idx++} OFFSET $${idx++}`,
      [...bindings, limit, offset],
    );

    return {
      entries: dataResult.rows.map(rowToEntry),
      total: countResult.rows[0].cnt,
    };
  }

  /**
   * 全文搜索（PostgreSQL FTS）
   */
  async searchByText(
    query: string,
    projectIds?: string[],
    branchId?: string | null,
    limit = 10,
    visibilityFilters?: VisibilityFilterParams,
    contentFilters?: {
      tagsFilter?: string[];
      scopeFilter?: string[];
    },
  ): Promise<MemoryEntry[]> {
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(query);

    const conditions: string[] = [
      'is_archived = FALSE',
      "(metadata->>'migrated_to_knowledge' IS NULL OR metadata->>'migrated_to_knowledge' != 'true')",
    ];
    const bindings: unknown[] = [query];
    let idx = 2;

    if (hasCJK) {
      // CJK 查询用 ILIKE（pg_trgm GIN 索引加速），FTS english 对中文无效
      conditions.push(`(title ILIKE $1 OR content ILIKE $1)`);
      bindings[0] = `%${query}%`;
    } else {
      conditions.push(
        `to_tsvector('simple', title || ' ' || content) @@ plainto_tsquery('simple', $1)`,
      );
    }

    if (visibilityFilters?.orgId) {
      conditions.push(`(org_id = $${idx++} OR org_id IS NULL)`);
      bindings.push(visibilityFilters.orgId);
    }

    if (visibilityFilters?.orgId || visibilityFilters?.userId || visibilityFilters?.teamIds) {
      const { clause, nextIdx } = buildVisibilityClause(visibilityFilters, bindings, idx);
      idx = nextIdx;
      conditions.push(clause);
    }

    if (projectIds && projectIds.length > 0) {
      conditions.push(`project_id = ANY($${idx++})`);
      bindings.push(projectIds);
    }
    if (branchId !== undefined && branchId !== null) {
      conditions.push(`(branch_id = $${idx++} OR branch_id IS NULL)`);
      bindings.push(branchId);
    }
    if (contentFilters?.tagsFilter && contentFilters.tagsFilter.length > 0) {
      conditions.push(`tags @> $${idx++}`);
      bindings.push(contentFilters.tagsFilter);
    }
    if (contentFilters?.scopeFilter && contentFilters.scopeFilter.length > 0) {
      conditions.push(`scope = ANY($${idx++})`);
      bindings.push(contentFilters.scopeFilter);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const { rows } = await this.q(
      `SELECT * FROM memory.entries ${where} ORDER BY updated_at DESC LIMIT $${idx++}`,
      [...bindings, limit],
    );

    return rows.map(rowToEntry);
  }

  /**
   * pg_trgm 关键词搜索 — 支持中英文子串匹配和相关性排序。
   * 返回格式与 searchByEmbedding 一致，便于 RRF 融合。
   */
  async searchByKeyword(
    query: string,
    projectIds?: string[],
    branchId?: string | null,
    limit = 10,
    filters?: {
      tagsFilter?: string[];
      scopeFilter?: string[];
    } & VisibilityFilterParams,
  ): Promise<Array<{ id: string; similarity: number }>> {
    const conditions: string[] = [
      'is_archived = FALSE',
      "(metadata->>'migrated_to_knowledge' IS NULL OR metadata->>'migrated_to_knowledge' != 'true')",
    ];
    const bindings: unknown[] = [query];
    let idx = 2;

    // ILIKE 子串匹配（pg_trgm GIN 索引加速）
    conditions.push(`(title ILIKE $1 OR content ILIKE $1)`);
    bindings[0] = `%${query}%`;

    if (filters?.orgId) {
      conditions.push(`(org_id = $${idx++} OR org_id IS NULL)`);
      bindings.push(filters.orgId);
    }
    if (filters?.orgId || filters?.userId || filters?.teamIds) {
      const { clause, nextIdx } = buildVisibilityClause(filters, bindings, idx);
      idx = nextIdx;
      conditions.push(clause);
    }
    if (projectIds && projectIds.length > 0) {
      conditions.push(`project_id = ANY($${idx++})`);
      bindings.push(projectIds);
    }
    if (branchId !== undefined && branchId !== null) {
      conditions.push(`(branch_id = $${idx++} OR branch_id IS NULL)`);
      bindings.push(branchId);
    }
    if (filters?.tagsFilter && filters.tagsFilter.length > 0) {
      conditions.push(`tags @> $${idx++}`);
      bindings.push(filters.tagsFilter);
    }
    if (filters?.scopeFilter && filters.scopeFilter.length > 0) {
      conditions.push(`scope = ANY($${idx++})`);
      bindings.push(filters.scopeFilter);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    // word_similarity: 查询词在目标文本中的最佳局部匹配度（0~1）
    const { rows } = await this.q<{ id: string; similarity: number }>(
      `SELECT id,
              GREATEST(
                word_similarity($1, title),
                word_similarity($1, content)
              ) AS similarity
       FROM memory.entries ${where}
       ORDER BY similarity DESC
       LIMIT $${idx++}`,
      [...bindings, limit],
    );

    return rows.map(r => ({ id: r.id, similarity: Number(r.similarity) }));
  }

  /**
   * pgvector 语义搜索 — 替代旧的 getAllEmbeddings + JS 余弦计算
   */
  async searchByEmbedding(
    queryEmbedding: number[],
    projectIds?: string[],
    branchId?: string | null,
    limit = 10,
    minSimilarity = 0.5,
    filters?: {
      tagsFilter?: string[];
      scopeFilter?: string[];
      orgId?: string | null;
      userId?: string | null;
      teamIds?: string[];
      accessibleProductLines?: string[];
    },
  ): Promise<Array<{ id: string; similarity: number }>> {
    const conditions: string[] = [
      'is_archived = FALSE',
      'embedding IS NOT NULL',
      "(metadata->>'migrated_to_knowledge' IS NULL OR metadata->>'migrated_to_knowledge' != 'true')",
    ];
    const bindings: unknown[] = [];
    let idx = 1;

    // 标量过滤先于向量距离计算，便于 pgvector 索引预过滤
    if (filters?.orgId) {
      conditions.push(`(org_id = $${idx++} OR org_id IS NULL)`);
      bindings.push(filters.orgId);
    }

    if (filters?.orgId || filters?.userId || filters?.teamIds) {
      const { clause, nextIdx } = buildVisibilityClause(filters, bindings, idx);
      idx = nextIdx;
      conditions.push(clause);
    }

    if (projectIds && projectIds.length > 0) {
      conditions.push(`project_id = ANY($${idx++})`);
      bindings.push(projectIds);
    }
    if (branchId !== undefined && branchId !== null) {
      conditions.push(`(branch_id = $${idx++} OR branch_id IS NULL)`);
      bindings.push(branchId);
    }
    if (filters?.tagsFilter && filters.tagsFilter.length > 0) {
      conditions.push(`tags @> $${idx++}`);
      bindings.push(filters.tagsFilter);
    }
    if (filters?.scopeFilter && filters.scopeFilter.length > 0) {
      conditions.push(`scope = ANY($${idx++})`);
      bindings.push(filters.scopeFilter);
    }

    const embLiteral = pgvectorLiteral(queryEmbedding);
    const embParamIdx = idx++;
    const minSimParamIdx = idx++;
    conditions.push(`(1 - (embedding <=> $${embParamIdx})) >= $${minSimParamIdx}`);
    bindings.push(embLiteral, minSimilarity);

    const where = `WHERE ${conditions.join(' AND ')}`;
    const { rows } = await this.q<{ id: string; similarity: number }>(
      `SELECT id, (1 - (embedding <=> $${embParamIdx})) as similarity
       FROM memory.entries ${where}
       ORDER BY embedding <=> $${embParamIdx} ASC
       LIMIT $${idx++}`,
      [...bindings, limit],
    );

    return rows.map(r => ({ id: r.id, similarity: Number(r.similarity) }));
  }

  async update(id: string, fields: Partial<Pick<MemoryEntry, 'title' | 'content' | 'tags' | 'metadata' | 'embedding' | 'projectId' | 'visibility' | 'teamId'>>): Promise<MemoryEntry | null> {
    const sets: string[] = [];
    const bindings: unknown[] = [];
    let idx = 1;

    if (fields.projectId !== undefined) { sets.push(`project_id = $${idx++}`); bindings.push(fields.projectId); }
    if (fields.title !== undefined) { sets.push(`title = $${idx++}`); bindings.push(fields.title); }
    if (fields.content !== undefined) { sets.push(`content = $${idx++}`); bindings.push(fields.content); }
    if (fields.tags !== undefined) { sets.push(`tags = $${idx++}`); bindings.push(fields.tags); }
    if (fields.metadata !== undefined) { sets.push(`metadata = $${idx++}`); bindings.push(JSON.stringify(fields.metadata)); }
    if (fields.embedding !== undefined) {
      sets.push(`embedding = $${idx++}`);
      bindings.push(fields.embedding === null ? null : pgvectorLiteral(fields.embedding));
    }
    if (fields.visibility !== undefined) { sets.push(`visibility = $${idx++}`); bindings.push(fields.visibility); }
    if (fields.teamId !== undefined) { sets.push(`team_id = $${idx++}`); bindings.push(fields.teamId); }

    if (sets.length === 0) return this.getById(id);

    sets.push('updated_at = NOW()');
    bindings.push(id);
    await this.q(
      `UPDATE memory.entries SET ${sets.join(', ')} WHERE id = $${idx}`,
      bindings,
    );
    return this.getById(id);
  }

  async archive(id: string, reason: string): Promise<boolean> {
    const result = await this.q(
      `UPDATE memory.entries SET is_archived = TRUE, archived_reason = $1, updated_at = NOW() WHERE id = $2`,
      [reason, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async archiveByTag(tag: string, reason: string): Promise<number> {
    const result = await this.q(
      `UPDATE memory.entries SET is_archived = TRUE, archived_reason = $1, updated_at = NOW()
       WHERE is_archived = FALSE AND $2 = ANY(tags)`,
      [reason, tag],
    );
    return result.rowCount ?? 0;
  }

  async deleteByTitle(title: string, projectId: string): Promise<number> {
    const result = await this.q(
      `DELETE FROM memory.entries WHERE title = $1 AND project_id = $2`,
      [title, projectId],
    );
    return result.rowCount ?? 0;
  }

  /** 查询 memory.entries 和 memory.rules 中实际存在的 project_id 列表，排除系统保留值 */
  async getDistinctProjectIds(): Promise<string[]> {
    const excluded = ['_global_', 'default'];
    const { rows } = await this.q<{ project_id: string }>(
      `SELECT DISTINCT project_id FROM (
         SELECT project_id FROM memory.entries WHERE is_archived = FALSE
         UNION
         SELECT project_id FROM memory.rules WHERE status = 'active'
       ) t
       WHERE project_id != ALL($1)
       ORDER BY project_id`,
      [excluded],
    );
    return rows.map(r => r.project_id);
  }

  async checkDuplicate(embedding: number[], threshold: number): Promise<MemoryEntry | null> {
    const embLiteral = pgvectorLiteral(embedding);
    const { rows } = await this.q<{ id: string; similarity: number }>(
      `SELECT id, (1 - (embedding <=> $1)) as similarity
       FROM memory.entries
       WHERE is_archived = FALSE AND embedding IS NOT NULL AND (1 - (embedding <=> $1)) >= $2
       ORDER BY embedding <=> $1 ASC
       LIMIT 1`,
      [embLiteral, threshold],
    );

    if (rows.length === 0) return null;
    return this.getById(rows[0].id);
  }
}

/** 将 number[] 转为 pgvector 的字符串格式 '[1,2,3]' */
function pgvectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    branchId: (row.branch_id as string) ?? null,
    title: row.title as string,
    content: row.content as string,
    scope: row.scope as MemoryScope,
    source: row.source as MemorySource,
    tags: (row.tags as string[]) ?? [],
    embedding: row.embedding ? parseVector(row.embedding as string) : null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    isArchived: row.is_archived as boolean,
    archivedReason: (row.archived_reason as string) ?? null,
    createdBy: (row.created_by as string) ?? null,
    isVerified: (row.is_verified as boolean) ?? false,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    expiresAt: row.expires_at ? (row.expires_at as Date).toISOString() : null,
    orgId: (row.org_id as string) ?? null,
    teamId: (row.team_id as string) ?? null,
    abstract: (row.abstract as string) ?? null,
    visibility: (row.visibility as MemoryVisibility) ?? 'personal',
  };
}

/** 解析 pgvector 返回的字符串 '[0.1,0.2,...]' → number[] */
function parseVector(v: string): number[] {
  if (typeof v !== 'string') return [];
  const inner = v.replace(/^\[/, '').replace(/\]$/, '');
  return inner.split(',').map(Number);
}

/** 零成本截断法生成摘要：取首个有意义的句子，不超过 200 字 */
export function generateAbstract(title: string, content: string): string {
  const firstSentence = content.split(/[。.!！?\n]/).filter(s => s.trim().length > 10)[0];
  if (firstSentence && firstSentence.length <= 200) {
    return firstSentence.trim();
  }
  return content.substring(0, 150).trim() + '...';
}
