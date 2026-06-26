// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';
import { canViewRule } from './rule-auth.js';

const logger = getLogger('tool:get-rule');

export function registerGetRule(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'get_rule',
    '获取单条编码规则的详细信息，包含投票状态和效果度量。',
    {
      rule_id: z.string().describe('规则 ID'),
    },
    async (params) => {
      try {
        const rule = await ctx.storage.getRuleById(params.rule_id);
        if (!rule) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: '规则不存在' }) }],
          };
        }

        if (!canViewRule(ctx, rule)) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: '规则不存在或无权访问' }) }],
          };
        }

        const votes = await ctx.storage.getVotesForRule(rule.id);
        const voteSummary = await ctx.storage.getVoteCount(rule.id);
        const recentEvents = await ctx.storage.getEventsByRule(rule.id, 10);

        const adoptionRate = (rule.acceptedCount + rule.rejectedCount) > 0
          ? rule.acceptedCount / (rule.acceptedCount + rule.rejectedCount)
          : null;

        logger.info({ ruleId: rule.id }, 'get_rule 查询完成');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              rule: {
                id: rule.id,
                projectId: rule.projectId,
                ruleType: rule.ruleType,
                title: rule.title,
                description: rule.description,
                rationale: rule.rationale,
                exampleGood: rule.exampleGood,
                exampleBad: rule.exampleBad,
                autoFix: rule.autoFix,
                category: rule.category,
                language: rule.language,
                severity: rule.severity,
                status: rule.status,
                source: rule.source,
                sourceRef: rule.sourceRef,
                metrics: {
                  appliedCount: rule.appliedCount,
                  violatedCount: rule.violatedCount,
                  acceptedCount: rule.acceptedCount,
                  rejectedCount: rule.rejectedCount,
                  adoptionRate: adoptionRate !== null ? Math.round(adoptionRate * 100) / 100 : null,
                },
                voting: {
                  summary: voteSummary,
                  votes: votes.map(v => ({
                    userId: v.userId,
                    role: v.role,
                    vote: v.vote === 1 ? 'approve' : v.vote === -1 ? 'reject' : 'abstain',
                    comment: v.comment,
                    createdAt: v.createdAt,
                  })),
                },
                recentEvents: recentEvents.map(e => ({
                  eventType: e.eventType,
                  filePath: e.filePath,
                  createdAt: e.createdAt,
                })),
                activatedAt: rule.activatedAt,
                deprecatedAt: rule.deprecatedAt,
                createdBy: rule.createdBy,
                createdAt: rule.createdAt,
                updatedAt: rule.updatedAt,
              },
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'get_rule 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
