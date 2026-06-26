// Created by dev on 2026/05/09
// Git 历史知识引擎 — 陈旧代码检测 MCP 工具
// 检查本地 HEAD 是否落后远程，提供变更摘要

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, validateScanPath } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { updateFetchStatus } from './git-engine/stats-store.js';
import { execGit, checkRemoteStatus } from './git-engine/git-helpers.js';

const execFileAsync = promisify(execFile);
const logger = getLogger('tool:check-stale-code');

export function registerCheckStaleCode(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'check_stale_code',
    '检查指定仓库本地代码是否落后远程，返回落后提交数和最近变更摘要。用于在开始工作前判断是否需要 pull 最新代码。',
    {
      project_root: z.string().describe('项目根目录的绝对路径'),
      product_line: z.string().optional().describe('产品线标识'),
      repo_id: z.string().optional().describe('仓库 ID'),
      fetch_remote: z.boolean().optional().describe('是否先执行 git fetch（默认 true）'),
    },
    async (params) => {
      let projectRoot: string;
      try {
        projectRoot = validateScanPath(params.project_root);
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `路径校验失败: ${(err as Error).message}` }] };
      }

      try {
        const result = await checkStale(projectRoot, {
          productLine: params.product_line,
          repoId: params.repo_id,
          fetchRemote: params.fetch_remote !== false,
        });

        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `检测失败: ${msg}` }] };
      }
    },
  );
}

interface CheckOptions {
  productLine?: string;
  repoId?: string;
  fetchRemote: boolean;
}

async function checkStale(projectRoot: string, options: CheckOptions): Promise<string> {
  const branch = await execGit(projectRoot, ['symbolic-ref', '--short', 'HEAD']);
  if (!branch) return '无法检测当前分支';

  const branchName = branch.trim();
  const remoteBranch = `origin/${branchName}`;

  if (options.fetchRemote) {
    try {
      await execFileAsync('git', ['fetch', 'origin', branchName, '--quiet'], {
        cwd: projectRoot,
        timeout: 30_000,
      });
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'git fetch 失败（可能无网络或无权限）');
    }
  }

  const hasRemote = await execGit(projectRoot, ['rev-parse', '--verify', remoteBranch]);
  if (!hasRemote) {
    return `当前分支 \`${branchName}\` 没有对应的远程分支，无法检测是否落后。`;
  }

  const localHead = await execGit(projectRoot, ['rev-parse', 'HEAD']);
  const remote = await checkRemoteStatus(projectRoot, branchName);

  if (localHead?.trim() === remote.remoteHash) {
    const result = `**本地代码是最新的** (分支: \`${branchName}\`)`;
    if (options.productLine && options.repoId && localHead) {
      await updateFetchStatus(options.productLine, options.repoId, localHead.trim(), remote.remoteHash, 0, branchName);
    }
    return result;
  }

  const { behindCount, aheadCount } = remote;

  if (options.productLine && options.repoId && localHead) {
    await updateFetchStatus(
      options.productLine, options.repoId,
      localHead.trim(), remote.remoteHash,
      behindCount, branchName,
    );
  }

  const parts: string[] = [];

  if (behindCount > 0) {
    parts.push(`**本地落后远程 ${behindCount} 个提交** (分支: \`${branchName}\`)`);

    if (behindCount > 10) {
      parts.push(`> 落后较多，**强烈建议先 pull 再开始改动**，避免大量冲突。`);
    } else {
      parts.push(`> 建议先 \`git pull\` 更新到最新再进行修改。`);
    }

    const recentCommits = await execGit(projectRoot, [
      'log', `HEAD..${remoteBranch}`, '--format=%an (%ar): %s',
      '--max-count=5',
    ]);
    if (recentCommits) {
      parts.push('');
      parts.push('**远程最近的提交：**');
      for (const line of recentCommits.split('\n').filter(Boolean)) {
        parts.push(`- ${line}`);
      }
      if (behindCount > 5) {
        parts.push(`- ...还有 ${behindCount - 5} 个更早的提交`);
      }
    }
  }

  if (aheadCount > 0) {
    parts.push('');
    parts.push(`本地领先远程 ${aheadCount} 个提交（有未推送的本地提交）。`);
  }

  if (behindCount === 0 && aheadCount === 0) {
    parts.push('**本地代码是最新的**');
  }

  return parts.join('\n');
}
