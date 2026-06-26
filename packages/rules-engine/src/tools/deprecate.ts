// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';
import { canModifyRule } from './rule-auth.js';

const logger = getLogger('tool:deprecate');

export function registerDeprecateRule(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'deprecate_rule',
    '废弃一条编码规则。active/candidate/voting 状态的规则可以被废弃，需说明理由。',
    {
      rule_id: z.string().describe('规则 ID'),
      reason: z.string().describe('废弃理由'),
      deprecated_by: z.string().optional().describe('操作人 ID'),
    },
    async (params) => {
      try {
        const rule = await ctx.storage.getRuleById(params.rule_id);
        if (!rule) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: '规则不存在' }) }],
          };
        }

        const deprecatableStatuses = ['active', 'candidate', 'voting'];
        if (!deprecatableStatuses.includes(rule.status)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `仅 active/candidate/voting 状态的规则可废弃，当前状态: ${rule.status}`,
              }),
            }],
          };
        }

        if (!canModifyRule(ctx, rule.createdBy)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: '无权废弃此规则，仅 admin/lead 或规则创建者可操作。',
              }),
            }],
          };
        }

        await ctx.storage.updateRuleStatus(params.rule_id, 'deprecated');

        logger.info({ ruleId: params.rule_id, reason: params.reason, previousStatus: rule.status }, '规则已废弃');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              id: rule.id,
              title: rule.title,
              previousStatus: rule.status,
              newStatus: 'deprecated',
              reason: params.reason,
              message: '规则已废弃，不再在 enforce_rules 中生效。',
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'deprecate_rule 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
