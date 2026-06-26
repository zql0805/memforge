// Created by dev on 2026/05/21
import { getPool, getLogger, buildVisibilityClause } from '@memforgeai/shared';
import type { KnowledgeItem, KnowledgeMedia, KnowledgeCategory, VisibilityFilterParams } from '@memforgeai/shared';
import type pg from 'pg';

const logger = getLogger('knowledge:storage');

const ALLOWED_UPDATE_COLUMNS = new Set([
  'title', 'summary', 'content', 'question', 'category', 'knowledge_type',
  'metadata', 'tags', 'answer_type', 'embedding', 'media_text', 'media',
  'status', 'verified_by', 'verified_at', 'visibility', 'slug',
  'product_line', 'team_id', 'org_id',
]);

function pgvectorLiteral(vec: number[]): string {
  return '[' + vec.join(',') + ']';
}

function rowToKnowledgeItem(row: Record<string, unknown>): KnowledgeItem {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    productLine: (row.product_line as string) ?? null,
    knowledgeType: row.knowledge_type as KnowledgeItem['knowledgeType'],
    category: (row.category as string) ?? null,
    title: row.title as string,
    summary: (row.summary as string) ?? null,
    content: row.content as string,
    question: (row.question as string) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    tags: (row.tags as string[]) ?? [],
    answerType: (row.answer_type as KnowledgeItem['answerType']) ?? 'direct',
    embedding: null,
    mediaText: (row.media_text as string) ?? '',
    status: row.status as KnowledgeItem['status'],
    version: (row.version as number) ?? 1,
    verifiedBy: (row.verified_by as string) ?? null,
    verifiedAt: row.verified_at ? new Date(row.verified_at as string) : null,
    helpfulCount: (row.helpful_count as number) ?? 0,
    unhelpfulCount: (row.unhelpful_count as number) ?? 0,
    queryCount: (row.query_count as number) ?? 0,
    media: (row.media as KnowledgeMedia[]) ?? [],
    sourceType: (row.source_type as KnowledgeItem['sourceType']) ?? null,
    sourceRef: (row.source_ref as string) ?? null,
    visibility: (row.visibility as KnowledgeItem['visibility']) ?? 'product_line',
    teamId: (row.team_id as string) ?? null,
    orgId: (row.org_id as string) ?? null,
    slug: (row.slug as string) ?? null,
    createdBy: (row.created_by as string) ?? null,
    updatedBy: (row.updated_by as string) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function rowToKnowledgeCategory(row: Record<string, unknown>): KnowledgeCategory {
  return {
    id: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    parentId: (row.parent_id as string) ?? null,
    description: (row.description as string) ?? null,
    productLine: (row.product_line as string) ?? null,
    icon: (row.icon as string) ?? null,
    sortOrder: (row.sort_order as number) ?? 0,
    fullPath: (row.full_path as string) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class KnowledgePostgresStorage {
  private pool: pg.Pool;

  constructor() {
    this.pool = getPool();
  }

  async initialize(): Promise<void> {
    logger.info('Knowledge storage initialized');
  }

  /**
   * 确保 knowledge_categories 表中存在对应分类（slug + product_line），不存在则自动创建。
   * 利用 ON CONFLICT DO NOTHING 实现幂等 upsert。
   */
  async ensureCategoryExists(slug: string, productLine?: string | null): Promise<void> {
    if (!slug) return;
    try {
      const name = slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      await this.pool.query(
        `INSERT INTO memory.knowledge_categories (name, slug, product_line)
         VALUES ($1, $2, $3)
         ON CONFLICT (slug, COALESCE(product_line, '_global_')) DO NOTHING`,
        [name, slug, productLine ?? null],
      );
    } catch (err) {
      logger.debug({ err, slug }, '自动创建分类失败（不影响主流程）');
    }
  }

  async store(item: {
    projectId: string;
    productLine?: string;
    knowledgeType: string;
    category?: string;
    title: string;
    summary?: string | null;
    content: string;
    question?: string | null;
    metadata?: Record<string, unknown>;
    tags: string[];
    answerType: string;
    embedding: number[] | null;
    mediaText: string;
    media: KnowledgeMedia[];
    sourceType?: string;
    sourceRef?: string;
    visibility: string;
    status?: string;
    teamId?: string;
    orgId?: string;
    createdBy: string | null;
  }): Promise<KnowledgeItem> {
    const embeddingLiteral = item.embedding ? pgvectorLiteral(item.embedding) : null;
    const status = item.status ?? 'published';
    const result = await this.pool.query(
      `INSERT INTO memory.knowledge_items
       (project_id, product_line, knowledge_type, category,
        title, summary, content, question, metadata, tags, answer_type, embedding, media_text,
        media, source_type, source_ref, visibility, status, team_id, org_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $21)
       RETURNING *`,
      [
        item.projectId, item.productLine ?? null, item.knowledgeType,
        item.category ?? null,
        item.title, item.summary ?? null, item.content, item.question ?? null,
        JSON.stringify(item.metadata ?? {}),
        item.tags, item.answerType, embeddingLiteral, item.mediaText,
        JSON.stringify(item.media), item.sourceType ?? null,
        item.sourceRef ?? null, item.visibility, status,
        item.teamId ?? null, item.orgId ?? null, item.createdBy,
      ],
    );
    if (item.category) {
      await this.ensureCategoryExists(item.category, item.productLine);
    }
    return rowToKnowledgeItem(result.rows[0]);
  }

  async getById(id: string): Promise<KnowledgeItem | null> {
    const result = await this.pool.query(
      'SELECT * FROM memory.knowledge_items WHERE id = $1',
      [id],
    );
    return result.rows.length > 0 ? rowToKnowledgeItem(result.rows[0]) : null;
  }

  async getBySlug(slug: string, category?: string): Promise<KnowledgeItem | null> {
    const conditions = ['slug = $1'];
    const bindings: unknown[] = [slug];
    if (category) {
      conditions.push('category = $2');
      bindings.push(category);
    }
    const result = await this.pool.query(
      `SELECT * FROM memory.knowledge_items WHERE ${conditions.join(' AND ')} LIMIT 1`,
      bindings,
    );
    return result.rows.length > 0 ? rowToKnowledgeItem(result.rows[0]) : null;
  }

  async update(id: string, fields: Record<string, unknown>, updatedBy: string | null): Promise<KnowledgeItem | null> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(fields)) {
      if (!ALLOWED_UPDATE_COLUMNS.has(key)) continue;
      if (key === 'media') {
        setClauses.push(`media = $${idx}`);
        values.push(JSON.stringify(value));
      } else if (key === 'tags') {
        setClauses.push(`tags = $${idx}`);
        values.push(value);
      } else if (key === 'embedding') {
        setClauses.push(`embedding = $${idx}`);
        values.push(value ? pgvectorLiteral(value as number[]) : null);
      } else {
        setClauses.push(`${key} = $${idx}`);
        values.push(value);
      }
      idx++;
    }

    setClauses.push(`updated_by = $${idx}`);
    values.push(updatedBy);
    idx++;

    values.push(id);

    const result = await this.pool.query(
      `UPDATE memory.knowledge_items SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    return result.rows.length > 0 ? rowToKnowledgeItem(result.rows[0]) : null;
  }

  async findBySourceRef(sourceType: string, sourceRef: string): Promise<KnowledgeItem | null> {
    const result = await this.pool.query(
      'SELECT * FROM memory.knowledge_items WHERE source_type = $1 AND source_ref = $2 LIMIT 1',
      [sourceType, sourceRef],
    );
    return result.rows.length > 0 ? rowToKnowledgeItem(result.rows[0]) : null;
  }

  async findBySourceRefs(sourceType: string, sourceRefs: string[]): Promise<Map<string, KnowledgeItem>> {
    if (sourceRefs.length === 0) return new Map();
    const result = await this.pool.query(
      'SELECT * FROM memory.knowledge_items WHERE source_type = $1 AND source_ref = ANY($2)',
      [sourceType, sourceRefs],
    );
    const map = new Map<string, KnowledgeItem>();
    for (const row of result.rows) {
      const item = rowToKnowledgeItem(row);
      if (item.sourceRef) map.set(item.sourceRef, item);
    }
    return map;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM memory.knowledge_items WHERE id = $1',
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateStatus(id: string, status: string, userId: string | null): Promise<KnowledgeItem | null> {
    const extra: Record<string, unknown> = {};
    if (status === 'published') {
      extra.verified_by = userId;
      extra.verified_at = new Date().toISOString();
    }
    return this.update(id, { status, ...extra }, userId);
  }

  async vectorSearch(queryEmbedding: number[], projectIds: string[], opts: {
    knowledgeType?: string;
    category?: string;
    productLine?: string;
    visibilityFilters?: VisibilityFilterParams;
    limit: number;
  }): Promise<Array<{ id: string; score: number }>> {
    const embLiteral = pgvectorLiteral(queryEmbedding);
    const conditions = ["status = 'published'"];
    const bindings: unknown[] = [embLiteral];
    let idx = 2;

    if (projectIds.length > 0) {
      conditions.push(`project_id = ANY($${idx})`);
      bindings.push(projectIds);
      idx++;
    }

    if (opts.visibilityFilters?.orgId || opts.visibilityFilters?.userId || opts.visibilityFilters?.teamIds) {
      // 级联查询：personal + team + product_line + global
      if (opts.visibilityFilters.orgId) {
        conditions.push(`(org_id = $${idx++} OR org_id IS NULL)`);
        bindings.push(opts.visibilityFilters.orgId);
      }
      const { clause, nextIdx } = buildVisibilityClause(opts.visibilityFilters, bindings, idx, 'product_line');
      idx = nextIdx;
      conditions.push(clause);
    } else if (opts.productLine) {
      // 回退：无用户上下文时仅按产品线过滤
      conditions.push(`(product_line = $${idx} OR visibility = 'global')`);
      bindings.push(opts.productLine);
      idx++;
    }

    if (opts.knowledgeType) {
      conditions.push(`knowledge_type = $${idx}`);
      bindings.push(opts.knowledgeType);
      idx++;
    }
    if (opts.category) {
      conditions.push(`category = $${idx}`);
      bindings.push(opts.category);
      idx++;
    }

    bindings.push(opts.limit);

    const sql = `
      SELECT id, (1 - (embedding <=> $1)) AS score
      FROM memory.knowledge_items
      WHERE ${conditions.join(' AND ')}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> $1 ASC
      LIMIT $${idx}`;

    const result = await this.pool.query(sql, bindings);
    return result.rows.map(r => ({ id: r.id as string, score: r.score as number }));
  }

  async bm25Search(queryText: string, projectIds: string[], opts: {
    knowledgeType?: string;
    category?: string;
    productLine?: string;
    visibilityFilters?: VisibilityFilterParams;
    limit: number;
  }): Promise<Array<{ id: string; score: number }>> {
    const likeParam = `%${queryText}%`;
    const conditions = ["status = 'published'"];
    const bindings: unknown[] = [queryText, likeParam]; // $1 = FTS query, $2 = ILIKE pattern
    let idx = 3;

    // FTS 分词匹配 OR 精确子串匹配 — 解决 zhcfg 对短语（如"首充"）拆词导致的漏召回
    conditions.push(`(fts_vector @@ q.query OR title ILIKE $2 OR COALESCE(summary, '') ILIKE $2)`);

    if (projectIds.length > 0) {
      conditions.push(`project_id = ANY($${idx})`);
      bindings.push(projectIds);
      idx++;
    }

    if (opts.visibilityFilters?.orgId || opts.visibilityFilters?.userId || opts.visibilityFilters?.teamIds) {
      if (opts.visibilityFilters.orgId) {
        conditions.push(`(org_id = $${idx++} OR org_id IS NULL)`);
        bindings.push(opts.visibilityFilters.orgId);
      }
      const { clause, nextIdx } = buildVisibilityClause(opts.visibilityFilters, bindings, idx, 'product_line');
      idx = nextIdx;
      conditions.push(clause);
    } else if (opts.productLine) {
      conditions.push(`(product_line = $${idx} OR visibility = 'global')`);
      bindings.push(opts.productLine);
      idx++;
    }

    if (opts.knowledgeType) {
      conditions.push(`knowledge_type = $${idx}`);
      bindings.push(opts.knowledgeType);
      idx++;
    }
    if (opts.category) {
      conditions.push(`category = $${idx}`);
      bindings.push(opts.category);
      idx++;
    }

    bindings.push(opts.limit);

    const sql = `
      SELECT id,
        ts_rank_cd(fts_vector, q.query, 32) +
        CASE WHEN title ILIKE $2 OR COALESCE(summary, '') ILIKE $2 THEN 0.5 ELSE 0 END AS score
      FROM memory.knowledge_items,
           LATERAL (SELECT plainto_tsquery('english', $1) || plainto_tsquery('zhcfg'::regconfig, $1) AS query) q
      WHERE ${conditions.join(' AND ')}
      ORDER BY score DESC
      LIMIT $${idx}`;

    const result = await this.pool.query(sql, bindings);
    return result.rows.map(r => ({ id: r.id as string, score: r.score as number }));
  }

  async getByIds(ids: string[]): Promise<KnowledgeItem[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      'SELECT * FROM memory.knowledge_items WHERE id = ANY($1)',
      [ids],
    );
    return result.rows.map(rowToKnowledgeItem);
  }

  async updateMediaText(id: string, mediaText: string): Promise<void> {
    await this.pool.query(
      'UPDATE memory.knowledge_items SET media_text = $1, updated_at = NOW() WHERE id = $2',
      [mediaText, id],
    );
  }

  async incrementQueryCount(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      'UPDATE memory.knowledge_items SET query_count = query_count + 1 WHERE id = ANY($1)',
      [ids],
    ).catch(err => logger.warn({ err }, 'Failed to increment query count'));
  }

  async storeFeedback(knowledgeId: string, helpful: boolean, opts: {
    ticketId?: string;
    comment?: string;
    createdBy: string | null;
  }): Promise<void> {
    if (!opts.createdBy) {
      throw new Error('反馈必须关联用户');
    }

    const existing = await this.pool.query<{ id: string; helpful: boolean }>(
      `SELECT id, helpful FROM memory.knowledge_feedback
       WHERE knowledge_id = $1 AND created_by = $2`,
      [knowledgeId, opts.createdBy],
    );

    if (existing.rows.length > 0) {
      const prev = existing.rows[0];
      if (prev.helpful === helpful) {
        await this.pool.query(
          `UPDATE memory.knowledge_feedback
           SET ticket_id = $1, comment = $2
           WHERE id = $3`,
          [opts.ticketId ?? null, opts.comment ?? null, prev.id],
        );
        return;
      }

      await this.pool.query(
        `UPDATE memory.knowledge_feedback
         SET helpful = $1, ticket_id = $2, comment = $3
         WHERE id = $4`,
        [helpful, opts.ticketId ?? null, opts.comment ?? null, prev.id],
      );

      const decField = prev.helpful ? 'helpful_count' : 'unhelpful_count';
      const incField = helpful ? 'helpful_count' : 'unhelpful_count';
      await this.pool.query(
        `UPDATE memory.knowledge_items
         SET ${decField} = GREATEST(${decField} - 1, 0),
             ${incField} = ${incField} + 1
         WHERE id = $1`,
        [knowledgeId],
      );
    } else {
      await this.pool.query(
        `INSERT INTO memory.knowledge_feedback (knowledge_id, ticket_id, helpful, comment, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [knowledgeId, opts.ticketId ?? null, helpful, opts.comment ?? null, opts.createdBy],
      );

      const countField = helpful ? 'helpful_count' : 'unhelpful_count';
      await this.pool.query(
        `UPDATE memory.knowledge_items SET ${countField} = ${countField} + 1 WHERE id = $1`,
        [knowledgeId],
      );
    }

    // 3 个负反馈自动归档（反馈闭环）
    if (!helpful) {
      await this.pool.query(
        `UPDATE memory.knowledge_items
         SET status = 'archived', updated_at = NOW()
         WHERE id = $1 AND unhelpful_count >= 3 AND status != 'archived'`,
        [knowledgeId],
      );
    }
  }

  async getCategories(projectId?: string, productLine?: string): Promise<Array<{ category: string; count: number }>> {
    const conditions = ["status = 'published'", 'category IS NOT NULL'];
    const bindings: unknown[] = [];
    let idx = 1;

    if (projectId) {
      conditions.push(`project_id = $${idx}`);
      bindings.push(projectId);
      idx++;
    }
    if (productLine) {
      conditions.push(`product_line = $${idx}`);
      bindings.push(productLine);
    }

    const result = await this.pool.query(
      `SELECT category, COUNT(*)::int AS count
       FROM memory.knowledge_items
       WHERE ${conditions.join(' AND ')}
       GROUP BY category ORDER BY count DESC`,
      bindings,
    );
    return result.rows as Array<{ category: string; count: number }>;
  }

  async getStats(productLine?: string): Promise<Record<string, unknown>> {
    const where = productLine ? 'WHERE product_line = $1' : '';
    const bindings = productLine ? [productLine] : [];

    const total = await this.pool.query(
      `SELECT status, COUNT(*)::int AS count FROM memory.knowledge_items ${where} GROUP BY status`,
      bindings,
    );
    const byType = await this.pool.query(
      `SELECT knowledge_type, COUNT(*)::int AS count FROM memory.knowledge_items ${where} GROUP BY knowledge_type`,
      bindings,
    );

    const trend = await this.pool.query(
      `SELECT TO_CHAR(created_at, 'YYYY-MM') AS month, COUNT(*)::int AS count
       FROM memory.knowledge_items ${where}
       GROUP BY month ORDER BY month ASC`,
      bindings,
    );

    // 维度分布统计（来自 entries 的 metadata->dimension）
    const entryWhere = productLine ? "WHERE metadata->>'source_product_line' = $1" : '';
    let byDimension: Record<string, number> = {};
    let staleCount = 0;
    let autoLearnedCount = 0;
    try {
      const dimResult = await this.pool.query(
        `SELECT metadata->>'dimension' AS dimension, COUNT(*)::int AS count
         FROM memory.entries
         ${entryWhere}${entryWhere ? ' AND' : ' WHERE'} metadata->>'dimension' IS NOT NULL
         GROUP BY dimension ORDER BY count DESC`,
        bindings,
      );
      byDimension = Object.fromEntries(dimResult.rows.map(r => [r.dimension, r.count]));

      const staleResult = await this.pool.query(
        `SELECT COUNT(*)::int AS count FROM memory.entries
         ${entryWhere}${entryWhere ? ' AND' : ' WHERE'} metadata->>'stale_since' IS NOT NULL
         AND NOT COALESCE(is_archived, false)`,
        bindings,
      );
      staleCount = staleResult.rows[0]?.count ?? 0;

      const autoResult = await this.pool.query(
        `SELECT COUNT(*)::int AS count FROM memory.entries
         ${entryWhere}${entryWhere ? ' AND' : ' WHERE'} metadata->>'autoLearned' = 'true'`,
        bindings,
      );
      autoLearnedCount = autoResult.rows[0]?.count ?? 0;
    } catch {
      logger.debug('entries 表统计不可用，降级忽略 stale/autoLearned 计数');
    }

    return {
      byStatus: Object.fromEntries(total.rows.map(r => [r.status, r.count])),
      byType: Object.fromEntries(byType.rows.map(r => [r.knowledge_type, r.count])),
      trend: trend.rows.map(r => ({ month: r.month, count: r.count })),
      byDimension,
      staleCount,
      autoLearnedCount,
    };
  }

  async list(opts: {
    projectId?: string;
    productLine?: string;
    status?: string;
    knowledgeType?: string;
    category?: string;
    search?: string;
    page: number;
    pageSize: number;
    visibilityFilters?: VisibilityFilterParams;
  }): Promise<{ items: KnowledgeItem[]; total: number }> {
    const conditions: string[] = [];
    const bindings: unknown[] = [];
    let idx = 1;

    if (opts.projectId) {
      conditions.push(`project_id = $${idx}`);
      bindings.push(opts.projectId);
      idx++;
    }
    if (opts.productLine) {
      conditions.push(`product_line = $${idx}`);
      bindings.push(opts.productLine);
      idx++;
    }
    if (opts.status) {
      conditions.push(`status = $${idx}`);
      bindings.push(opts.status);
      idx++;
    }

    if (opts.visibilityFilters?.orgId || opts.visibilityFilters?.userId || opts.visibilityFilters?.teamIds) {
      if (opts.visibilityFilters.orgId) {
        conditions.push(`(org_id = $${idx++} OR org_id IS NULL)`);
        bindings.push(opts.visibilityFilters.orgId);
      }
      const { clause, nextIdx } = buildVisibilityClause(opts.visibilityFilters, bindings, idx, 'product_line');
      idx = nextIdx;
      conditions.push(clause);
    } else if (opts.status === 'published') {
      // 未认证用户仅可见 global 级别的已发布条目
      conditions.push("visibility = 'global'");
    }
    if (opts.knowledgeType) {
      conditions.push(`knowledge_type = $${idx}`);
      bindings.push(opts.knowledgeType);
      idx++;
    }
    if (opts.category) {
      conditions.push(`category = $${idx}`);
      bindings.push(opts.category);
      idx++;
    }
    if (opts.search) {
      const pattern = `%${opts.search}%`;
      conditions.push(`(title ILIKE $${idx} OR content ILIKE $${idx} OR question ILIKE $${idx})`);
      bindings.push(pattern);
      idx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM memory.knowledge_items ${whereClause}`,
      bindings,
    );

    const offset = (opts.page - 1) * opts.pageSize;
    bindings.push(opts.pageSize, offset);

    const result = await this.pool.query(
      `SELECT * FROM memory.knowledge_items ${whereClause} ORDER BY updated_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      bindings,
    );

    return {
      items: result.rows.map(rowToKnowledgeItem),
      total: countResult.rows[0]?.total ?? 0,
    };
  }

  async listCategories(productLine?: string): Promise<KnowledgeCategory[]> {
    const conditions: string[] = [];
    const bindings: unknown[] = [];
    let idx = 1;

    if (productLine) {
      conditions.push(`(product_line = $${idx} OR product_line IS NULL)`);
      bindings.push(productLine);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT kc.*, COALESCE(ic.item_count, 0)::int AS item_count
       FROM memory.knowledge_categories kc
       LEFT JOIN (
         SELECT category, product_line, COUNT(*)::int AS item_count
         FROM memory.knowledge_items
         WHERE category IS NOT NULL AND status = 'published'
         GROUP BY category, product_line
       ) ic ON ic.category = kc.slug
           AND (ic.product_line = kc.product_line OR (ic.product_line IS NULL AND kc.product_line IS NULL))
       ${whereClause}
       ORDER BY kc.sort_order ASC, kc.name ASC`,
      bindings,
    );
    const managed = result.rows.map((row: Record<string, unknown>) => {
      const cat = rowToKnowledgeCategory(row);
      (cat as unknown as Record<string, unknown>).itemCount = row.item_count ?? 0;
      return cat;
    });

    // 补充：knowledge_items 中有 category 但 knowledge_categories 表中尚不存在的分类
    const orphanBindings: unknown[] = [];
    let orphanPlCondition = '';
    if (productLine) {
      orphanBindings.push(productLine);
      orphanPlCondition = `AND (ki.product_line = $1 OR ki.product_line IS NULL)`;
    }
    const orphanResult = await this.pool.query(
      `SELECT ki.category, ki.product_line, COUNT(*)::int AS item_count
       FROM memory.knowledge_items ki
       WHERE ki.category IS NOT NULL AND ki.status = 'published' ${orphanPlCondition}
         AND NOT EXISTS (
           SELECT 1 FROM memory.knowledge_categories kc
           WHERE kc.slug = ki.category
             AND COALESCE(kc.product_line, '_global_') = COALESCE(ki.product_line, '_global_')
         )
       GROUP BY ki.category, ki.product_line
       ORDER BY item_count DESC`,
      orphanBindings,
    );

    for (const row of orphanResult.rows) {
      const slug = row.category as string;
      managed.push({
        id: `virtual:${slug}`,
        name: slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        slug,
        parentId: null,
        description: null,
        productLine: (row.product_line as string) ?? null,
        icon: null,
        sortOrder: 999,
        fullPath: null,
        itemCount: row.item_count ?? 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as KnowledgeCategory & { itemCount: number });
    }

    return managed;
  }

  async createCategory(input: {
    name: string;
    slug: string;
    parentId?: string;
    description?: string;
    productLine?: string;
    icon?: string;
    sortOrder?: number;
  }): Promise<KnowledgeCategory> {
    const result = await this.pool.query(
      `INSERT INTO memory.knowledge_categories
       (name, slug, parent_id, description, product_line, icon, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.name, input.slug, input.parentId ?? null,
        input.description ?? null, input.productLine ?? null,
        input.icon ?? null, input.sortOrder ?? 0,
      ],
    );
    return rowToKnowledgeCategory(result.rows[0]);
  }

  async updateCategory(id: string, fields: {
    name?: string;
    slug?: string;
    parentId?: string | null;
    description?: string | null;
    productLine?: string | null;
    icon?: string | null;
    sortOrder?: number;
  }): Promise<KnowledgeCategory | null> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const fieldMap: Record<string, string> = {
      name: 'name',
      slug: 'slug',
      parentId: 'parent_id',
      description: 'description',
      productLine: 'product_line',
      icon: 'icon',
      sortOrder: 'sort_order',
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      const val = fields[key as keyof typeof fields];
      if (val !== undefined) {
        setClauses.push(`${col} = $${idx}`);
        values.push(val);
        idx++;
      }
    }

    if (setClauses.length === 0) {
      const existing = await this.pool.query(
        'SELECT * FROM memory.knowledge_categories WHERE id = $1',
        [id],
      );
      return existing.rows.length > 0 ? rowToKnowledgeCategory(existing.rows[0]) : null;
    }

    setClauses.push('updated_at = NOW()');
    values.push(id);

    const result = await this.pool.query(
      `UPDATE memory.knowledge_categories SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    return result.rows.length > 0 ? rowToKnowledgeCategory(result.rows[0]) : null;
  }

  async deleteCategory(id: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM memory.knowledge_categories WHERE id = $1',
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

}
