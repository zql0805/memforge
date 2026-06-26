// Created by dev on 2026/04/13
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';

const logger = getLogger('tool:delete');

export function registerDeleteRule(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'delete_rule',
    '永久删除一条编码规则。仅 deprecated 状态的规则可以被删除，且需要 admin 角色。此操作不可撤销。',
    {
      rule_id: z.string().describe('规则 ID'),
      reason: z.string().describe('删除原因'),
    },
    async (params) => {
      try {
        if (ctx.userRole !== 'admin') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: '仅 admin 角色可执行删除操作' }),
            }],
          };
        }

        const rule = await ctx.storage.getRuleById(params.rule_id);
        if (!rule) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: '规则不存在' }) }],
          };
        }

        if (rule.status !== 'deprecated') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `仅 deprecated 状态的规则可删除，当前状态: ${rule.status}。请先废弃再删除。`,
              }),
            }],
          };
        }

        const deleted = await ctx.storage.deleteRule(params.rule_id);

        logger.info({ ruleId: params.rule_id, title: rule.title, reason: params.reason }, '规则已永久删除');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: deleted,
              id: rule.id,
              title: rule.title,
              reason: params.reason,
              message: deleted ? '规则已永久删除。' : '删除失败。',
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'delete_rule 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
