// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ListMemoriesInput, getLogger, getPool, buildProjectCascade } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { resolveVisibilityContext } from '../services/team-resolver.js';

const logger = getLogger('tool:list');

export function registerListMemories(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'list_memories',
    '列出当前项目/分支的记忆条目，支持分页和多维筛选。',
    {
      scope: z.string().optional().describe('按记忆类型过滤'),
      source: z.string().optional().describe('按来源过滤'),
      tags: z.array(z.string()).optional().describe('按标签过滤'),
      sort_by: z.string().optional().describe('排序方式: created_at/updated_at'),
      page: z.number().optional().describe('页码（从 1 开始）'),
      page_size: z.number().optional().describe('每页数量（默认 20，最大 100）'),
      product_line: z.string().optional().describe('按产品线过滤（如 "my-product"）'),
      cross_project: z.boolean().optional().describe('跨项目查询：忽略项目隔离，列出所有项目的记忆'),
      view_as_user: z.string().optional().describe('管理员查看指定用户的数据（仅 admin 角色可用）'),
      include_all_personal: z.boolean().optional().describe('包含所有用户的 personal 记忆（仅 super_admin 可用，WebUI 审计用途）'),
    },
    async (params) => {
      try {
        if (!ctx.userId) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                memories: [],
                total: 0,
                message: '未提供用户身份，无法查询记忆',
              }),
            }],
          };
        }

        const input = ListMemoriesInput.parse({
          scope: params.scope,
          source: params.source,
          tags: params.tags,
          sortBy: params.sort_by,
          page: params.page,
          pageSize: params.page_size,
        });

        const gitContext = ctx.gitContext;
        const projectIds = params.cross_project
          ? undefined
          : buildProjectCascade(gitContext?.projectName, params.product_line);
        const branchId = params.cross_project ? undefined : (gitContext?.branchName ?? null);

        // view_as_user 仅 admin 可用
        let createdByFilter: string | null | undefined;
        // task_progress（工作追踪）始终按用户隔离，admin/lead 也只看自己的工作
        const isPersonalScope = params.scope === 'task_progress';
        if (params.view_as_user) {
          if (ctx.userRole !== 'admin') {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'view_as_user 仅限 admin 角色使用。' }) }],
            };
          }
          createdByFilter = params.view_as_user;
        } else if (isPersonalScope) {
          createdByFilter = ctx.userId;
        } else if (ctx.userRole === 'admin' || ctx.userRole === 'lead') {
          createdByFilter = undefined;
        } else {
          createdByFilter = ctx.userId;
        }

        // 所有角色都经过 buildVisibilityClause，确保 team 级记忆的团队边界
        // 仅 superAdmin + include_all_personal 可完全跳过（WebUI 审计用途）
        const skipVisibility = params.include_all_personal && ctx.isSuperAdmin;
        let visibilityFilters: { userId: string | null; teamIds: string[]; accessibleProductLines: string[] } | undefined;
        if (!skipVisibility && ctx.userId) {
          const visCtx = await resolveVisibilityContext(ctx.userId, ctx.orgId ?? null, ctx.teamId ?? null);
          visibilityFilters = {
            userId: visCtx.userId,
            teamIds: visCtx.teamIds,
            accessibleProductLines: visCtx.accessibleProductLines,
          };
        }

        const { entries, total } = await ctx.storage.list({
          projectIds,
          branchId,
          scope: input.scope,
          source: input.source,
          tags: input.tags,
          sortBy: input.sortBy,
          limit: input.pageSize,
          offset: (input.page - 1) * input.pageSize,
          createdBy: createdByFilter,
          includeLegacy: !isPersonalScope,
          ...(visibilityFilters
            ? { visibilityFilters }
            : { visibilityUserId: null }),
        });

        logger.info({ projectIds, total, page: input.page }, 'list_memories 查询完成');

        // 批量查询创建者用户名
        let userNameMap: Map<string, string> | null = null;
        const creatorIds = [...new Set(entries.map(e => e.createdBy).filter(Boolean))] as string[];
        if (creatorIds.length > 0) {
          try {
            const pool = getPool();
            const placeholders = creatorIds.map((_, i) => `$${i + 1}`).join(', ');
            const { rows } = await pool.query<{ id: string; display_name: string | null; external_id: string }>(
              `SELECT id, display_name, external_id FROM memory.users WHERE id IN (${placeholders})`,
              creatorIds,
            );
            userNameMap = new Map(rows.map(r => [r.id, r.external_id]));
          } catch {
            logger.debug('查询创建者用户名失败，降级显示 ID');
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              project: projectIds,
              branch: branchId,
              entries: entries.map(e => ({
                id: e.id,
                title: e.title,
                content: e.content,
                scope: e.scope,
                source: e.source,
                tags: e.tags,
                projectId: e.projectId,
                metadata: e.metadata,
                visibility: e.visibility,
                isArchived: e.isArchived,
                createdBy: e.createdBy,
                createdByName: userNameMap?.get(e.createdBy ?? '') ?? undefined,
                createdAt: e.createdAt,
                updatedAt: e.updatedAt,
              })),
              pagination: {
                page: input.page,
                pageSize: input.pageSize,
                total,
                totalPages: Math.ceil(total / input.pageSize),
              },
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'list_memories 执行失败');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: String(error) }),
          }],
          isError: true,
        };
      }
    },
  );
}
