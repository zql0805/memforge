// Created by dev on 2026/05/21
import { getLogger } from '@memforgeai/shared';
import type { ApiEmbeddingService, KnowledgeItem, KBSearchResult, VisibilityFilterParams } from '@memforgeai/shared';
import type { KnowledgePostgresStorage } from '../storage/postgres.js';
import { rrfFuse } from './rrf.js';
import { computeConfidence, queryLooksLikeCode, queryLooksLikeOperational } from './confidence.js';

const logger = getLogger('knowledge:search');

export interface SearchTrace {
  embedding_model: string;
  vector_candidates: number;
  bm25_candidates: number;
  rrf_fused_count: number;
  confidence_filtered: number;
  auto_reply_suggested: boolean;
  bilingual_fts: boolean;
  search_time_ms: number;
}

export interface HybridSearchOpts {
  query: string;
  projectIds: string[];
  productLine?: string;
  knowledgeType?: string;
  category?: string;
  limit: number;
  minConfidence: number;
  visibilityFilters?: VisibilityFilterParams;
}

export class HybridSearchEngine {
  constructor(
    private readonly storage: KnowledgePostgresStorage,
    private readonly embedding: ApiEmbeddingService | null,
  ) {}

  async search(opts: HybridSearchOpts): Promise<{ results: KBSearchResult[]; autoReplySuggested: boolean; total: number; trace: SearchTrace }> {
    const t0 = Date.now();
    const topK = Math.max(opts.limit * 3, 20);

    let queryEmbedding: number[] | null = null;
    if (this.embedding) {
      try {
        [queryEmbedding] = await this.embedding.embedBatch([opts.query]);
      } catch (err) {
        logger.warn({ err }, '查询向量嵌入失败，降级为 BM25 检索');
      }
    }

    const searchOpts = {
      knowledgeType: opts.knowledgeType,
      category: opts.category,
      productLine: opts.productLine,
      visibilityFilters: opts.visibilityFilters,
      limit: topK,
    };

    const [vectorSettled, bm25Settled] = await Promise.allSettled([
      queryEmbedding
        ? this.storage.vectorSearch(queryEmbedding, opts.projectIds, searchOpts)
        : Promise.resolve([]),
      this.storage.bm25Search(opts.query, opts.projectIds, searchOpts),
    ]);

    const vectorResults = vectorSettled.status === 'fulfilled' ? vectorSettled.value : [];
    const bm25Results = bm25Settled.status === 'fulfilled' ? bm25Settled.value : [];

    if (vectorSettled.status === 'rejected') {
      logger.warn({ err: vectorSettled.reason }, 'Vector search failed, degrading to BM25 only');
    }
    if (bm25Settled.status === 'rejected') {
      logger.warn({ err: bm25Settled.reason }, 'BM25 search failed, degrading to vector only');
    }

    logger.debug({ vectorCount: vectorResults.length, bm25Count: bm25Results.length }, 'Raw search results');

    const hasChinese = /[\u4e00-\u9fff]/.test(opts.query);

    const fused = rrfFuse(vectorResults, bm25Results);
    if (fused.length === 0) {
      return {
        results: [], autoReplySuggested: false, total: 0,
        trace: {
          embedding_model: this.embedding?.modelName ?? 'disabled',
          vector_candidates: vectorResults.length,
          bm25_candidates: bm25Results.length,
          rrf_fused_count: 0,
          confidence_filtered: 0,
          auto_reply_suggested: false,
          bilingual_fts: hasChinese,
          search_time_ms: Date.now() - t0,
        },
      };
    }

    const maxRrf = fused[0].score;
    const candidateIds = fused.slice(0, opts.limit * 2).map(r => r.id);

    const items = await this.storage.getByIds(candidateIds);
    const itemMap = new Map(items.map(item => [item.id, item]));

    const isCodeQuery = queryLooksLikeCode(opts.query);
    const isOperationalQuery = queryLooksLikeOperational(opts.query);
    const results: KBSearchResult[] = [];
    let confidenceFilteredCount = 0;

    for (const { id, score } of fused) {
      const item = itemMap.get(id);
      if (!item) continue;

      const normalized = maxRrf > 0 ? score / maxRrf : 0;
      const confidence = computeConfidence(
        normalized,
        item.helpfulCount,
        item.unhelpfulCount,
        item.verifiedBy != null,
        {
          category: item.category,
          knowledgeType: item.knowledgeType,
          queryLooksLikeCode: isCodeQuery,
          queryLooksLikeOperational: isOperationalQuery,
        },
      );

      if (confidence < opts.minConfidence) {
        confidenceFilteredCount++;
        continue;
      }

      const totalFb = item.helpfulCount + item.unhelpfulCount;

      results.push({
        id: item.id,
        title: item.title,
        question: item.question,
        content: item.content,
        summary: item.summary,
        knowledgeType: item.knowledgeType,
        category: item.category,
        tags: item.tags,
        answerType: item.answerType,
        confidence,
        helpfulRatio: totalFb > 0 ? item.helpfulCount / totalFb : 0,
        verified: item.verifiedBy != null,
        media: item.media,
      });

      if (results.length >= opts.limit) break;
    }

    this.injectDiversity(results, fused, itemMap, isCodeQuery, isOperationalQuery, maxRrf, opts.minConfidence);

    this.storage.incrementQueryCount(results.map(r => r.id)).catch((err) => {
      logger.debug({ err }, 'incrementQueryCount 失败（非阻塞）');
    });

    const autoReplySuggested = results.length > 0 && results[0].confidence > 0.8;

    return {
      results,
      autoReplySuggested,
      total: fused.length,
      trace: {
        embedding_model: this.embedding?.modelName ?? 'disabled',
        vector_candidates: vectorResults.length,
        bm25_candidates: bm25Results.length,
        rrf_fused_count: fused.length,
        confidence_filtered: confidenceFilteredCount,
        auto_reply_suggested: autoReplySuggested,
        bilingual_fts: hasChinese,
        search_time_ms: Date.now() - t0,
      },
    };
  }

  /**
   * 当 top-K 全部为同一 knowledgeType 时，从候选池注入 1 条不同类型的结果。
   * 仅当末位 confidence < 0.6 时替换末位，否则追加（不超过 limit+1）。
   */
  private injectDiversity(
    results: KBSearchResult[],
    fused: Array<{ id: string; score: number }>,
    itemMap: Map<string, KnowledgeItem>,
    isCodeQuery: boolean,
    isOperationalQuery: boolean,
    maxRrf: number,
    minConfidence: number,
  ): void {
    if (results.length < 2) return;

    const dominantType = results[0].knowledgeType;
    const allSameType = results.every(r => r.knowledgeType === dominantType);
    if (!allSameType) return;

    const resultIds = new Set(results.map(r => r.id));

    for (const { id, score } of fused) {
      if (resultIds.has(id)) continue;
      const item = itemMap.get(id);
      if (!item || item.knowledgeType === dominantType) continue;

      const normalized = maxRrf > 0 ? score / maxRrf : 0;
      const confidence = computeConfidence(
        normalized,
        item.helpfulCount,
        item.unhelpfulCount,
        item.verifiedBy != null,
        {
          category: item.category,
          knowledgeType: item.knowledgeType,
          queryLooksLikeCode: isCodeQuery,
          queryLooksLikeOperational: isOperationalQuery,
        },
      );

      if (confidence < minConfidence) continue;

      const totalFb = item.helpfulCount + item.unhelpfulCount;
      const alt: KBSearchResult = {
        id: item.id,
        title: item.title,
        question: item.question,
        content: item.content,
        summary: item.summary,
        knowledgeType: item.knowledgeType,
        category: item.category,
        tags: item.tags,
        answerType: item.answerType,
        confidence,
        helpfulRatio: totalFb > 0 ? item.helpfulCount / totalFb : 0,
        verified: item.verifiedBy != null,
        media: item.media,
      };

      const lastResult = results[results.length - 1];
      if (lastResult.confidence < 0.6) {
        results[results.length - 1] = alt;
      } else {
        results.push(alt);
      }

      logger.debug(
        { dominant: dominantType, injected: item.knowledgeType, confidence },
        'Diversity injection: added alternate type',
      );
      return;
    }
  }
}
