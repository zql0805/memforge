// Created by dev on 2026/06/04
// recall_memory 核心搜索逻辑，供 MCP 工具和 REST API 共用

import { RecallMemoryInput, getLogger, buildProjectCascade, getPool, queryWithRLS, getRLSContext } from '@memforgeai/shared';
import type { PostgresStorage } from '../storage/postgres.js';
import type { ApiEmbeddingService } from '@memforgeai/shared';
import { resolveVisibilityContext } from '../services/team-resolver.js';
import { incrementRecallCount, checkAndPromote } from '../storage/auto-promote.js';
import { computeDecayFactor } from '../tools/recall.js';

const logger = getLogger('recall-engine');

export interface RecallSearchParams {
  query: string;
  scopeFilter?: string[];
  tagsFilter?: string[];
  includeArchived?: boolean;
  limit?: number;
  minSimilarity?: number;
  format?: 'json' | 'prompt';
  productLine?: string;
  crossProject?: boolean;
  crossTeam?: boolean;
  teamFilter?: string[];
  maxContentLength?: number;
  timeDecay?: boolean;
  searchMethod?: 'semantic' | 'keyword' | 'hybrid';
  detailLevel?: 'full' | 'summary';
}

export interface RecallSearchContext {
  storage: PostgresStorage;
  embedding: ApiEmbeddingService;
  userId: string | null;
  orgId: string | null;
  teamId: string | null;
  gitProjectName?: string | null;
  gitBranchName?: string | null;
}

interface RecallTrace {
  embedding_model: string;
  query_tokens: number;
  vector_candidates: number;
  fts_fallback_used: boolean;
  fts_candidates: number;
  cascade_levels: string[];
  time_decay_applied: boolean;
  graph_expansion_count: number;
  final_count: number;
  search_time_ms: number;
}

interface RelationInfo {
  relationType: string;
  direction: 'outgoing' | 'incoming';
  relatedId: string;
  relatedTitle: string;
  confidence: number;
}

export interface RecallSearchResult {
  success: boolean;
  searchMethod: string;
  project?: string[];
  branch?: string | null;
  results: RecallResultItem[];
  total: number;
  trace: RecallTrace;
  promptText?: string;
}

export interface RecallResultItem {
  id: string;
  title: string;
  content: string;
  scope: string;
  source?: string;
  tags: string[];
  similarity: number;
  isVerified?: boolean;
  createdAt: string;
  relations?: RelationInfo[];
}

/**
 * 核心 recall 搜索逻辑
 */
export async function executeRecallSearch(
  params: RecallSearchParams,
  ctx: RecallSearchContext,
): Promise<RecallSearchResult> {
  if (!ctx.userId) {
    return {
      success: true,
      searchMethod: params.searchMethod ?? 'hybrid',
      results: [],
      total: 0,
      trace: {
        embedding_model: 'unknown',
        query_tokens: 0,
        vector_candidates: 0,
        fts_fallback_used: false,
        fts_candidates: 0,
        cascade_levels: [],
        time_decay_applied: false,
        graph_expansion_count: 0,
        final_count: 0,
        search_time_ms: 0,
      },
    };
  }

  const t0 = Date.now();

  const input = RecallMemoryInput.parse({
    query: params.query,
    scopeFilter: params.scopeFilter,
    tagsFilter: params.tagsFilter,
    includeArchived: params.includeArchived,
    limit: params.limit ?? 10,
    minSimilarity: params.minSimilarity ?? 0.5,
  });

  const maxContentLen = params.maxContentLength ?? 500;
  const searchMethod = params.searchMethod ?? 'hybrid';
  const enableDecay = params.timeDecay !== false;

  const projectIds = params.crossProject
    ? undefined
    : buildProjectCascade(ctx.gitProjectName ?? undefined, params.productLine);
  const branchId = ctx.gitBranchName ?? null;

  const visCtx = await resolveVisibilityContext(ctx.userId, ctx.orgId, ctx.teamId, params.crossTeam);
  if (params.teamFilter && params.teamFilter.length > 0) {
    visCtx.teamIds = params.teamFilter;
  }

  const fetchLimit = enableDecay ? input.limit * 3 : input.limit;
  const contentFilters = {
    tagsFilter: input.tagsFilter,
    scopeFilter: input.scopeFilter,
    orgId: visCtx.orgId,
    userId: visCtx.userId,
    teamIds: visCtx.teamIds,
    accessibleProductLines: visCtx.accessibleProductLines,
  };

  let searchHits: Array<{ id: string; similarity: number }> = [];
  let resolvedMethod = searchMethod;
  let vectorCandidates = 0;
  let ftsFallbackUsed = false;
  let ftsCandidates = 0;

  if (searchMethod === 'keyword') {
    searchHits = await ctx.storage.searchByKeyword(input.query, projectIds, branchId, fetchLimit, contentFilters);
    ftsCandidates = searchHits.length;
    resolvedMethod = 'keyword';
  } else if (searchMethod === 'hybrid') {
    const [vectorHits, keywordHits] = await Promise.all([
      ctx.embedding.embedQuery(input.query).then(emb =>
        ctx.storage.searchByEmbedding(emb, projectIds, branchId, fetchLimit, input.minSimilarity, contentFilters),
      ),
      ctx.storage.searchByKeyword(input.query, projectIds, branchId, fetchLimit, contentFilters),
    ]);
    vectorCandidates = vectorHits.length;
    ftsCandidates = keywordHits.length;
    searchHits = rrfMerge(vectorHits, keywordHits, fetchLimit);
    resolvedMethod = 'hybrid';
  } else {
    const queryEmbedding = await ctx.embedding.embedQuery(input.query);
    searchHits = await ctx.storage.searchByEmbedding(queryEmbedding, projectIds, branchId, fetchLimit, input.minSimilarity, contentFilters);
    vectorCandidates = searchHits.length;

    if (searchHits.length === 0) {
      ftsFallbackUsed = true;
      const textResults = await ctx.storage.searchByText(
        input.query, projectIds, branchId, input.limit,
        { orgId: visCtx.orgId, userId: visCtx.userId, teamIds: visCtx.teamIds, accessibleProductLines: visCtx.accessibleProductLines },
        { tagsFilter: input.tagsFilter, scopeFilter: input.scopeFilter },
      );
      ftsCandidates = textResults.length;
      const filteredTextResults = textResults.filter(e => {
        const meta = (e as unknown as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
        return !(meta?.migrated_to_knowledge === true || meta?.migrated_to_knowledge === 'true');
      });

      if (filteredTextResults.length > 0) {
        const trace: RecallTrace = {
          embedding_model: ctx.embedding.modelName ?? 'unknown',
          query_tokens: Math.ceil(input.query.length / 2),
          vector_candidates: 0,
          fts_fallback_used: true,
          fts_candidates: ftsCandidates,
          cascade_levels: projectIds ?? ['*'],
          time_decay_applied: enableDecay,
          graph_expansion_count: 0,
          final_count: filteredTextResults.length,
          search_time_ms: Date.now() - t0,
        };
        const results: RecallResultItem[] = filteredTextResults.map(e => ({
          id: e.id, title: e.title, content: e.content.slice(0, maxContentLen),
          scope: e.scope, tags: e.tags, similarity: 0, createdAt: e.createdAt,
        }));
        return {
          success: true, searchMethod: 'fulltext_fallback',
          project: projectIds, branch: branchId,
          results, total: results.length, trace,
        };
      }

      return {
        success: true, searchMethod: resolvedMethod,
        results: [], total: 0, trace: {
          embedding_model: ctx.embedding.modelName ?? 'unknown',
          query_tokens: Math.ceil(input.query.length / 2),
          vector_candidates: 0, fts_fallback_used: true, fts_candidates: 0,
          cascade_levels: projectIds ?? ['*'], time_decay_applied: enableDecay,
          graph_expansion_count: 0, final_count: 0, search_time_ms: Date.now() - t0,
        },
      };
    }
    resolvedMethod = 'semantic';
  }

  if (searchHits.length === 0) {
    return {
      success: true, searchMethod: resolvedMethod,
      results: [], total: 0, trace: {
        embedding_model: ctx.embedding.modelName ?? 'unknown',
        query_tokens: Math.ceil(input.query.length / 2),
        vector_candidates: vectorCandidates, fts_fallback_used: false, fts_candidates: ftsCandidates,
        cascade_levels: projectIds ?? ['*'], time_decay_applied: enableDecay,
        graph_expansion_count: 0, final_count: 0, search_time_ms: Date.now() - t0,
      },
    };
  }

  let results: RecallResultItem[] = [];
  const VERIFIED_BOOST = 1.15;

  const entryMap = await ctx.storage.getByIds(searchHits.map(h => h.id));

  for (const sr of searchHits) {
    const entry = entryMap.get(sr.id);
    if (!entry) continue;

    const meta = (entry as unknown as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
    if (meta?.migrated_to_knowledge === true || meta?.migrated_to_knowledge === 'true') continue;

    const rawSimilarity = sr.similarity;
    const decayFactor = enableDecay ? computeDecayFactor(entry.updatedAt ?? entry.createdAt, entry.scope) : 1.0;
    const verifiedBoost = entry.isVerified ? VERIFIED_BOOST : 1.0;
    const effectiveSimilarity = Math.min(rawSimilarity * decayFactor * verifiedBoost, 1.0);

    const detailLevel = params.detailLevel ?? 'full';
    const displayContent = detailLevel === 'summary'
      ? ((entry as unknown as Record<string, unknown>).abstract as string ?? entry.title)
      : entry.content.slice(0, maxContentLen);

    results.push({
      id: entry.id, title: entry.title, content: displayContent,
      scope: entry.scope, source: entry.source, tags: entry.tags,
      similarity: Math.round(effectiveSimilarity * 1000) / 1000,
      isVerified: entry.isVerified, createdAt: entry.createdAt,
    });
  }

  if (enableDecay) {
    results.sort((a, b) => b.similarity - a.similarity);
    results = results.slice(0, input.limit);
  }

  let graphExpansionCount = 0;
  if (results.length > 0) {
    const ids = results.map(r => r.id);
    const relations = await fetchRelationsForEntries(ids);
    for (const r of results) {
      const rels = relations.get(r.id) ?? [];
      r.relations = rels;
      graphExpansionCount += rels.length;
    }
  }

  logger.info({ query: input.query, resultCount: results.length, timeDecay: enableDecay, method: resolvedMethod }, 'recall 检索完成');

  if (results.length > 0) {
    const ids = results.map(r => r.id);
    incrementRecallCount(ids)
      .then(() => checkAndPromote(ids))
      .catch(err => logger.debug({ err }, '自动晋升流程异常'));
  }

  const trace: RecallTrace = {
    embedding_model: ctx.embedding.modelName ?? 'unknown',
    query_tokens: Math.ceil(input.query.length / 2),
    vector_candidates: vectorCandidates, fts_fallback_used: ftsFallbackUsed, fts_candidates: ftsCandidates,
    cascade_levels: projectIds ?? ['*'], time_decay_applied: enableDecay,
    graph_expansion_count: graphExpansionCount,
    final_count: results.length, search_time_ms: Date.now() - t0,
  };

  return {
    success: true, searchMethod: resolvedMethod,
    project: projectIds, branch: branchId,
    results, total: results.length, trace,
  };
}

function rrfMerge(
  listA: Array<{ id: string; similarity: number }>,
  listB: Array<{ id: string; similarity: number }>,
  limit: number,
  k = 60,
): Array<{ id: string; similarity: number }> {
  const scores = new Map<string, number>();
  const bestSim = new Map<string, number>();
  for (let i = 0; i < listA.length; i++) {
    const item = listA[i];
    scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + i + 1));
    bestSim.set(item.id, Math.max(bestSim.get(item.id) ?? 0, item.similarity));
  }
  for (let i = 0; i < listB.length; i++) {
    const item = listB[i];
    scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + i + 1));
    bestSim.set(item.id, Math.max(bestSim.get(item.id) ?? 0, item.similarity));
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, rrfScore]) => ({ id, similarity: Math.min(rrfScore / (2 / (k + 1)), bestSim.get(id) ?? rrfScore) }));
}

async function fetchRelationsForEntries(ids: string[]): Promise<Map<string, RelationInfo[]>> {
  const result = new Map<string, RelationInfo[]>();
  if (ids.length === 0) return result;

  try {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const doQuery = getRLSContext() ? queryWithRLS : getPool().query.bind(getPool());
    const { rows } = await doQuery(
      `SELECT kr.source_id, kr.target_id, kr.relation_type, kr.confidence,
              COALESCE(es.title, '') AS source_title,
              COALESCE(et.title, '') AS target_title
       FROM memory.knowledge_relations kr
       LEFT JOIN memory.entries es ON kr.source_id::uuid = es.id
       LEFT JOIN memory.entries et ON kr.target_id::uuid = et.id
       WHERE kr.source_id IN (${placeholders}) OR kr.target_id IN (${placeholders})`,
      ids,
    );
    for (const row of rows) {
      for (const id of ids) {
        if (row.source_id === id) {
          if (!result.has(id)) result.set(id, []);
          result.get(id)!.push({ relationType: row.relation_type, direction: 'outgoing', relatedId: row.target_id, relatedTitle: row.target_title, confidence: parseFloat(row.confidence) });
        }
        if (row.target_id === id) {
          if (!result.has(id)) result.set(id, []);
          result.get(id)!.push({ relationType: row.relation_type, direction: 'incoming', relatedId: row.source_id, relatedTitle: row.source_title, confidence: parseFloat(row.confidence) });
        }
      }
    }
  } catch (err) {
    logger.warn({ err, count: ids.length }, '关联链查询失败（不影响 recall 结果）');
  }
  return result;
}
