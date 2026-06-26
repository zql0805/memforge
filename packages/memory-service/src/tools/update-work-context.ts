// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: update_work_context — 更新工作上下文（追加项目/文档/进度，自动收集 git 统计）

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { getLogger } from '@memforgeai/shared';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:update-work-context');

interface ProjectStat {
  name: string;
  branch: string | null;
  files_changed: number;
  lines_added: number;
  lines_deleted: number;
  commits: number;
}

export function registerUpdateWorkContext(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'update_work_context',
    '更新工作上下文：追加涉及的项目、文档，自动收集 git 变更统计。',
    {
      context_id: z.string().describe('工作上下文 ID'),
      add_project: z.object({
        name: z.string(),
        branch: z.string().optional(),
        project_root: z.string().optional().describe('项目根目录绝对路径（用于 git 统计）'),
      }).optional().describe('追加一个涉及的项目'),
      add_documents: z.array(z.string()).optional().describe('追加文档链接'),
      progress_note: z.string().optional().describe('进度备注'),
      collect_git_stats: z.boolean().default(false).describe('是否让服务端自动收集 git 统计（仅当服务端与本地仓库同机时有效，否则请使用 manual_git_stats）'),
      manual_git_stats: z.record(z.object({
        files_changed: z.number(),
        lines_added: z.number(),
        lines_deleted: z.number(),
        commits: z.number(),
        branch: z.string().optional(),
      })).optional().describe(
        '手动传入 git 统计（key 为项目名）。当服务端无法访问本地路径时由 AI 在本地执行 git 命令后传入。' +
        '示例：{"my-api": {"files_changed": 5, "lines_added": 100, "lines_deleted": 20, "commits": 3}}',
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
              text: JSON.stringify({ success: false, error: '无权修改他人的工作上下文。' }),
            }],
          };
        }

        const metadata = { ...(existing.metadata as Record<string, unknown>) };
        const projects: ProjectStat[] = (metadata.projects as ProjectStat[]) ?? [];
        const documents: string[] = (metadata.documents as string[]) ?? [];

        if (params.add_project) {
          const existingIdx = projects.findIndex(p => p.name === params.add_project!.name);
          if (existingIdx < 0) {
            projects.push({
              name: params.add_project.name,
              branch: params.add_project.branch ?? ctx.gitContext?.branchName ?? null,
              files_changed: 0,
              lines_added: 0,
              lines_deleted: 0,
              commits: 0,
            });
          }

          if (params.collect_git_stats) {
            const cwd = params.add_project.project_root ?? process.cwd();
            const targetIdx = existingIdx >= 0 ? existingIdx : projects.length - 1;
            const stats = collectGitStats(cwd);
            if (stats) {
              projects[targetIdx].files_changed = stats.filesChanged;
              projects[targetIdx].lines_added = stats.linesAdded;
              projects[targetIdx].lines_deleted = stats.linesDeleted;
              projects[targetIdx].commits = stats.commits;
              if (!projects[targetIdx].branch) {
                projects[targetIdx].branch = stats.branch;
              }
            }
          }
        }

        // 手动传入 git 统计（优先级高于服务端自动采集）
        if (params.manual_git_stats) {
          for (const [projName, stats] of Object.entries(params.manual_git_stats)) {
            const idx = projects.findIndex(p => p.name === projName);
            const target = idx >= 0 ? projects[idx] : null;
            if (target) {
              target.files_changed = stats.files_changed;
              target.lines_added = stats.lines_added;
              target.lines_deleted = stats.lines_deleted;
              target.commits = stats.commits;
              if (stats.branch) target.branch = stats.branch;
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

        if (params.add_documents) {
          for (const doc of params.add_documents) {
            if (!documents.includes(doc)) documents.push(doc);
          }
        }

        metadata.projects = projects;
        metadata.documents = documents;
        metadata.last_updated = new Date().toISOString();

        let content = existing.content;
        if (params.progress_note) {
          content += `\n\n[${new Date().toISOString().split('T')[0]}] ${params.progress_note}`;
        }

        await ctx.storage.update(params.context_id, { content, metadata });

        logger.info({
          id: params.context_id,
          projects: projects.length,
          documents: documents.length,
        }, '工作上下文已更新');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              context_id: params.context_id,
              projects: projects.map(p => ({
                name: p.name,
                branch: p.branch,
                files_changed: p.files_changed,
                lines_added: p.lines_added,
                lines_deleted: p.lines_deleted,
                commits: p.commits,
              })),
              documents,
              message: '工作上下文已更新。',
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'update_work_context 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}

function collectGitStats(cwd: string): {
  filesChanged: number; linesAdded: number; linesDeleted: number; commits: number; branch: string;
} | null {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8' }).trim();

    let baseBranch = 'origin/master';
    try {
      execFileSync('git', ['rev-parse', '--verify', 'origin/master'], { cwd, encoding: 'utf-8' });
    } catch {
      try {
        execFileSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd, encoding: 'utf-8' });
        baseBranch = 'origin/main';
      } catch {
        return { filesChanged: 0, linesAdded: 0, linesDeleted: 0, commits: 0, branch };
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

    return { filesChanged, linesAdded, linesDeleted, commits: parseInt(commitCount, 10) || 0, branch };
  } catch {
    return null;
  }
}
