// Created by dev on 2026/05/21
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveVisibilityContext } from '@memforgeai/shared';
import type { KnowledgeToolContext } from './types.js';
import type { HybridSearchEngine } from '../search/hybrid-engine.js';

export function registerSearchKnowledge(server: McpServer, ctx: KnowledgeToolContext, engine: HybridSearchEngine): void {
  server.tool(
    'search_knowledge',
    'Search knowledge base using hybrid BM25 + vector retrieval',
    {
      query: z.string().describe('Search query'),
      project_id: z.string().optional().describe('Project ID filter'),
      product_line: z.string().optional().describe('Product line filter'),
      knowledge_type: z.string().optional().describe('Knowledge type filter'),
      category: z.string().optional().describe('Category filter'),
      limit: z.number().optional().describe('Max results (default 5)'),
      min_confidence: z.number().optional().describe('Minimum confidence threshold'),
    },
    async (params) => {
      try {
        const projectIds = params.project_id ? [params.project_id] : [];

        let visibilityFilters;
        if (ctx.userId) {
          if (params.product_line) {
            visibilityFilters = {
              userId: ctx.userId,
              orgId: ctx.orgId ?? null,
              teamIds: ctx.teamId ? [ctx.teamId] : [],
              accessibleProductLines: [params.product_line],
            };
          } else {
            const visCtx = await resolveVisibilityContext(ctx.userId, ctx.orgId ?? null, ctx.teamId ?? null);
            visibilityFilters = {
              userId: visCtx.userId,
              orgId: visCtx.orgId,
              teamIds: visCtx.teamIds,
              accessibleProductLines: visCtx.accessibleProductLines,
            };
          }
        }

        const result = await engine.search({
          query: params.query,
          projectIds,
          productLine: params.product_line,
          knowledgeType: params.knowledge_type,
          category: params.category,
          limit: params.limit ?? 5,
          minConfidence: params.min_confidence ?? 0.3,
          visibilityFilters,
        });
        const output = {
          ...result,
          trace: {
            method: 'hybrid_bm25_vector',
            candidateCount: result.total,
            returnedCount: result.results.length,
            minConfidence: params.min_confidence ?? 0.3,
          },
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }],
          isError: true,
        };
      }
    },
  );
}
