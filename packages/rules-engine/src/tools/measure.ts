// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, buildProjectCascade } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';

const logger = getLogger('tool:measure');

const TIME_RANGE_MAP: Record<string, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  'all': 3650,
};

export function registerMeasureRules(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'measure_rules',
    '获取编码规则的效果度量数据：采纳率、违规趋势、覆盖率、建议废弃等。',
    {
      rule_id: z.string().optional().describe('指定规则 ID 查看单条规则度量，省略则返回全局概览'),
      time_range: z.string().optional().describe('时间范围: 7d/30d/90d/all（默认 30d）'),
    },
    async (params) => {
      try {
        const days = TIME_RANGE_MAP[params.time_range ?? '30d'] ?? 30;

        if (params.rule_id) {
          const ruleMetrics = await ctx.metrics.getRuleMetrics(params.rule_id, days);
          if (!ruleMetrics) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: '规则不存在' }) }],
            };
          }

          logger.info({ ruleId: params.rule_id }, '单条规则度量查询完成');

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                type: 'rule_detail',
                timeRange: params.time_range ?? '30d',
                metrics: ruleMetrics,
              }),
            }],
          };
        }

        const teamFilter = ctx.teamId
          ? { teamIds: [ctx.teamId], userId: ctx.userId ?? undefined }
          : undefined;
        const projectIds = buildProjectCascade(ctx.gitContext?.projectName);
        const overview = await ctx.metrics.getOverview(days, { teamFilter, projectIds });

        logger.info({ timeRange: params.time_range ?? '30d' }, '全局度量概览查询完成');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              type: 'overview',
              timeRange: params.time_range ?? '30d',
              overview,
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'measure_rules 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
