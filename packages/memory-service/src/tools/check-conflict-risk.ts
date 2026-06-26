// Created by dev on 2026/05/09
// 变更冲突预警 — 检测当前工作区修改的文件是否为高频变更热文件

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateScanPath } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { getGitStats } from './git-engine/stats-store.js';

const execFileAsync = promisify(execFile);

export function registerCheckConflictRisk(server: McpServer, _ctx: ToolContext): void {
  server.tool(
    'check_conflict_risk',
    '检测当前工作区改动的文件是否在该仓库的高频变更列表中，预警潜在冲突风险。适合在修改代码前或提交前调用。',
    {
      project_root: z.string().describe('项目根目录的绝对路径'),
      product_line: z.string().optional().describe('产品线标识（用于查询 project_git_stats）'),
      repo_id: z.string().optional().describe('仓库 ID'),
    },
    async (params) => {
      let projectRoot: string;
      try {
        projectRoot = validateScanPath(params.project_root);
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `路径校验失败: ${(err as Error).message}` }] };
      }

      try {
        const result = await analyzeConflictRisk(projectRoot, params.product_line, params.repo_id);
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `分析失败: ${msg}` }] };
      }
    },
  );
}

async function analyzeConflictRisk(
  projectRoot: string,
  productLine?: string,
  repoId?: string,
): Promise<string> {
  const modifiedFiles = await getModifiedFiles(projectRoot);
  if (modifiedFiles.length === 0) {
    return '**工作区无改动文件**，无冲突风险。';
  }

  let hotFiles: Array<{ file: string; count: number }> = [];
  let recentAuthors: Map<string, string[]> = new Map();

  if (productLine && repoId) {
    const stats = await getGitStats(productLine, repoId);
    if (stats?.hotFiles30d) {
      hotFiles = (stats.hotFiles30d as Array<{ file: string; count: number }>);
    }
  }

  for (const f of modifiedFiles.slice(0, 20)) {
    const authors = await getRecentFileAuthors(projectRoot, f);
    if (authors.length > 0) {
      recentAuthors.set(f, authors);
    }
  }

  const hotFileSet = new Map(hotFiles.map(h => [h.file, h.count]));
  const conflicts: Array<{ file: string; reason: string; severity: 'high' | 'medium' | 'low' }> = [];

  for (const f of modifiedFiles) {
    const changeCount = hotFileSet.get(f);
    const authors = recentAuthors.get(f) ?? [];

    if (changeCount && changeCount >= 10) {
      conflicts.push({
        file: f,
        reason: `30 天内被修改 ${changeCount} 次（高频变更热文件）`,
        severity: 'high',
      });
    } else if (changeCount && changeCount >= 5) {
      conflicts.push({
        file: f,
        reason: `30 天内被修改 ${changeCount} 次`,
        severity: 'medium',
      });
    }

    if (authors.length >= 3) {
      const existing = conflicts.find(c => c.file === f);
      const authorNote = `最近 7 天有 ${authors.length} 人修改过此文件：${authors.join(', ')}`;
      if (existing) {
        existing.reason += `；${authorNote}`;
        if (existing.severity === 'medium') existing.severity = 'high';
      } else {
        conflicts.push({ file: f, reason: authorNote, severity: 'medium' });
      }
    }
  }

  const parts: string[] = [];
  parts.push(`## 冲突风险分析\n`);
  parts.push(`工作区改动文件: ${modifiedFiles.length} 个\n`);

  if (conflicts.length === 0) {
    parts.push('**低风险** — 当前改动的文件不在高频变更列表中，冲突概率较低。');
    return parts.join('\n');
  }

  const highRisk = conflicts.filter(c => c.severity === 'high');
  const mediumRisk = conflicts.filter(c => c.severity === 'medium');

  if (highRisk.length > 0) {
    parts.push(`### 高风险文件 (${highRisk.length} 个)\n`);
    for (const c of highRisk) {
      parts.push(`- \`${c.file}\` — ${c.reason}`);
    }
    parts.push('');
    parts.push('> 建议：先 `git pull` 获取最新代码，修改时注意与其他人沟通。');
  }

  if (mediumRisk.length > 0) {
    parts.push(`\n### 中等风险文件 (${mediumRisk.length} 个)\n`);
    for (const c of mediumRisk) {
      parts.push(`- \`${c.file}\` — ${c.reason}`);
    }
  }

  return parts.join('\n');
}

async function getModifiedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'HEAD'], {
      cwd, timeout: 10_000, encoding: 'utf-8',
    });
    const staged = await execFileAsync('git', ['diff', '--name-only', '--cached'], {
      cwd, timeout: 10_000, encoding: 'utf-8',
    });
    const files = new Set<string>();
    for (const line of stdout.split('\n').filter(Boolean)) files.add(line);
    for (const line of staged.stdout.split('\n').filter(Boolean)) files.add(line);
    return [...files];
  } catch {
    return [];
  }
}

async function getRecentFileAuthors(cwd: string, file: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', [
      'log', '--since=7 days ago', '--format=%an', '--', file,
    ], { cwd, timeout: 10_000, encoding: 'utf-8' });
    const authors = [...new Set(stdout.split('\n').filter(Boolean))];
    return authors;
  } catch {
    return [];
  }
}
