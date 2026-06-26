import { getLogger, getPool } from '@memforgeai/shared';
import type { ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import type pg from 'pg';

const logger = getLogger('hooks:batch');

export interface BatchCommitPayload {
  repo_id: string;
  repo_path: string;
  commits: Array<{
    hash: string;
    message: string;
    author: string;
    timestamp: string;
    diff?: string;
  }>;
  options?: {
    skip_review?: boolean;
    concurrency?: number;
  };
}

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://127.0.0.1:3001';

/** 批量 Hook 调用 memory-service 超时（毫秒） */
const BATCH_HOOK_TIMEOUT_MS = 60_000;

const DEFAULT_CONCURRENCY = 5;

type CommitProcessResult =
  | { status: 'processed'; reviewed: boolean }
  | { status: 'skipped' };

async function processCommit(
  pool: pg.Pool,
  payload: BatchCommitPayload,
  commit: BatchCommitPayload['commits'][number],
  skipReview: boolean,
): Promise<CommitProcessResult> {
  const existing = await pool.query(
    'SELECT id FROM memory.code_reviews WHERE repo_id = $1 AND commit_hash = $2',
    [payload.repo_id, commit.hash],
  );

  if (existing.rows.length > 0) {
    return { status: 'skipped' };
  }

  await pool.query(
    `INSERT INTO memory.code_reviews
     (project_id, repo_id, commit_hash, branch, author, classification, findings, summary, reviewed_at)
     VALUES ($1, $2, $3, '', $4, 'batch_import', '[]', $5, $6)
     ON CONFLICT (repo_id, commit_hash) DO NOTHING`,
    [payload.repo_id, payload.repo_id, commit.hash, commit.author, commit.message, commit.timestamp],
  );

  let reviewed = false;
  if (!skipReview && commit.diff) {
    triggerBatchReview(payload.repo_id, payload.repo_path, commit).catch(err => {
      logger.debug({ err: (err as Error).message, hash: commit.hash }, '批量补录 review 触发失败');
    });
    reviewed = true;
  }

  return { status: 'processed', reviewed };
}

export async function handleBatchHook(
  payload: BatchCommitPayload,
  sendJson: (res: ServerResponse, status: number, data: unknown) => void,
  res: ServerResponse,
): Promise<void> {
  try {
    if (!payload.repo_id || !payload.commits?.length) {
      sendJson(res, 400, { error: '缺少 repo_id 或 commits' });
      return;
    }

    const pool = getPool();
    let processed = 0;
    let skipped = 0;
    let reviewed = 0;
    const errors: Array<{ hash: string; error: string }> = [];
    const skipReview = payload.options?.skip_review !== false;
    const concurrency = Math.max(1, Math.min(payload.options?.concurrency ?? DEFAULT_CONCURRENCY, 10));

    for (let i = 0; i < payload.commits.length; i += concurrency) {
      const batch = payload.commits.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(commit => processCommit(pool, payload, commit, skipReview)),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const hash = batch[j].hash;
        if (result.status === 'fulfilled') {
          if (result.value.status === 'skipped') {
            skipped++;
          } else {
            processed++;
            if (result.value.reviewed) reviewed++;
          }
        } else {
          errors.push({ hash, error: (result.reason as Error).message });
        }
      }
    }

    logger.info({
      repoId: payload.repo_id,
      total: payload.commits.length,
      processed,
      skipped,
      reviewed,
      errorCount: errors.length,
    }, '批量补录完成');

    sendJson(res, 200, {
      total: payload.commits.length,
      processed,
      skipped,
      reviewed,
      errors,
    });
  } catch (err) {
    logger.error({ err }, 'batch hook 处理失败');
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

async function triggerBatchReview(
  repoId: string,
  repoPath: string,
  commit: { hash: string; message: string; author: string; diff?: string },
): Promise<void> {
  const headers = await buildMemoryServiceHeaders();
  const resp = await fetch(`${MEMORY_SERVICE_URL}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: {
        name: 'review_commit',
        arguments: {
          commit_hash: commit.hash,
          message: commit.message,
          branch: '',
          author: commit.author,
          repo_id: repoId,
          repo_path: repoPath,
          classification: 'batch_import',
          diff: commit.diff ?? '',
          files: '',
        },
      },
    }),
    signal: AbortSignal.timeout(BATCH_HOOK_TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new Error(`MCP review_commit 返回 ${resp.status}`);
  }
}
