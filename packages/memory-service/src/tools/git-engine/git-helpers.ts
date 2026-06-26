// Created by dev on 2026/05/14
// Git 引擎共享工具函数
// 供 git-change-engine、bootstrap-project-history、check-stale-code、get-project-context 复用

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '@memforgeai/shared';
import type { HotFile, ContributorStat } from './types.js';

const execFileAsync = promisify(execFile);
const logger = getLogger('git-helpers');

/**
 * 执行 git 命令，失败记录 debug 日志并返回 null
 */
export async function execGit(cwd: string, args: string[], timeoutMs = 15_000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch (err) {
    logger.debug({ cwd, cmd: `git ${args[0]}`, err: (err as Error).message?.substring(0, 200) }, 'git 命令失败');
    return null;
  }
}

/**
 * 统计指定时间段内的提交数和作者分布
 */
export async function getCommitStats(
  localPath: string,
  since: string,
): Promise<{ count: number; authors: Map<string, { commits: number; lastActive: string }> }> {
  const output = await execGit(localPath, [
    'log', '--format=%an|||%aI', '--no-merges', `--since=${since}`,
  ]);
  const authors = new Map<string, { commits: number; lastActive: string }>();
  let count = 0;

  if (output) {
    for (const line of output.split('\n').filter(Boolean)) {
      count++;
      const [name, date] = line.split('|||');
      if (!name) continue;
      const existing = authors.get(name);
      if (existing) {
        existing.commits++;
        if (date && date > existing.lastActive) existing.lastActive = date;
      } else {
        authors.set(name, { commits: 1, lastActive: date ?? '' });
      }
    }
  }

  return { count, authors };
}

/**
 * 获取仓库全局统计（总提交数、首次/最近提交时间）
 */
export async function getTotalStats(localPath: string): Promise<{
  count: number;
  firstCommitAt: Date | null;
  lastCommitAt: Date | null;
}> {
  const countOutput = await execGit(localPath, ['rev-list', '--count', 'HEAD']);
  const count = countOutput ? parseInt(countOutput.trim(), 10) : 0;

  const firstOutput = await execGit(localPath, ['log', '--reverse', '--format=%aI', '-1']);
  const lastOutput = await execGit(localPath, ['log', '--format=%aI', '-1']);

  return {
    count,
    firstCommitAt: firstOutput ? new Date(firstOutput.trim()) : null,
    lastCommitAt: lastOutput ? new Date(lastOutput.trim()) : null,
  };
}

/**
 * 获取指定时间段内变更最频繁的文件（Top 20）
 */
export async function getHotFiles(localPath: string, since: string): Promise<HotFile[]> {
  const output = await execGit(localPath, [
    'log', '--format=', '--name-only', '--no-merges', `--since=${since}`,
  ]);
  if (!output) return [];

  const fileCounts = new Map<string, number>();
  for (const line of output.split('\n').filter(Boolean)) {
    fileCounts.set(line, (fileCounts.get(line) ?? 0) + 1);
  }

  const topFiles = Array.from(fileCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  const results: HotFile[] = [];
  for (const [file, count] of topFiles) {
    const dateOutput = await execGit(localPath, ['log', '-1', '--format=%aI', '--', file]);
    results.push({
      file,
      count,
      lastModified: dateOutput?.trim() || new Date().toISOString(),
    });
  }
  return results;
}

/**
 * 从作者统计中构建贡献者排名（Top 10）
 */
export function buildContributorStats(
  authors: Map<string, { commits: number; lastActive: string }>,
): ContributorStat[] {
  return Array.from(authors.entries())
    .sort((a, b) => b[1].commits - a[1].commits)
    .slice(0, 10)
    .map(([name, data]) => ({
      name,
      commits: data.commits,
      lastActive: data.lastActive,
    }));
}

/**
 * 检测本地与远程的差异
 */
export async function checkRemoteStatus(
  localPath: string,
  branch: string,
): Promise<{
  remoteHash: string | null;
  behindCount: number;
  aheadCount: number;
}> {
  const remoteBranch = `origin/${branch}`;
  const remoteHash = await execGit(localPath, ['rev-parse', remoteBranch]);
  if (!remoteHash) return { remoteHash: null, behindCount: 0, aheadCount: 0 };

  const behindOutput = await execGit(localPath, [
    'rev-list', '--count', `HEAD..${remoteBranch}`,
  ]);
  const aheadOutput = await execGit(localPath, [
    'rev-list', '--count', `${remoteBranch}..HEAD`,
  ]);

  return {
    remoteHash: remoteHash.trim(),
    behindCount: behindOutput ? parseInt(behindOutput.trim(), 10) : 0,
    aheadCount: aheadOutput ? parseInt(aheadOutput.trim(), 10) : 0,
  };
}
