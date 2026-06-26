// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: start_work_context — 开始一个工作上下文（需求/Bug/重构/调研/学习）

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, buildProjectCascade } from '@memforgeai/shared';
import { autoLinkWorkContext } from '../services/auto-link.js';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:start-work-context');

const WORK_TYPE = z.enum(['requirement', 'bug_fix', 'refactor', 'investigation', 'learning']);

export function registerStartWorkContext(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'start_work_context',
    '开始一个工作上下文（需求开发/Bug修复/重构/调研/学习），自动搜索相关经验和规则。',
    {
      title: z.string().describe('工作标题（如"用户资料V2迁移"）'),
      type: WORK_TYPE.describe('工作类型'),
      description: z.string().optional().describe('详细描述'),
      projects: z.array(z.object({
        name: z.string(),
        branch: z.string().optional(),
      })).optional().describe('涉及的项目列表'),
      estimated_hours: z.number().optional().describe('预估工时（小时）'),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('优先级'),
      related_doc_urls: z.array(z.string()).optional().describe('相关文档链接'),
      product_line: z.string().optional().describe('产品线标识'),
      tags: z.array(z.string()).optional().describe('标签'),
    },
    async (params) => {
      try {
        const gitCtx = ctx.gitContext;
        const currentProject = gitCtx?.projectName ?? 'default';
        const currentBranch = gitCtx?.branchName ?? null;

        const initialProjects = params.projects?.map(p => ({
          name: p.name,
          branch: p.branch ?? null,
          files_changed: 0,
          lines_added: 0,
          lines_deleted: 0,
          commits: 0,
        })) ?? [{
          name: currentProject,
          branch: currentBranch,
          files_changed: 0,
          lines_added: 0,
          lines_deleted: 0,
          commits: 0,
        }];

        const resolvedProjectId = params.product_line ?? currentProject;
        const contentText = [
          `工作: ${params.title}`,
          `类型: ${params.type}`,
          params.description ? `描述: ${params.description}` : '',
          `涉及项目: ${initialProjects.map(p => p.name).join(', ')}`,
          `开始时间: ${new Date().toISOString()}`,
        ].filter(Boolean).join('\n');

        const embedding = await ctx.embedding.embedPassage(contentText);

        // 自动搜索相关经验
        const projectIds = buildProjectCascade(currentProject, params.product_line);
        const relatedMemories = await ctx.storage.searchByEmbedding(
          embedding, projectIds, null, 5, 0.5,
        );

        const relatedEntries = await Promise.all(
          relatedMemories.map(async r => {
            const e = await ctx.storage.getById(r.id);
            return e ? { id: e.id, title: e.title, scope: e.scope, similarity: r.similarity } : null;
          }),
        );
        const validRelated = relatedEntries.filter(Boolean);

        const entry = await ctx.storage.store({
          projectId: resolvedProjectId,
          branchId: null,
          title: `[${params.type}] ${params.title}`,
          content: contentText,
          scope: 'task_progress',
          source: 'manual',
          tags: [
            'work-context',
            params.type,
            'status:in_progress',
            ...(params.tags ?? []),
          ],
          embedding,
          metadata: {
            type: 'work_context',
            work_type: params.type,
            status: 'in_progress',
            started_at: new Date().toISOString(),
            completed_at: null,
            estimated_hours: params.estimated_hours ?? null,
            priority: params.priority ?? null,
            projects: initialProjects,
            documents: params.related_doc_urls ?? [],
            related_memories: validRelated.map(r => r!.id),
            source_project: currentProject,
            source_product_line: params.product_line ?? null,
            visibility: params.product_line ? 'product_line' : 'personal',
          },
          isArchived: false,
          archivedReason: null,
          createdBy: ctx.userId,
          expiresAt: null,
          orgId: ctx.orgId || null,
          teamId: null,
          visibility: 'personal',
        });

        logger.info({
          id: entry.id,
          type: params.type,
          projects: initialProjects.length,
          related: validRelated.length,
        }, '工作上下文已创建');

        // 后台异步建立知识关联（不阻塞返回）
        autoLinkWorkContext(entry.id, ctx.storage, ctx.embedding, projectIds).catch(err => {
          logger.warn({ err: String(err) }, '工作上下文自动关联失败（不影响主流程）');
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              context_id: entry.id,
              title: params.title,
              work_type: params.type,
              projects: initialProjects.map(p => p.name),
              related_memories: validRelated.map(r => ({
                id: r!.id,
                title: r!.title,
                scope: r!.scope,
                similarity: r!.similarity.toFixed(2),
              })),
              message: `工作上下文已创建。找到 ${validRelated.length} 条相关经验。`,
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'start_work_context 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
