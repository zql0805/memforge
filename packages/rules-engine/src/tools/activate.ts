// Created by dev on 2026/04/11
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';

const logger = getLogger('tool:activate');

const ACTIVATABLE_STATUSES = new Set(['candidate', 'voting', 'deprecated']);

export function registerActivateRule(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'activate_rule',
    '直接激活一条规则（跳过投票流程）。支持从 candidate / voting / deprecated 状态激活为 active。仅限 admin / lead 角色。',
    {
      rule_id: z.string().describe('规则 ID'),
      reason: z.string().optional().describe('激活理由'),
    },
    async (params) => {
      try {
        if (ctx.userRole !== 'admin' && ctx.userRole !== 'lead') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: '直接激活仅限 admin/lead 角色，当前角色无权执行此操作。',
              }),
            }],
          };
        }

        const rule = await ctx.storage.getRuleById(params.rule_id);
        if (!rule) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: '规则不存在' }) }],
          };
        }

        if (rule.status === 'active') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: true, message: '规则已处于 active 状态，无需操作。' }),
            }],
          };
        }

        if (!ACTIVATABLE_STATUSES.has(rule.status)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `当前状态 ${rule.status} 不支持直接激活，仅 candidate/voting/deprecated 可激活。`,
              }),
            }],
          };
        }

        const previousStatus = rule.status;
        await ctx.storage.updateRuleStatus(params.rule_id, 'active');

        logger.info(
          { ruleId: params.rule_id, previousStatus, reason: params.reason },
          '规则已直接激活',
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              id: rule.id,
              title: rule.title,
              previousStatus,
              newStatus: 'active',
              reason: params.reason ?? null,
              message: `规则已从 ${previousStatus} 激活为 active，将在 enforce_rules 中生效。`,
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'activate_rule 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
