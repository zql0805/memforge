// Created by dev on 2026/06/05
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { KnowledgeType } from '@memforgeai/shared';
import type { KnowledgeToolContext } from './types.js';
import { resolveKnowledgeVisibilityFilters } from '../auth/visibility.js';

export function registerListKnowledge(server: McpServer, ctx: KnowledgeToolContext): void {
  server.tool(
    'list_knowledge',
    '分页列出知识条目，支持按类型、分类、产品线、状态等过滤。',
    {
      knowledge_type: KnowledgeType.optional().describe('按类型过滤: faq/troubleshooting/technical/how_to/runbook/project 等'),
      category: z.string().optional().describe('按分类路径过滤'),
      product_line: z.string().optional().describe('按产品线过滤'),
      project_id: z.string().optional().describe('按项目 ID 过滤'),
      status: z.string().optional().describe('按状态过滤: draft/published/archived'),
      search: z.string().optional().describe('关键词模糊搜索（标题+内容）'),
      page: z.number().optional().default(1),
      page_size: z.number().optional().default(20),
    },
    async (params) => {
      const visibilityFilters = await resolveKnowledgeVisibilityFilters(ctx, params.product_line);
      const result = await ctx.storage.list({
        knowledgeType: params.knowledge_type,
        category: params.category,
        productLine: params.product_line,
        projectId: params.project_id,
        status: params.status,
        search: params.search,
        page: params.page,
        pageSize: params.page_size,
        visibilityFilters,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );
}
