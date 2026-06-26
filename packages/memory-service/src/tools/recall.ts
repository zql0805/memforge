// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RecallMemoryInput, getLogger, buildProjectCascade, getPool, queryWithRLS, getRLSContext } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { resolveVisibilityContext, type VisibilityContext } from '../services/team-resolver.js';
import { incrementRecallCount, checkAndPromote } from '../storage/auto-promote.js';

const logger = getLogger('tool:recall');

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

/**
 * D2 优化: 同会话 LRU 缓存
 * key = query+filters hash, value = formatted result
 */
const recallCache = new Map<string, { result: string; ts: number }>();
const RECALL_CACHE_MAX = 100;
const RECALL_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 时间衰减配置：按 scope 分组设定半衰期（天）。
 * 半衰期 = 0 表示不衰减（常青知识）。
 */
const SCOPE_HALF_LIFE_DAYS: Record<string, number> = {
  coding_standard: 0,
  architecture: 0,
  convention: 0,
  bug_pattern: 180,
  lesson_learned: 180,
  performance_insight: 180,
  debugging_strategy: 90,
  task_progress: 90,
  domain_knowledge: 120,
  tool_usage: 60,
  user_profile: 0,
  entity_reference: 0,
};
const DEFAULT_HALF_LIFE_DAYS = 90;
const LN2 = Math.LN2;

/**
 * 计算时间衰减因子：e^(-λ × age_days)，其中 λ = ln(2) / half_life
 */
export function computeDecayFactor(createdAt: string, scope: string): number {
  const halfLife = SCOPE_HALF_LIFE_DAYS[scope] ?? DEFAULT_HALF_LIFE_DAYS;
  if (halfLife === 0) return 1.0;
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1.0;
  return Math.exp(-(LN2 / halfLife) * ageDays);
}

export function registerRecallMemory(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'recall_memory',
    '从知识库中语义检索相关记忆。自动感知当前项目和分支上下文。',
    {
      query: z.string().describe('搜索查询（自然语言）'),
      scope_filter: z.array(z.string()).optional().describe('按记忆类型过滤'),
      tags_filter: z.array(z.string()).optional().describe('按标签过滤'),
      include_archived: z.boolean().optional().describe('是否包含已归档记忆'),
      limit: z.number().optional().describe('返回结果数量（默认 15）'),
      min_similarity: z.number().optional().describe('最小相似度阈值（默认 0.5）'),
      // A3 优化: prompt 格式输出
      format: z.enum(['json', 'prompt']).optional().describe('输出格式: json（默认）或 prompt（AI 友好的结构化文本）'),
      // A5 优化: 多项目隔离
      product_line: z.string().optional().describe('产品线过滤（跨项目检索时指定，如 "my-product"）'),
      cross_project: z.boolean().optional().describe('跨项目检索：忽略当前 Git 项目限制，搜索所有项目的记忆。适用于多仓库协作场景'),
      cross_team: z.boolean().optional().describe('跨团队检索：搜索用户所有所属团队的 team 级记忆（默认仅搜主团队）'),
      team_filter: z.array(z.string()).optional().describe('按团队 ID 过滤：仅返回指定团队的 team 级记忆。用于同产品线下区分客户端/服务端团队记忆'),
      max_content_length: z.number().optional().describe('返回内容的最大字符数（默认 500，拓扑等大文本场景可设更大）'),
      time_decay: z.boolean().optional().describe('启用时间衰减（默认 true）：按 scope 分级衰减旧记忆的排序权重，常青知识不衰减'),
      search_method: z.enum(['semantic', 'keyword', 'hybrid']).optional()
        .describe('搜索方法: semantic（默认，向量语义搜索）| keyword（关键词精确匹配，支持中文）| hybrid（语义+关键词 RRF 融合）'),
      detail_level: z.enum(['full', 'summary']).optional()
        .describe('返回详细程度: full（默认，完整内容）| summary（仅标题+摘要，省 token）'),
    },
    async (params) => {
      try {
        if (!ctx.userId) {
          const outputFormat = params.format ?? 'json';
          const emptyResult = outputFormat === 'prompt'
            ? '未提供用户身份，无法查询记忆。'
            : JSON.stringify({
                results: [],
                total: 0,
                message: '未提供用户身份，无法查询记忆',
              });
          return { content: [{ type: 'text' as const, text: emptyResult }] };
        }

        const t0 = Date.now();
        const input = RecallMemoryInput.parse({
          query: params.query,
          scopeFilter: params.scope_filter,
          tagsFilter: params.tags_filter,
          includeArchived: params.include_archived,
          limit: params.limit,
          minSimilarity: params.min_similarity,
        });

        const outputFormat = params.format ?? 'json';
        const maxContentLen = params.max_content_length ?? 500;

        const gitContext = ctx.gitContext;
        const projectIds = params.cross_project
          ? undefined
          : buildProjectCascade(gitContext?.projectName, params.product_line);
        const branchId = gitContext?.branchName ?? null;

        const searchMethod = params.search_method ?? 'semantic';

        const visCtx = await resolveVisibilityContext(ctx.userId, ctx.orgId, ctx.teamId, params.cross_team);
        if (params.team_filter && params.team_filter.length > 0) {
          visCtx.teamIds = params.team_filter;
        }

        const cacheKey = buildCacheKey(
          input.query, projectIds?.join(','), branchId, input.limit, outputFormat,
          input.tagsFilter, input.scopeFilter, ctx.userId,
          params.team_filter, searchMethod,
          ctx.orgId, visCtx.teamIds,
        );
        const cached = recallCache.get(cacheKey);
        if (cached && (Date.now() - cached.ts) < RECALL_CACHE_TTL_MS) {
          logger.debug({ query: input.query, cached: true }, 'recall_memory 命中缓存');
          return { content: [{ type: 'text' as const, text: cached.result }] };
        }

        const enableDecay = params.time_decay !== false;
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
          searchHits = await ctx.storage.searchByKeyword(
            input.query, projectIds, branchId, fetchLimit, contentFilters,
          );
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
          searchHits = await ctx.storage.searchByEmbedding(
            queryEmbedding, projectIds, branchId, fetchLimit, input.minSimilarity, contentFilters,
          );
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
              const result = outputFormat === 'prompt'
                ? formatAsPrompt(filteredTextResults.map(e => ({
                    id: e.id, title: e.title, content: e.content.slice(0, maxContentLen),
                    scope: e.scope, tags: e.tags, similarity: 0, createdAt: e.createdAt,
                  })), input.query, 'fulltext_fallback', trace)
                : JSON.stringify({
                    success: true, searchMethod: 'fulltext_fallback',
                    results: filteredTextResults.map(e => ({
                      id: e.id, title: e.title, content: e.content.slice(0, maxContentLen),
                      scope: e.scope, tags: e.tags, createdAt: e.createdAt,
                    })),
                    total: filteredTextResults.length,
                    trace,
                  });
              updateCache(cacheKey, result);
              return { content: [{ type: 'text' as const, text: result }] };
            }

            const emptyResult = outputFormat === 'prompt'
              ? '未找到与查询相关的记忆。'
              : JSON.stringify({ success: true, results: [], total: 0, message: '未找到相关记忆。' });
            return { content: [{ type: 'text' as const, text: emptyResult }] };
          }
          resolvedMethod = 'semantic';
        }

        if (searchHits.length === 0) {
          const emptyResult = outputFormat === 'prompt'
            ? '未找到与查询相关的记忆。'
            : JSON.stringify({ success: true, results: [], total: 0, searchMethod: resolvedMethod, message: '未找到相关记忆。' });
          return { content: [{ type: 'text' as const, text: emptyResult }] };
        }

        let results = [];
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

          const detailLevel = params.detail_level ?? 'full';
          const displayContent = detailLevel === 'summary'
            ? ((entry as unknown as Record<string, unknown>).abstract as string ?? entry.title)
            : entry.content.slice(0, maxContentLen);
          results.push({
            id: entry.id,
            title: entry.title,
            content: displayContent,
            scope: entry.scope,
            source: entry.source,
            tags: entry.tags,
            similarity: Math.round(effectiveSimilarity * 1000) / 1000,
            isVerified: entry.isVerified,
            createdAt: entry.createdAt,
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
            (r as Record<string, unknown>).relations = rels;
            graphExpansionCount += rels.length;
          }
        }

        logger.info({ query: input.query, resultCount: results.length, timeDecay: enableDecay, method: resolvedMethod }, 'recall_memory 检索完成');

        if (results.length > 0) {
          const ids = results.map(r => r.id);
          incrementRecallCount(ids)
            .then(() => checkAndPromote(ids))
            .catch(err => logger.debug({ err }, '自动晋升流程异常'));
        }

        const trace: RecallTrace = {
          embedding_model: ctx.embedding.modelName ?? 'unknown',
          query_tokens: Math.ceil(input.query.length / 2),
          vector_candidates: vectorCandidates,
          fts_fallback_used: ftsFallbackUsed,
          fts_candidates: ftsCandidates,
          cascade_levels: projectIds ?? ['*'],
          time_decay_applied: enableDecay,
          graph_expansion_count: graphExpansionCount,
          final_count: results.length,
          search_time_ms: Date.now() - t0,
        };

        const resultText = outputFormat === 'prompt'
          ? formatAsPrompt(results, input.query, resolvedMethod, trace)
            : JSON.stringify({
              success: true, searchMethod: resolvedMethod,
              project: projectIds, branch: branchId,
              results, total: results.length,
              trace,
            });

        updateCache(cacheKey, resultText);

        return { content: [{ type: 'text' as const, text: resultText }] };
      } catch (error) {
        logger.error({ error }, 'recall_memory 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}

/**
 * A3 优化: 将检索结果格式化为 AI 友好的 prompt 文本
 */
function formatAsPrompt(
  results: Array<{
    id: string; title: string; content: string; scope: string;
    tags: string[]; similarity: number; createdAt: string;
    relations?: RelationInfo[];
  }>,
  query: string,
  method: string,
  trace?: RecallTrace,
): string {
  if (results.length === 0) {
    return '未找到与查询相关的记忆。';
  }

  const lines: string[] = [
    `📚 检索到 ${results.length} 条相关记忆（查询: "${query}"，方法: ${method}）`,
    '',
  ];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`--- 记忆 ${i + 1}${r.similarity ? ` (相似度: ${(r.similarity * 100).toFixed(1)}%)` : ''} ---`);
    lines.push(`标题: ${r.title}`);
    lines.push(`类型: ${r.scope} | 标签: ${r.tags.join(', ') || '无'}`);
    lines.push(`内容: ${r.content}`);
    if (r.relations && r.relations.length > 0) {
      lines.push(`关联: ${r.relations.map(rel => {
        const arrow = rel.direction === 'outgoing' ? '→' : '←';
        return `[${rel.relationType}] ${arrow} ${rel.relatedTitle || rel.relatedId}`;
      }).join('; ')}`);
    }
    lines.push('');
  }

  if (trace) {
    lines.push(`🔍 检索轨迹: 向量候选 ${trace.vector_candidates} | FTS 候选 ${trace.fts_candidates}${trace.fts_fallback_used ? '(兜底)' : ''} | 关联 ${trace.graph_expansion_count} | 耗时 ${trace.search_time_ms}ms`);
  }

  lines.push('💡 以上记忆仅供参考，请结合当前上下文判断是否适用。');

  return lines.join('\n');
}

/**
 * Reciprocal Rank Fusion：融合多个搜索结果列表。
 * score(d) = Σ 1/(k + rank_i)，k=60 是平滑常数。
 */
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
    .map(([id, rrfScore]) => ({
      id,
      // 归一化到 0~1：RRF 理论最大值 = 2/(k+1)（两个列表都排第一）
      similarity: Math.min(rrfScore / (2 / (k + 1)), bestSim.get(id) ?? rrfScore),
    }));
}

export function buildCacheKey(
  query: string, projectKey: string | undefined, branchId: string | null,
  limit: number, format: string,
  tagsFilter?: string[], scopeFilter?: string[],
  userId?: string | null,
  teamFilter?: string[],
  method?: string,
  orgId?: string | null,
  teamIds?: string[],
): string {
  const tags = tagsFilter?.sort().join(',') ?? '';
  const scope = scopeFilter?.sort().join(',') ?? '';
  const teams = teamFilter?.sort().join(',') ?? '';
  const visTeams = teamIds?.sort().join(',') ?? '';
  return `${userId ?? 'anon'}|${orgId ?? ''}|vt:${visTeams}|${query}|${projectKey ?? '*'}|${branchId ?? ''}|${limit}|${format}|t:${tags}|s:${scope}|tf:${teams}|m:${method ?? 'semantic'}`;
}

interface RelationInfo {
  relationType: string;
  direction: 'outgoing' | 'incoming';
  relatedId: string;
  relatedTitle: string;
  confidence: number;
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
          result.get(id)!.push({
            relationType: row.relation_type,
            direction: 'outgoing',
            relatedId: row.target_id,
            relatedTitle: row.target_title,
            confidence: parseFloat(row.confidence),
          });
        }
        if (row.target_id === id) {
          if (!result.has(id)) result.set(id, []);
          result.get(id)!.push({
            relationType: row.relation_type,
            direction: 'incoming',
            relatedId: row.source_id,
            relatedTitle: row.source_title,
            confidence: parseFloat(row.confidence),
          });
        }
      }
    }
  } catch (err) {
    logger.warn({ err, count: ids.length }, '关联链查询失败（不影响 recall 结果）');
  }

  return result;
}

function updateCache(key: string, result: string): void {
  if (recallCache.size >= RECALL_CACHE_MAX) {
    const entries = [...recallCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const deleteCount = Math.floor(RECALL_CACHE_MAX * 0.25);
    for (let i = 0; i < deleteCount; i++) {
      recallCache.delete(entries[i][0]);
    }
  }
  recallCache.set(key, { result, ts: Date.now() });
}
