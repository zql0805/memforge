// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: evaluate_work_context — 完成工作上下文并生成评价报告

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { getLogger, buildProjectCascade } from '@memforgeai/shared';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';
import { autoLinkWorkContext, linkLessonToContext } from '../services/auto-link.js';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:evaluate-work-context');

interface ProjectStat {
  name: string;
  branch: string | null;
  files_changed: number;
  lines_added: number;
  lines_deleted: number;
  commits: number;
}

export function registerEvaluateWorkContext(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'evaluate_work_context',
    '完成一个工作上下文并生成评价报告。自动收集最终 git 统计、沉淀经验教训。',
    {
      context_id: z.string().describe('工作上下文 ID'),
      outcome: z.enum(['completed', 'cancelled', 'deferred']).describe('结果'),
      summary: z.string().optional().describe('完成总结'),
      lessons: z.array(z.string()).optional().describe('经验教训（每条自动存为独立记忆）'),
      project_roots: z.record(z.string()).optional().describe(
        '项目名到本地路径的映射（如 {"my-api": "/Users/xxx/my-api"}），用于收集最终 git 统计',
      ),
      manual_git_stats: z.record(z.object({
        files_changed: z.number(),
        lines_added: z.number(),
        lines_deleted: z.number(),
        commits: z.number(),
        branch: z.string().optional(),
      })).optional().describe(
        '手动传入各项目 git 统计（key 为项目名），优先级高于服务端自动采集。' +
        '当服务端无法访问本地仓库路径时，由 AI 在本地执行 git 命令后传入。',
      ),
    },
    async (params) => {
      try {
        const existing = await ctx.storage.getById(params.context_id);
        if (!existing) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: `工作上下文 ${params.context_id} 不存在` }),
            }],
          };
        }

        if (ctx.userId && existing.createdBy && existing.createdBy !== ctx.userId && ctx.userRole !== 'admin') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: '无权评价他人的工作上下文。' }),
            }],
          };
        }

        const metadata = { ...(existing.metadata as Record<string, unknown>) };
        const projects: ProjectStat[] = (metadata.projects as ProjectStat[]) ?? [];
        const now = new Date().toISOString();

        // 收集最终 git 统计（服务端自动采集）
        if (params.project_roots) {
          for (const proj of projects) {
            const root = params.project_roots[proj.name];
            if (!root) continue;
            const stats = collectFinalStats(root);
            if (stats) {
              proj.files_changed = stats.filesChanged;
              proj.lines_added = stats.linesAdded;
              proj.lines_deleted = stats.linesDeleted;
              proj.commits = stats.commits;
            }
          }
        }

        // 手动传入 git 统计（优先级高于服务端自动采集）
        if (params.manual_git_stats) {
          for (const [projName, stats] of Object.entries(params.manual_git_stats)) {
            const proj = projects.find(p => p.name === projName);
            if (proj) {
              proj.files_changed = stats.files_changed;
              proj.lines_added = stats.lines_added;
              proj.lines_deleted = stats.lines_deleted;
              proj.commits = stats.commits;
              if (stats.branch) proj.branch = stats.branch;
            } else {
              projects.push({
                name: projName,
                branch: stats.branch ?? null,
                files_changed: stats.files_changed,
                lines_added: stats.lines_added,
                lines_deleted: stats.lines_deleted,
                commits: stats.commits,
              });
            }
          }
        }

        // 计算持续时间
        const startedAt = metadata.started_at as string;
        const durationMs = new Date(now).getTime() - new Date(startedAt).getTime();
        const durationHours = Math.round(durationMs / 3600000 * 10) / 10;

        // 统计汇总
        const totalFiles = projects.reduce((s, p) => s + p.files_changed, 0);
        const totalAdded = projects.reduce((s, p) => s + p.lines_added, 0);
        const totalDeleted = projects.reduce((s, p) => s + p.lines_deleted, 0);
        const totalCommits = projects.reduce((s, p) => s + p.commits, 0);

        // 搜索关联的记忆数量
        const relatedMemoryIds = (metadata.related_memories as string[]) ?? [];

        // 更新 metadata
        metadata.status = params.outcome;
        metadata.completed_at = now;
        metadata.projects = projects;
        metadata.evaluation = {
          duration_hours: durationHours,
          total_files_changed: totalFiles,
          total_lines_added: totalAdded,
          total_lines_deleted: totalDeleted,
          total_commits: totalCommits,
          memories_referenced: relatedMemoryIds.length,
          lessons_generated: params.lessons?.length ?? 0,
          outcome: params.outcome,
        };

        // 更新 content
        let content = existing.content;
        if (params.summary) {
          content += `\n\n--- 完成总结 ---\n${params.summary}`;
        }
        content += `\n\n状态: ${params.outcome} | 耗时: ${durationHours}h | 文件: ${totalFiles} | +${totalAdded}/-${totalDeleted}`;

        // 更新 tags
        const tags = (existing.tags ?? []).filter(t => !t.startsWith('status:'));
        tags.push(`status:${params.outcome}`);

        await ctx.storage.update(params.context_id, { content, metadata, tags });

        // 自动沉淀经验教训
        const storedLessons: string[] = [];
        if (params.lessons && params.lessons.length > 0) {
          const productLine = metadata.source_product_line as string | undefined;
          for (const lesson of params.lessons) {
            const lessonTitle = lesson.length > 80 ? lesson.slice(0, 77) + '...' : lesson;
            const lessonContent = `[来自工作: ${existing.title}]\n\n${lesson}`;
            const lessonEmb = await ctx.embedding.embedPassage(lessonContent);

            const dup = await ctx.storage.checkDuplicate(lessonEmb, 0.88);
            if (!dup) {
              const lessonScope = detectLessonScope(lesson);
              const resolvedId = lessonScope === 'coding_standard' ? '_global_' : (productLine ?? existing.projectId);

              const entry = await ctx.storage.store({
                projectId: resolvedId,
                branchId: null,
                title: `[经验] ${lessonTitle}`,
                content: lessonContent,
                scope: lessonScope,
                source: 'ai_suggestion' as MemorySource,
                tags: ['from-work-context', metadata.work_type as string, `context:${params.context_id.slice(0, 8)}`],
                embedding: lessonEmb,
                metadata: {
                  source_project: metadata.source_project,
                  source_product_line: productLine ?? null,
                  visibility: lessonScope === 'coding_standard' ? 'global' : 'product_line',
                  work_context_id: params.context_id,
                },
                isArchived: false,
                archivedReason: null,
                createdBy: ctx.userId,
                expiresAt: null,
                orgId: ctx.orgId || null,
                teamId: null,
                visibility: 'personal',
              });
              storedLessons.push(entry.id);

              // 建立 produced 关系
              await linkLessonToContext(params.context_id, entry.id);
            }
          }
        }

        const report = {
          success: true,
          context_id: params.context_id,
          title: existing.title,
          outcome: params.outcome,
          duration: {
            started_at: startedAt,
            completed_at: now,
            total_hours: durationHours,
          },
          projects: projects.map(p => ({
            name: p.name,
            branch: p.branch,
            files_changed: p.files_changed,
            lines_added: p.lines_added,
            lines_deleted: p.lines_deleted,
            commits: p.commits,
          })),
          totals: {
            files_changed: totalFiles,
            lines_added: totalAdded,
            lines_deleted: totalDeleted,
            commits: totalCommits,
          },
          memories_referenced: relatedMemoryIds.length,
          lessons_stored: storedLessons.length,
          message: `工作上下文已${params.outcome === 'completed' ? '完成' : '关闭'}。` +
            `耗时 ${durationHours}h，变更 ${totalFiles} 文件，沉淀 ${storedLessons.length} 条经验。`,
        };

        logger.info({
          id: params.context_id,
          outcome: params.outcome,
          hours: durationHours,
          lessons: storedLessons.length,
        }, '工作上下文评价完成');

        // 后台异步更新知识关联（含新产出的经验）
        const projectIds = buildProjectCascade(
          metadata.source_project as string | undefined,
          metadata.source_product_line as string | undefined,
        );
        autoLinkWorkContext(params.context_id, ctx.storage, ctx.embedding, projectIds).catch(err => {
          logger.warn({ err: String(err) }, '评价后自动关联失败（不影响主流程）');
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(report) }],
        };
      } catch (error) {
        logger.error({ error }, 'evaluate_work_context 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}

function detectLessonScope(lesson: string): MemoryScope {
  const lower = lesson.toLowerCase();
  if (lower.includes('安全') || lower.includes('security') || lower.includes('xss') || lower.includes('sql')) {
    return 'coding_standard';
  }
  if (lower.includes('性能') || lower.includes('performance') || lower.includes('slow')) {
    return 'performance_insight';
  }
  if (lower.includes('架构') || lower.includes('architecture') || lower.includes('重构')) {
    return 'architecture';
  }
  return 'lesson_learned';
}

function collectFinalStats(cwd: string): {
  filesChanged: number; linesAdded: number; linesDeleted: number; commits: number;
} | null {
  try {
    let baseBranch = 'origin/master';
    try {
      execFileSync('git', ['rev-parse', '--verify', 'origin/master'], { cwd, encoding: 'utf-8' });
    } catch {
      try {
        execFileSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd, encoding: 'utf-8' });
        baseBranch = 'origin/main';
      } catch {
        return null;
      }
    }

    const numstat = execFileSync(
      'git', ['diff', '--numstat', `${baseBranch}...HEAD`],
      { cwd, encoding: 'utf-8', timeout: 10000 },
    ).trim();

    let filesChanged = 0, linesAdded = 0, linesDeleted = 0;
    if (numstat) {
      for (const line of numstat.split('\n')) {
        const [added, deleted] = line.split('\t');
        filesChanged++;
        linesAdded += parseInt(added, 10) || 0;
        linesDeleted += parseInt(deleted, 10) || 0;
      }
    }

    const commitCount = execFileSync(
      'git', ['rev-list', '--count', `${baseBranch}..HEAD`],
      { cwd, encoding: 'utf-8', timeout: 5000 },
    ).trim();

    return { filesChanged, linesAdded, linesDeleted, commits: parseInt(commitCount, 10) || 0 };
  } catch {
    return null;
  }
}
