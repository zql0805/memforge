// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: get_team_matrix — 团队技能矩阵

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';
import { isAdminOrLead } from './rule-auth.js';

const logger = getLogger('tool:team-matrix');

export function registerGetTeamMatrix(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'get_team_matrix',
    '获取团队技能矩阵，展示每位成员在各技能上的水平及团队能力缺口',
    {
      org_id: z.string().optional().describe('组织 ID'),
      category: z.string().optional().describe('技能类别过滤'),
    },
    async ({ org_id, category }) => {
      if (!isAdminOrLead(ctx)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'get_team_matrix 仅限 admin/lead 角色调用',
            }, null, 2),
          }],
        };
      }

      const orgId = org_id ?? ctx.orgId ?? '00000000-0000-0000-0000-000000000001';

      const matrix = await ctx.skillStore.getTeamMatrix(orgId, category);

      logger.info({
        org: orgId,
        memberCount: matrix.members.length,
        gapCount: matrix.gaps.length,
      }, '团队矩阵查询');

      const payload =
        matrix.members.length === 0
          ? {
              success: true as const,
              ...matrix,
              hint: '暂无团队成员数据。请先通过 Gateway 注册用户。',
            }
          : { success: true as const, ...matrix };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(payload, null, 2),
        }],
      };
    },
  );
}
