// Created by dev on 2026/06/04
// knowledge_feedback MCP 工具 — 对知识条目提交反馈（有用/无用）

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { KnowledgeToolContext } from './types.js';

const logger = getLogger('knowledge:feedback');

export function registerKnowledgeFeedback(server: McpServer, ctx: KnowledgeToolContext): void {
  server.tool(
    'knowledge_feedback',
    '对知识条目提交反馈（有用/无用），帮助优化搜索排序和知识质量。当 AI 引用了某条知识后，可根据实际效果提交反馈。',
    {
      knowledge_id: z.string().describe('知识条目 ID'),
      helpful: z.boolean().describe('该条目是否有帮助'),
      ticket_id: z.string().optional().describe('关联的工单 ID（可选）'),
      comment: z.string().optional().describe('反馈备注（可选）'),
    },
    async (params) => {
      try {
        if (!ctx.userId) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: '未认证用户无法提交反馈' }) }],
            isError: true,
          };
        }
        await ctx.storage.storeFeedback(params.knowledge_id, params.helpful, {
          ticketId: params.ticket_id,
          comment: params.comment,
          createdBy: ctx.userId,
        });

        logger.info({ knowledgeId: params.knowledge_id, helpful: params.helpful }, 'feedback submitted');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, message: `反馈已记录：${params.helpful ? '有用' : '无用'}` }),
          }],
        };
      } catch (err) {
        logger.error({ err, knowledgeId: params.knowledge_id }, 'feedback submission failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }],
          isError: true,
        };
      }
    },
  );
}
