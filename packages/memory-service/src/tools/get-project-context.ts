// Created by dev on 2026/05/09
// 项目上下文感知 — 自动注入项目画像、活跃度、远程变更摘要
// 适合在 AI 会话开始或切换项目时调用，提供全局视野

import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './types.js';
import { getGitStats } from './git-engine/stats-store.js';
import { execGit, checkRemoteStatus } from './git-engine/git-helpers.js';

const execFileAsync = promisify(execFile);

export function registerGetProjectContext(server: McpServer, _ctx: ToolContext): void {
  server.tool(
    'get_project_context',
    '获取项目的全局上下文感知信息：画像摘要、活跃度、远程变更、热文件。适合在会话开始时或切换项目时调用，帮助 AI 快速了解项目现状。',
    {
      project_root: z.string().describe('项目根目录的绝对路径'),
      product_line: z.string().optional().describe('产品线标识'),
      repo_id: z.string().optional().describe('仓库 ID'),
      include_recent_commits: z.boolean().optional().describe('是否包含最近提交列表（默认 true）'),
      include_stale_check: z.boolean().optional().describe('是否检查远程更新（默认 true，需网络）'),
    },
    async (params) => {
      const projectRoot = params.project_root.replace(/^~/, process.env.HOME ?? '');
      if (!existsSync(projectRoot)) {
        return { content: [{ type: 'text' as const, text: `错误: 路径不存在 ${projectRoot}` }] };
      }

      try {
        const result = await buildProjectContext(projectRoot, {
          productLine: params.product_line,
          repoId: params.repo_id,
          includeRecentCommits: params.include_recent_commits !== false,
          includeStaleCheck: params.include_stale_check !== false,
        });
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `获取项目上下文失败: ${msg}` }] };
      }
    },
  );
}

interface ContextOptions {
  productLine?: string;
  repoId?: string;
  includeRecentCommits: boolean;
  includeStaleCheck: boolean;
}

async function buildProjectContext(projectRoot: string, opts: ContextOptions): Promise<string> {
  const parts: string[] = [];

  const branch = await execGit(projectRoot, ['symbolic-ref', '--short', 'HEAD']);
  const branchName = branch?.trim() ?? 'unknown';

  parts.push('## 项目上下文\n');

  // 基本信息
  const repoName = projectRoot.split('/').pop() ?? projectRoot;
  parts.push(`**项目**: ${repoName}`);
  parts.push(`**当前分支**: \`${branchName}\``);
  if (opts.productLine) parts.push(`**产品线**: ${opts.productLine}`);
  if (opts.repoId) parts.push(`**仓库 ID**: ${opts.repoId}`);

  // 从 DB 获取统计数据
  if (opts.productLine && opts.repoId) {
    const stats = await getGitStats(opts.productLine, opts.repoId);
    if (stats) {
      parts.push('');
      parts.push('### 活跃度指标');
      parts.push(`- 总提交数: ${stats.totalCommits?.toLocaleString() ?? '-'}`);
      parts.push(`- 7 天提交: ${stats.commitsLast7d ?? 0} | 30 天提交: ${stats.commitsLast30d ?? 0}`);
      parts.push(`- 7 天贡献者: ${stats.activeContributors7d ?? 0} | 30 天贡献者: ${stats.activeContributors30d ?? 0}`);

      if (stats.lastCommitAt) {
        const daysAgo = Math.floor((Date.now() - new Date(stats.lastCommitAt).getTime()) / 86400000);
        parts.push(`- 最近提交: ${daysAgo === 0 ? '今天' : `${daysAgo} 天前`}`);
      }

      const hotFiles = stats.hotFiles30d as Array<{ file: string; count: number }> | null;
      if (hotFiles && hotFiles.length > 0) {
        parts.push('');
        parts.push('### 变更热点（30 天）');
        for (const f of hotFiles.slice(0, 5)) {
          parts.push(`- \`${f.file}\` (${f.count} 次变更)`);
        }
        parts.push('');
        parts.push('> 修改热点文件时注意先 pull 最新代码，避免冲突。');
      }

      const topContribs = stats.topContributors as Array<{ name: string; commits: number }> | null;
      if (topContribs && topContribs.length > 0) {
        parts.push('');
        parts.push('### 主要贡献者');
        for (const c of topContribs.slice(0, 3)) {
          parts.push(`- ${c.name}: ${c.commits} 次提交`);
        }
      }
    }
  }

  // 远程变更检测
  if (opts.includeStaleCheck) {
    parts.push('');
    parts.push('### 远程状态');

    try {
      await execFileAsync('git', ['fetch', 'origin', branchName, '--quiet'], {
        cwd: projectRoot, timeout: 15_000,
      });
    } catch {
      parts.push('- git fetch 失败（可能无网络或无权限）');
    }

    const remote = await checkRemoteStatus(projectRoot, branchName);

    if (remote.remoteHash) {
      if (remote.behindCount > 0) {
        parts.push(`- **本地落后远程 ${remote.behindCount} 个提交** — 建议先 \`git pull\``);

        const remoteBranch = `origin/${branchName}`;
        const recentRemote = await execGit(projectRoot, [
          'log', `HEAD..${remoteBranch}`, '--format=%an: %s', '--max-count=3',
        ]);
        if (recentRemote) {
          parts.push('- 远程最新提交:');
          for (const line of recentRemote.split('\n').filter(Boolean)) {
            parts.push(`  - ${line}`);
          }
        }
      } else {
        parts.push('- 本地代码已是最新');
      }
    } else {
      parts.push(`- 分支 \`${branchName}\` 无对应远程分支`);
    }
  }

  // 最近本地提交
  if (opts.includeRecentCommits) {
    const recentLocal = await execGit(projectRoot, [
      'log', '--format=%h %an (%ar): %s', '--max-count=5',
    ]);
    if (recentLocal) {
      parts.push('');
      parts.push('### 最近本地提交');
      for (const line of recentLocal.split('\n').filter(Boolean)) {
        parts.push(`- ${line}`);
      }
    }
  }

  // 当前工作区状态
  const statusOutput = await execGit(projectRoot, ['status', '--porcelain', '--short']);
  if (statusOutput) {
    const files = statusOutput.split('\n').filter(Boolean);
    if (files.length > 0) {
      parts.push('');
      parts.push(`### 工作区状态 (${files.length} 个文件有改动)`);
      for (const f of files.slice(0, 10)) {
        parts.push(`- ${f}`);
      }
      if (files.length > 10) {
        parts.push(`- ...还有 ${files.length - 10} 个文件`);
      }
    }
  }

  return parts.join('\n');
}

