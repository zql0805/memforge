// Created by dev on 2026/06/02
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, resolveVisibilityContext } from '@memforgeai/shared';
import type { KnowledgeToolContext } from './types.js';
import type { HybridSearchEngine } from '../search/hybrid-engine.js';
import { assembleCodeContext } from '../search/code-context-assembler.js';

const logger = getLogger('knowledge:code-context');

const MAX_OUTPUT_CHARS = 15000;
const SEARCH_LIMIT = 12;
const MIN_CONFIDENCE = 0.3;

export function registerCodeContext(server: McpServer, ctx: KnowledgeToolContext, engine: HybridSearchEngine): void {
  server.tool(
    'code_context',
    '查询某个业务功能/模块的代码实现：返回项目概览、核心类、方法签名、调用关系。当用户问"XX 功能的代码在哪"或"这个业务怎么实现的"时优先使用。',
    {
      query: z.string().describe('自然语言查询（如 "user-service 的用户注册流程"）'),
      product_line: z.string().optional().describe('产品线过滤'),
      project_id: z.string().optional().describe('项目 ID 过滤'),
      max_chars: z.number().optional().describe(`输出字符上限，默认 ${MAX_OUTPUT_CHARS}`),
    },
    async (params) => {
      try {
        const maxChars = params.max_chars ?? MAX_OUTPUT_CHARS;
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
          category: undefined,
          knowledgeType: undefined,
          limit: SEARCH_LIMIT,
          minConfidence: MIN_CONFIDENCE,
          visibilityFilters,
        });

        if (result.results.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `未找到与 "${params.query}" 相关的代码知识。\n\n建议：\n- 尝试更具体的查询（如包含服务名、类名）\n- 确认 deep-index 已为目标项目生成知识条目`,
            }],
          };
        }

        const assembled = assembleCodeContext(params.query, result.results, maxChars);

        return {
          content: [{
            type: 'text' as const,
            text: assembled.markdown,
          }],
        };
      } catch (err) {
        logger.error({ err }, 'code_context failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }],
          isError: true,
        };
      }
    },
  );
}
