// Created by dev on 2026/05/09
// Git 历史知识引擎 — 全量历史导入 MCP 工具
// 支持断点续传、批次处理、后台任务进度

import { existsSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, getPool } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import type { CommitInfo, BootstrapProgress } from './git-engine/types.js';
import { classifyCommit, parseNameStatus, buildMemoryContent } from './git-engine/commit-classifier.js';
import { updateActivityMetrics, updateFetchStatus } from './git-engine/stats-store.js';
import { execGit, getCommitStats, getTotalStats, getHotFiles, buildContributorStats } from './git-engine/git-helpers.js';

const logger = getLogger('tool:bootstrap-project-history');

const BATCH_SIZE_DEFAULT = 50;
const BATCH_DELAY_MS = 200;

export function registerBootstrapProjectHistory(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'bootstrap_project_history',
    '一次性深度读取项目全量 Git 历史，构建项目画像。支持断点续传，以后台任务运行。',
    {
      project_root: z.string().describe('项目根目录的绝对路径'),
      product_line: z.string().describe('产品线标识（如 your-product）'),
      repo_id: z.string().optional().describe('仓库 ID（不传则从 git remote 推断）'),
      depth: z.enum(['full', '6months', '1year']).optional().describe('分析深度，默认 6months'),
      batch_size: z.number().optional().describe('每批处理的 commit 数（默认 50）'),
      resume: z.boolean().optional().describe('是否从断点续传（默认 true）'),
    },
    async (params) => {
      const projectRoot = params.project_root.replace(/^~/, process.env.HOME ?? '');
      if (!existsSync(projectRoot)) {
        return { content: [{ type: 'text' as const, text: `错误: 路径不存在 ${projectRoot}` }] };
      }

      const repoId = params.repo_id ?? await inferRepoId(projectRoot);
      if (!repoId) {
        return { content: [{ type: 'text' as const, text: '错误: 无法推断 repo_id，请手动指定' }] };
      }

      const depth = params.depth ?? '6months';
      const batchSize = params.batch_size ?? BATCH_SIZE_DEFAULT;
      const resume = params.resume !== false;

      const bootstrapParams: BootstrapParams = {
        projectRoot,
        productLine: params.product_line,
        repoId,
        depth,
        batchSize,
        resume,
      };

      // 异步执行，不阻塞 MCP 调用方（与 REST API 行为一致）
      runBootstrap(ctx, bootstrapParams)
        .then(result => {
          logger.info({ repoId, stored: result.storedMemories, elapsed: result.elapsedMs }, '项目历史导入完成');
        })
        .catch(err => {
          logger.error({ err: (err as Error).message, repoId }, '项目历史导入失败');
        });

      return {
        content: [{
          type: 'text' as const,
          text: `已启动后台导入任务：仓库 ${repoId}（产品线 ${params.product_line}，深度 ${depth}）。\n可通过 WebUI 项目详情页查看进度。`,
        }],
      };
    },
  );
}

export interface BootstrapParams {
  projectRoot: string;
  productLine: string;
  repoId: string;
  depth: 'full' | '6months' | '1year';
  batchSize: number;
  resume: boolean;
}

interface BootstrapResult {
  totalCommits: number;
  processedCommits: number;
  storedMemories: number;
  elapsedMs: number;
}

/**
 * REST API 调用入口（后台异步运行）
 */
export async function runBootstrapFromApi(ctx: ToolContext, params: BootstrapParams): Promise<BootstrapResult> {
  return runBootstrap(ctx, params);
}

async function runBootstrap(ctx: ToolContext, params: BootstrapParams): Promise<BootstrapResult> {
  const start = Date.now();
  const { projectRoot, productLine, repoId, depth, batchSize, resume } = params;

  const sinceArg = depth === 'full' ? [] : [`--since=${getDepthDate(depth)}`];
  const allHashes = await getAllCommitHashes(projectRoot, sinceArg);
  const totalCommits = allHashes.length;

  if (totalCommits === 0) {
    return { totalCommits: 0, processedCommits: 0, storedMemories: 0, elapsedMs: Date.now() - start };
  }

  let startIdx = 0;
  if (resume) {
    const progress = await getBootstrapProgress(repoId);
    if (progress?.lastProcessedHash) {
      const idx = allHashes.indexOf(progress.lastProcessedHash);
      if (idx >= 0) {
        startIdx = idx + 1;
        logger.info({
          repoId, resumeFrom: progress.lastProcessedHash,
          processed: progress.processedCommits, total: totalCommits,
        }, '从断点续传');
      }
    }
  }

  let processedCommits = startIdx;
  let storedMemories = 0;
  const inferredProject = projectRoot.split('/').pop() ?? repoId;

  for (let i = startIdx; i < allHashes.length; i += batchSize) {
    const batch = allHashes.slice(i, i + batchSize);

    for (const hash of batch) {
      const commit = await getCommitDetail(projectRoot, hash);
      if (!commit) { processedCommits++; continue; }

      const classification = classifyCommit(commit);
      if (!classification) { processedCommits++; continue; }

      const content = buildMemoryContent(commit, classification);
      const scanResult = ctx.scanner.scan(content);
      if (scanResult.blocked) { processedCommits++; continue; }

      try {
        const embedding = await ctx.embedding.embedPassage(
          `${commit.subject} ${scanResult.sanitizedContent ?? content}`,
        );
        const duplicate = await ctx.storage.checkDuplicate(embedding, 0.90);
        if (duplicate) { processedCommits++; continue; }

        let resolvedProjectId: string;
        if (classification.visibility === 'global') resolvedProjectId = '_global_';
        else if (classification.visibility === 'product_line') resolvedProjectId = productLine;
        else resolvedProjectId = productLine || inferredProject;

        await ctx.storage.store({
          projectId: resolvedProjectId,
          branchId: null,
          title: `[${classification.category}] ${commit.subject}`,
          content: scanResult.sanitizedContent ?? content,
          scope: classification.scope,
          source: classification.source,
          tags: [
            'from-commit', 'bootstrap', classification.category,
            `commit:${commit.hash.substring(0, 8)}`,
            `repo:${repoId}`,
          ],
          embedding,
          metadata: {
            commitHash: commit.hash,
            author: commit.author,
            commitDate: commit.date,
            filesChanged: commit.filesChanged,
            insertions: commit.insertions,
            deletions: commit.deletions,
            source_project: inferredProject,
            source_repo_id: repoId,
            source_product_line: productLine,
            visibility: classification.visibility,
            category: classification.category,
            autoLearned: true,
            bootstrap: true,
          },
          isArchived: false,
          archivedReason: null,
          createdBy: ctx.userId,
          expiresAt: null,
        });
        storedMemories++;
      } catch (err) {
        logger.debug({ hash, err: (err as Error).message }, '存储提交记忆失败');
      }
      processedCommits++;
    }

    await saveBootstrapProgress(repoId, {
      totalCommits,
      processedCommits,
      lastProcessedHash: batch[batch.length - 1],
      progressPercent: Math.round((processedCommits / totalCommits) * 100),
      storedMemories,
      llmCallsUsed: 0,
      startedAt: new Date(start).toISOString(),
    });

    if (i + batchSize < allHashes.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  await aggregateAfterBootstrap(projectRoot, productLine, repoId);

  logger.info({ repoId, totalCommits, processedCommits, storedMemories }, '项目历史导入完成');
  return { totalCommits, processedCommits, storedMemories, elapsedMs: Date.now() - start };
}

async function aggregateAfterBootstrap(projectRoot: string, productLine: string, repoId: string): Promise<void> {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600_000).toISOString();

    const [stats7d, stats30d, total, hotFiles] = await Promise.all([
      getCommitStats(projectRoot, sevenDaysAgo),
      getCommitStats(projectRoot, thirtyDaysAgo),
      getTotalStats(projectRoot),
      getHotFiles(projectRoot, thirtyDaysAgo),
    ]);

    const contributors = buildContributorStats(stats30d.authors);

    await updateActivityMetrics(productLine, repoId, {
      commitsLast7d: stats7d.count,
      commitsLast30d: stats30d.count,
      activeContributors7d: stats7d.authors.size,
      activeContributors30d: stats30d.authors.size,
      hotFiles30d: hotFiles,
      topContributors: contributors,
      totalCommits: total.count,
      firstCommitAt: total.firstCommitAt,
      lastCommitAt: total.lastCommitAt,
    });

    const head = await execGit(projectRoot, ['rev-parse', 'HEAD']);
    if (head) {
      const branch = await execGit(projectRoot, ['symbolic-ref', '--short', 'HEAD']) ?? 'main';
      await updateFetchStatus(productLine, repoId, head.trim(), null, 0, branch.trim());
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Bootstrap 后统计聚合失败');
  }
}

// ── Git 操作 ──────────────────────────────────────

async function getAllCommitHashes(projectRoot: string, sinceArgs: string[]): Promise<string[]> {
  const output = await execGit(projectRoot, [
    'log', '--format=%H', '--no-merges', '--reverse', ...sinceArgs,
  ]);
  return output ? output.split('\n').filter(Boolean) : [];
}

async function getCommitDetail(projectRoot: string, hash: string): Promise<CommitInfo | null> {
  const logOutput = await execGit(projectRoot, [
    'log', '-1', '--format=%H|||%s|||%an|||%aI|||%b', hash,
  ]);
  if (!logOutput) return null;

  const parts = logOutput.split('|||');
  const nameStatusOutput = await execGit(projectRoot, [
    'diff', '--name-status', `${hash}~1`, hash,
  ]);
  const files = nameStatusOutput ? parseNameStatus(nameStatusOutput) : [];

  const numstatOutput = await execGit(projectRoot, [
    'diff', '--numstat', `${hash}~1`, hash,
  ]);
  let insertions = 0;
  let deletions = 0;
  if (numstatOutput) {
    for (const line of numstatOutput.split('\n').filter(Boolean)) {
      const [ins, del] = line.split('\t');
      insertions += ins === '-' ? 0 : parseInt(ins, 10);
      deletions += del === '-' ? 0 : parseInt(del, 10);
    }
  }

  return {
    hash: parts[0] ?? '',
    subject: parts[1] ?? '',
    author: parts[2] ?? '',
    date: parts[3] ?? '',
    body: parts[4] ?? '',
    filesChanged: files.length,
    insertions,
    deletions,
    files,
  };
}

async function inferRepoId(projectRoot: string): Promise<string | null> {
  const remote = await execGit(projectRoot, ['remote', 'get-url', 'origin']);
  if (!remote) return null;
  const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

// ── 断点续传 ──────────────────────────────────────

async function getBootstrapProgress(repoId: string): Promise<BootstrapProgress | null> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ last_result: BootstrapProgress }>(
      `SELECT last_result FROM memory.auto_init_state
       WHERE project_id = $1 AND init_type = 'project_bootstrap'`,
      [repoId],
    );
    return rows[0]?.last_result ?? null;
  } catch {
    return null;
  }
}

async function saveBootstrapProgress(repoId: string, progress: BootstrapProgress): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO memory.auto_init_state (project_id, init_type, last_run_at, last_status, last_result, run_count)
       VALUES ($1, 'project_bootstrap', NOW(), 'running', $2, 1)
       ON CONFLICT (project_id, init_type)
       DO UPDATE SET last_run_at = NOW(), last_status = 'running', last_result = $2,
                     run_count = memory.auto_init_state.run_count + 1, updated_at = NOW()`,
      [repoId, JSON.stringify(progress)],
    );
  } catch (err) {
    logger.debug({ repoId, err: (err as Error).message }, '保存 bootstrap 进度失败');
  }
}

// ── 工具函数 ──────────────────────────────────────

function getDepthDate(depth: '6months' | '1year'): string {
  const d = new Date();
  if (depth === '6months') d.setMonth(d.getMonth() - 6);
  else d.setFullYear(d.getFullYear() - 1);
  return d.toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
