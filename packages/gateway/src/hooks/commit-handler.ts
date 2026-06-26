import { getLogger, getPool } from '@memforgeai/shared';
import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';

const logger = getLogger('hooks:commit');

export interface CommitPayload {
  commit: string;
  message: string;
  author?: string;
  branch: string;
  stats: string;
  files: string;
  deleted_files?: string;
  repo: string;
  repo_id?: string;
  repo_path?: string;
  timestamp: number;
  is_merge?: boolean;
  diff?: string;
}

import { getReviewBranches } from './shared-config.js';

const SKIP_CLASSIFICATIONS = new Set(['docs', 'style', 'test', 'chore', 'infra']);

function classifyCommit(message: string): string {
  const lower = message.toLowerCase();
  if (lower.startsWith('merge ') || lower.includes('merge branch')) return 'merge';
  if (lower.startsWith('feat') || lower.startsWith('feature')) return 'feature';
  if (lower.startsWith('fix') || lower.startsWith('bugfix')) return 'bugfix';
  if (lower.startsWith('refactor')) return 'refactor';
  if (lower.startsWith('perf')) return 'performance';
  if (lower.startsWith('security') || lower.startsWith('sec')) return 'security';
  if (lower.startsWith('docs')) return 'docs';
  if (lower.startsWith('style')) return 'style';
  if (lower.startsWith('test')) return 'test';
  if (lower.startsWith('chore') || lower.startsWith('ci')) return 'chore';
  return 'feature';
}

function shouldReview(classification: string, isMerge: boolean, branch?: string): boolean {
  if (isMerge) return false;
  if (branch && !getReviewBranches().has(branch)) return false;
  return !SKIP_CLASSIFICATIONS.has(classification);
}

/** token 验证后传入的上下文 */
export interface TokenContext {
  productLine: string | null;
  userId: string | null;
}

export async function handleCommitHook(
  payload: CommitPayload,
  sendJson: (res: ServerResponse, status: number, data: unknown) => void,
  res: ServerResponse,
  memoryServiceUrl: string,
  tokenCtx?: TokenContext,
): Promise<void> {
  try {
    if (!payload.commit || !payload.message || !payload.repo) {
      sendJson(res, 400, { error: '缺少必填字段: commit, message, repo' });
      return;
    }

    // 服务端注入产品线（不信任客户端提交的值）
    const productLine = tokenCtx?.productLine ?? null;

    const pool = getPool();
    let alreadyProcessed = false;
    try {
      const existing = await pool.query(
        'SELECT id FROM memory.code_reviews WHERE repo_id = $1 AND commit_hash = $2',
        [payload.repo_id || payload.repo, payload.commit],
      );
      alreadyProcessed = existing.rows.length > 0;
    } catch {
      // code_reviews 表可能尚未创建，忽略
    }

    if (alreadyProcessed) {
      sendJson(res, 200, { status: 'skipped', reason: 'commit already processed' });
      return;
    }

    const classification = classifyCommit(payload.message);
    const isMerge = payload.is_merge || payload.message.toLowerCase().startsWith('merge ');
    const needsReview = shouldReview(classification, isMerge, payload.branch);

    const repoId = payload.repo_id || payload.repo;
    const files = payload.files ? payload.files.split(',').map(f => f.trim()).filter(Boolean) : [];
    const hasDocs = files.some(f => f.startsWith('docs/'));
    const hasCode = files.some(f =>
      /\.(ts|js|java|php|py|go|rs|kt|vue|tsx|jsx)$/.test(f),
    );

    logger.info({
      commit: payload.commit.slice(0, 8),
      repo: repoId,
      productLine,
      classification,
      needsReview,
      hasDocs,
      hasCode,
      fileCount: files.length,
    }, 'Git Hook: commit 接收');

    if (needsReview) {
      triggerReviewViaMcp(memoryServiceUrl, payload, classification, repoId).catch(err => {
        logger.error({ err, commit: payload.commit }, 'Review 管道异步触发失败');
      });
    }

    if (hasCode && files.length > 0) {
      markStaleKnowledge(repoId, files).catch(err => {
        logger.debug({ err: (err as Error).message }, '过期标记失败（不影响主流程）');
      });
    }

    const deletedFiles = payload.deleted_files
      ? payload.deleted_files.split(',').map(f => f.trim()).filter(Boolean)
      : [];
    if (deletedFiles.length > 0) {
      archiveDeletedFileKnowledge(repoId, deletedFiles).catch(err => {
        logger.debug({ err: (err as Error).message }, '删除文件归档失败（不影响主流程）');
      });
    }

    sendJson(res, 200, {
      status: 'accepted',
      classification,
      needsReview,
      hasDocs,
      hasCode,
      productLine,
    });
  } catch (err) {
    logger.error({ err }, 'commit hook 处理失败');
    sendJson(res, 500, { error: '内部错误' });
  }
}

async function buildMemoryServiceHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  const internalSecret = process.env.MEMFORGE_INTERNAL_SECRET;
  if (internalSecret) {
    const { getInternalHeaders } = await import('@memforgeai/shared');
    Object.assign(headers, getInternalHeaders(internalSecret));
  }
  return headers;
}

async function triggerReviewViaMcp(
  memoryServiceUrl: string,
  payload: CommitPayload,
  classification: string,
  repoId: string,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const headers = await buildMemoryServiceHeaders();
    const resp = await fetch(`${memoryServiceUrl}/mcp`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tools/call',
        params: {
          name: 'review_commit',
          arguments: {
            commit_hash: payload.commit,
            message: payload.message,
            branch: payload.branch,
            author: payload.author ?? 'unknown',
            repo_id: repoId,
            repo_path: payload.repo_path ?? '',
            classification,
            diff: payload.diff ?? '',
            files: payload.files ?? '',
          },
        },
      }),
    });
    const body = await resp.json() as Record<string, unknown>;
    logger.info({ commit: payload.commit.slice(0, 8), status: resp.status, body }, 'review_commit MCP 响应');
  } catch (err) {
    logger.warn({ err }, 'MCP review_commit 调用失败');
  } finally {
    clearTimeout(timeout);
  }
}

async function markStaleKnowledge(repoId: string, changedFiles: string[]): Promise<void> {
  if (changedFiles.length === 0) return;

  const pool = getPool();
  const codeFiles = changedFiles.filter(f =>
    /\.(ts|js|java|php|py|go|rs|kt|vue|tsx|jsx|proto|thrift)$/.test(f),
  );
  if (codeFiles.length === 0) return;

  const filePatterns = codeFiles.slice(0, 20).map(f => `%${f.split('/').pop()}%`);

  try {
    // 1. 标记 memory.entries 中的过期条目
    const entriesResult = await pool.query(
      `UPDATE memory.entries
       SET metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{stale_since}',
         to_jsonb(NOW()::text)
       )
       WHERE metadata->>'source_repo_id' = $1
         AND metadata->>'autoLearned' = 'true'
         AND NOT COALESCE(is_archived, false)
         AND metadata->>'stale_since' IS NULL
         AND (${filePatterns.map((_, i) => `content LIKE $${i + 2}`).join(' OR ')})`,
      [repoId, ...filePatterns],
    );

    // 2. 标记 memory.knowledge_items 中 deep_index 生成的过期条目
    const kiResult = await pool.query(
      `UPDATE memory.knowledge_items
       SET metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{stale_since}',
         to_jsonb(NOW()::text)
       )
       WHERE source_type = 'deep_index'
         AND (project_id = $1 OR metadata->>'repoId' = $1)
         AND status = 'published'
         AND metadata->>'stale_since' IS NULL
         AND (${filePatterns.map((_, i) => `content LIKE $${i + 2}`).join(' OR ')})`,
      [repoId, ...filePatterns],
    );

    const totalStale = (entriesResult.rowCount ?? 0) + (kiResult.rowCount ?? 0);
    if (totalStale > 0) {
      logger.info({
        repoId,
        entriesStale: entriesResult.rowCount,
        knowledgeStale: kiResult.rowCount,
        files: codeFiles.length,
      }, '已标记过期知识条目');
    }
  } catch (err) {
    logger.debug({ err: (err as Error).message }, '过期标记查询失败');
  }
}

/**
 * 当 commit 中有文件被删除时，归档对应的 deep_index 知识条目。
 */
async function archiveDeletedFileKnowledge(repoId: string, deletedFiles: string[]): Promise<void> {
  const pool = getPool();
  const codeFiles = deletedFiles.filter(f =>
    /\.(ts|js|java|php|py|go|rs|kt|vue|tsx|jsx)$/.test(f),
  );
  if (codeFiles.length === 0) return;

  const filePatterns = codeFiles.slice(0, 20).map(f => `%${f.split('/').pop()}%`);

  try {
    const result = await pool.query(
      `UPDATE memory.knowledge_items
       SET status = 'archived',
           metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{archived_reason}',
             '"file_deleted"'::jsonb
           )
       WHERE source_type = 'deep_index'
         AND (project_id = $1 OR metadata->>'repoId' = $1)
         AND status = 'published'
         AND (${filePatterns.map((_, i) => `(metadata->>'filePath' LIKE $${i + 2} OR content LIKE $${i + 2})`).join(' OR ')})`,
      [repoId, ...filePatterns],
    );

    if ((result.rowCount ?? 0) > 0) {
      logger.info({ repoId, archivedCount: result.rowCount, deletedFiles: codeFiles }, '已归档被删除文件的知识条目');
    }
  } catch (err) {
    logger.debug({ err: (err as Error).message }, '删除文件归档查询失败');
  }
}

export function generateHookToken(): string {
  return 'mfh_' + crypto.randomBytes(24).toString('hex');
}
