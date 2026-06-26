// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLogger, buildProjectCascade } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';
import { buildVisibilityTeamFilter } from './rule-auth.js';

const logger = getLogger('resource:active-rules');

export function registerActiveRulesResource(server: McpServer, ctx: RulesToolContext): void {
  server.resource(
    'rules-active',
    'memory://rules/active',
    {
      description: '当前项目所有生效的编码规则列表',
      mimeType: 'application/json',
    },
    async () => {
      const projectIds = buildProjectCascade(ctx.gitContext?.projectName);
      const teamFilter = buildVisibilityTeamFilter(ctx);
      const activeRules = await ctx.storage.getActiveRules(projectIds, undefined, teamFilter);

      const rules = activeRules.map(r => ({
        id: r.id,
        title: r.title,
        description: r.description,
        category: r.category,
        language: r.language,
        severity: r.severity,
        exampleGood: r.exampleGood,
        exampleBad: r.exampleBad,
        autoFix: r.autoFix,
      }));

      logger.debug({ count: rules.length, projectIds }, '活跃规则资源已读取');

      return {
        contents: [{
          uri: 'memory://rules/active',
          mimeType: 'application/json',
          text: JSON.stringify({ project: projectIds, rules, total: rules.length }),
        }],
      };
    },
  );
}
