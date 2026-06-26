// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, buildProjectCascade, getPool, RuleCategory, RuleStatus, RuleSeverity } from '@memforgeai/shared';
import type { RuleType } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';

const logger = getLogger('tool:list-rules');

export function registerListRules(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'list_rules',
    '浏览和管理规范列表（分页）。若需在代码修改前加载全部生效规范，请改用 get_system_rules 工具。',
    {
      status: RuleStatus.optional().describe('按状态过滤: candidate/voting/active/deprecated/rejected'),
      category: RuleCategory.optional().describe('按分类过滤: security/performance/style/logic/convention/architecture'),
      language: z.string().optional().describe('按语言过滤: php/java/go 等'),
      severity: RuleSeverity.optional().describe('按严重级别过滤: critical/error/warning/info'),
      page: z.number().optional().describe('页码（默认 1）'),
      page_size: z.number().optional().describe('每页数量（默认 50，最大 200）'),
      product_line: z.string().optional().describe('按产品线过滤'),
      cross_project: z.boolean().optional().describe('跨项目查询：忽略项目隔离，列出所有项目的规则'),
      rule_types: z.array(z.enum(['coding', 'ai_agent', 'workflow', 'business', 'infra'])).optional().describe(
        '按 rule_type 过滤（可多选）；不传则不限',
      ),
      search: z.string().optional().describe('关键词搜索（模糊匹配标题和描述）'),
      sort_by: z.enum(['created_at', 'updated_at']).optional().describe('排序字段（默认 created_at）'),
    },
    async (params) => {
      try {
        const isAdmin = ctx.userRole === 'admin';

        let projectIds: string[] | undefined;
        if (isAdmin) {
          projectIds = params.cross_project
            ? undefined
            : buildProjectCascade(ctx.gitContext?.projectName, params.product_line);
        } else if (params.cross_project) {
          if (ctx.teamId) {
            const accessiblePLs = await ctx.storage.getUserAccessibleProductLines(ctx.teamId);
            projectIds = ['_global_', ...accessiblePLs];
            if (ctx.gitContext?.projectName) projectIds.push(ctx.gitContext.projectName);
          }
        } else {
          projectIds = buildProjectCascade(ctx.gitContext?.projectName, params.product_line);
        }
        const page = params.page ?? 1;
        const pageSize = Math.min(params.page_size ?? 50, 200);

        const teamFilter = (!isAdmin && ctx.userId) ? {
          teamIds: ctx.teamId ? [ctx.teamId] : undefined,
          userId: ctx.userId,
        } : undefined;

        const { rules, total } = await ctx.storage.listRules({
          projectIds,
          status: params.status,
          category: params.category,
          ruleTypes: params.rule_types as RuleType[] | undefined,
          language: params.language,
          severity: params.severity,
          search: params.search,
          sortBy: params.sort_by ?? 'created_at',
          limit: pageSize,
          offset: (page - 1) * pageSize,
          teamFilter,
        });

        // 批量查询创建者用户名
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const allCreatorIds = [...new Set(rules.map(r => r.createdBy).filter(Boolean))] as string[];
        const uuidIds = allCreatorIds.filter(id => uuidRegex.test(id));
        // 非 UUID 的 created_by（如 "dev"、"test-user-1"）直接用作显示名
        const userNameMap = new Map<string, string>(
          allCreatorIds.filter(id => !uuidRegex.test(id)).map(id => [id, id]),
        );
        if (uuidIds.length > 0) {
          try {
            const pool = getPool();
            const placeholders = uuidIds.map((_, i) => `$${i + 1}`).join(', ');
            const { rows } = await pool.query<{ id: string; name: string }>(
              `SELECT id, COALESCE(NULLIF(external_id, ''), display_name, id::text) AS name
               FROM memory.users WHERE id IN (${placeholders})`,
              uuidIds,
            );
            for (const r of rows) userNameMap.set(r.id, r.name);
          } catch {
            logger.debug('查询创建者用户名失败，降级显示 ID');
          }
        }

        const items = rules.map(r => ({
          id: r.id,
          title: r.title,
          description: r.description,
          ruleType: r.ruleType,
          category: r.category,
          language: r.language,
          severity: r.severity,
          status: r.status,
          projectId: r.projectId,
          visibility: r.visibility,
          source: r.source,
          sourceRef: r.sourceRef,
          appliedCount: r.appliedCount,
          violatedCount: r.violatedCount,
          createdBy: r.createdBy,
          createdByName: r.createdBy ? (userNameMap.get(r.createdBy) ?? null) : null,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }));

        logger.info({ total, page, pageSize }, 'list_rules 查询完成');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              rules: items,
              pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'list_rules 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
