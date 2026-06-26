// Created by dev on 2026/06/05
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { KnowledgeToolContext } from './types.js';

export function registerKnowledgeStats(server: McpServer, ctx: KnowledgeToolContext): void {
  server.tool(
    'knowledge_stats',
    '获取知识库统计数据：条目总数、分类分布、类型分布、最近更新等。',
    {
      product_line: z.string().optional().describe('按产品线过滤统计'),
    },
    async (params) => {
      const stats = await ctx.storage.getStats(params.product_line);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(stats) }],
      };
    },
  );
}
