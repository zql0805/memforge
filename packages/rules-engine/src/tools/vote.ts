// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { VoterRole } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';

const logger = getLogger('tool:vote');

export function registerVoteRule(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'vote_rule',
    '对编码规则投票。支持赞成(+1)、反对(-1)、弃权(0)。admin 对 security 规则有一票否决权。达到阈值后自动激活或拒绝。',
    {
      rule_id: z.string().describe('规则 ID'),
      vote: z.number().describe('投票: 1=赞成, -1=反对, 0=弃权'),
      comment: z.string().optional().describe('投票评论'),
    },
    async (params) => {
      try {
        if (![1, -1, 0].includes(params.vote)) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'vote 必须为 1、-1 或 0' }) }],
          };
        }

        if (!ctx.userId) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: '投票需要已认证的用户身份' }) }],
            isError: true,
          };
        }
        const userId = ctx.userId;
        const role = ctx.userRole as VoterRole;
        if (!role) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: '投票需要已认证的用户角色' }) }],
            isError: true,
          };
        }

        const result = await ctx.voteManager.castAndEvaluate(
          params.rule_id,
          userId,
          role,
          params.vote as -1 | 0 | 1,
          params.comment,
        );

        // 检查是否有超时投票需要处理
        const timeouts = await ctx.voteManager.checkTimeouts();

        logger.info({
          ruleId: params.rule_id,
          vote: params.vote,
          result: result.newStatus,
        }, '投票完成');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              ruleId: params.rule_id,
              voteRecorded: { userId, vote: params.vote },
              evaluation: {
                status: result.newStatus,
                weightedScore: result.weightedScore,
                totalVoters: result.totalVoters,
                vetoed: result.vetoed,
                vetoedBy: result.vetoedBy,
                needsMoreVotes: result.needsMoreVotes,
              },
              message: result.message,
              timeoutActions: timeouts.length > 0 ? timeouts : undefined,
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'vote_rule 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
