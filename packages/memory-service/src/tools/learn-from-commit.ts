// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: learn_from_commits — 从 Git commit 历史中自动提取知识
// 复用 git-engine/commit-classifier 的统一分类逻辑

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, validateScanPath } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import type { CommitInfo } from './git-engine/types.js';
import { classifyCommit, buildMemoryContent, parseNameStatus, parseDiffNumstat } from './git-engine/commit-classifier.js';
import { execGit } from './git-engine/git-helpers.js';
import { execFileSync } from 'node:child_process';

const logger = getLogger('tool:learn-from-commit');

export function registerLearnFromCommits(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'learn_from_commits',
    '分析最近的 Git commit 历史，自动提取有价值的知识存入记忆库。识别 Bug 修复、重构、架构变更、性能优化等关键提交。',
    {
      count: z.number().min(1).max(100).default(10).describe('分析最近多少个 commit'),
      since: z.string().optional().describe('起始日期（如 2026-04-01）'),
      author: z.string().optional().describe('仅分析指定作者的提交'),
      project_root: z.string().optional().describe('Git 仓库根目录绝对路径。不传则使用 MCP 服务的工作目录。Web UI 必须传此参数'),
      product_line: z.string().optional().describe('产品线标识，不传则从 Git 目录推断项目名'),
      dry_run: z.boolean().default(false).describe('试运行：只分析不存储'),
    },
    async ({ count, since, author, project_root, product_line, dry_run }) => {
      const cwd = project_root ?? process.cwd();
      try {
        validateScanPath(cwd);
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `路径校验失败: ${(err as Error).message}`,
          }],
        };
      }

      const gitArgs = ['log', `-${count}`, '--format=%H|||%s|||%an|||%aI|||%b', '--no-merges'];
      if (since) gitArgs.push(`--since=${since}`);
      if (author) gitArgs.push(`--author=${author}`);

      let logOutput: string;
      try {
        logOutput = execFileSync('git', gitArgs, { cwd, encoding: 'utf-8', timeout: 15000 }).trim();
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Git log 失败: ${(err as Error).message}`,
          }],
        };
      }

      if (!logOutput) {
        return {
          content: [{
            type: 'text' as const,
            text: '没有找到匹配的 commit。',
          }],
        };
      }

      const rawCommits = parseRawCommits(logOutput);
      const inferredProject = cwd.split('/').pop() ?? 'default';
      const insights: CommitInsight[] = [];

      for (const raw of rawCommits) {
        const commit = await enrichCommitInfo(cwd, raw);
        const classification = classifyCommit(commit);
        if (!classification) continue;

        const memoryContent = buildMemoryContent(commit, classification);
        const insight: CommitInsight = {
          hash: commit.hash.substring(0, 8),
          message: commit.subject,
          author: commit.author,
          date: commit.date.split('T')[0],
          category: classification.category,
          scope: classification.scope,
          memoryContent,
        };

        if (!dry_run) {
          try {
            const scanResult = ctx.scanner.scan(memoryContent);
            if (!scanResult.blocked) {
              const embedding = await ctx.embedding.embedPassage(
                `${commit.subject} ${scanResult.sanitizedContent ?? memoryContent}`,
              );

              const duplicate = await ctx.storage.checkDuplicate(embedding, 0.90);
              if (!duplicate) {
                let resolvedProjectId: string;
                if (classification.visibility === 'global') {
                  resolvedProjectId = '_global_';
                } else if (classification.visibility === 'product_line' && product_line) {
                  resolvedProjectId = product_line;
                } else {
                  resolvedProjectId = product_line ?? inferredProject;
                }

                await ctx.storage.store({
                  projectId: resolvedProjectId,
                  branchId: ctx.gitContext?.branchName ?? null,
                  title: `[${classification.category}] ${commit.subject}`,
                  content: scanResult.sanitizedContent ?? memoryContent,
                  scope: classification.scope,
                  source: classification.source,
                  tags: ['from-commit', classification.category, `commit:${commit.hash.substring(0, 8)}`],
                  embedding,
                  metadata: {
                    commitHash: commit.hash,
                    author: commit.author,
                    commitDate: commit.date,
                    filesChanged: commit.filesChanged,
                    insertions: commit.insertions,
                    deletions: commit.deletions,
                    source_project: inferredProject,
                    source_product_line: product_line ?? null,
                    visibility: classification.visibility,
                    category: classification.category,
                  },
                  isArchived: false,
                  archivedReason: null,
                  createdBy: ctx.userId,
                  expiresAt: null,
                  orgId: ctx.orgId || null,
                  teamId: null,
                  visibility: 'personal',
                });
                insight.stored = true;
              } else {
                insight.duplicate = true;
              }
            }
          } catch (storeErr) {
            logger.warn({ commit: commit.hash, err: (storeErr as Error).message }, '存储提交记忆失败，跳过继续');
          }
        }

        insights.push(insight);
      }

      const summary = {
        mode: dry_run ? '试运行' : '已学习',
        commitsAnalyzed: rawCommits.length,
        insightsFound: insights.length,
        stored: insights.filter((i) => i.stored).length,
        duplicates: insights.filter((i) => i.duplicate).length,
        insights,
      };

      logger.info({
        commits: rawCommits.length,
        insights: insights.length,
        stored: summary.stored,
      }, 'Commit 学习完成');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(summary, null, 2),
        }],
      };
    },
  );
}

interface RawCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
  body: string;
}

interface CommitInsight {
  hash: string;
  message: string;
  author: string;
  date: string;
  category: string;
  scope: string;
  memoryContent: string;
  stored?: boolean;
  duplicate?: boolean;
}

function parseRawCommits(output: string): RawCommit[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('|||');
      return {
        hash: parts[0] ?? '',
        subject: parts[1] ?? '',
        author: parts[2] ?? '',
        date: parts[3] ?? '',
        body: parts[4] ?? '',
      };
    })
    .filter((c) => c.hash && c.subject);
}

async function enrichCommitInfo(cwd: string, raw: RawCommit): Promise<CommitInfo> {
  const hasParent = await execGit(cwd, ['rev-parse', '--verify', `${raw.hash}~1`]);
  const diffBase = hasParent
    ? [`${raw.hash}~1`, raw.hash]
    : ['--root', raw.hash];

  const nameStatusOutput = await execGit(cwd, ['diff', '--name-status', ...diffBase]);
  const files = nameStatusOutput ? parseNameStatus(nameStatusOutput) : [];

  const numstatOutput = await execGit(cwd, ['diff', '--numstat', ...diffBase]);
  const stats = numstatOutput ? parseDiffNumstat(numstatOutput) : { insertions: 0, deletions: 0 };

  return {
    ...raw,
    filesChanged: files.length,
    insertions: stats.insertions,
    deletions: stats.deletions,
    files,
  };
}
