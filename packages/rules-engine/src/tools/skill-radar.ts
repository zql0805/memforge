// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: get_skill_radar — 获取技能雷达图数据

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';
import { resolveSkillUserId } from './rule-auth.js';

const logger = getLogger('tool:skill-radar');

export function registerGetSkillRadar(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'get_skill_radar',
    '获取用户的技能雷达图数据，包括各技能当前等级和置信度',
    {
      user_id: z.string().optional().describe('用户 ID（省略则使用默认用户）'),
      category: z.string().optional().describe('技能类别过滤'),
    },
    async ({ user_id, category }) => {
      const effectiveUserId = resolveSkillUserId(ctx, user_id);

      const radar = await ctx.skillStore.getSkillRadar(effectiveUserId, category);

      if (radar.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              userId: effectiveUserId,
              averageLevel: 0,
              skillCount: 0,
              skills: [],
              hint: '暂无技能数据。使用 record_milestone 记录技能成长事件来建立技能档案。',
            }, null, 2),
          }],
        };
      }

      const avgLevel = radar.reduce((s, p) => s + p.level, 0) / radar.length;

      const result = {
        success: true as const,
        userId: effectiveUserId,
        averageLevel: Math.round(avgLevel * 10) / 10,
        skillCount: radar.length,
        skills: radar.map((p) => ({
          name: p.skill,
          level: p.level,
          maxLevel: p.maxLevel,
          confidence: Math.round(p.confidence * 100) + '%',
          bar: '█'.repeat(p.level) + '░'.repeat(p.maxLevel - p.level),
        })),
      };

      logger.info({ userId: effectiveUserId, skillCount: radar.length }, '技能雷达查询');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );
}
