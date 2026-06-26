import crypto from 'node:crypto';
import { getLogger, getPool } from '@memforgeai/shared';
import type { IncomingMessage, ServerResponse } from 'node:http';

const logger = getLogger('hooks:gitlab-webhook');

// ─── 类型定义 ───

export interface GitLabWebhookPayload {
  object_kind: 'push' | 'merge_request' | 'note';
  ref?: string;
  commits?: Array<{
    id: string;
    message: string;
    author: { name: string; email: string };
    added: string[];
    modified: string[];
    removed: string[];
  }>;
  object_attributes?: {
    iid: number;
    title: string;
    description: string;
    source_branch: string;
    target_branch: string;
    state: 'opened' | 'closed' | 'merged';
    action: 'open' | 'close' | 'reopen' | 'update' | 'merge' | 'approved';
    work_in_progress: boolean;
    author_id: number;
    last_commit: { id: string; message: string; author: { name: string } };
    url: string;
  };
  project: {
    id: number;
    path_with_namespace: string;
    web_url: string;
  };
}

// ─── 认证：全局 secret 优先，降级到按项目 DB 查找 ───

export function hashSecret(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function verifyGitLabToken(req: IncomingMessage, projectPath: string): Promise<boolean> {
  const token = req.headers['x-gitlab-token'];
  if (typeof token !== 'string') return false;

  const globalSecret = process.env.GITLAB_WEBHOOK_SECRET;
  if (globalSecret && safeCompare(token, globalSecret)) return true;

  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT webhook_secret_hash FROM memory.webhook_configs
       WHERE project_path = $1 AND is_active = TRUE LIMIT 1`,
      [projectPath],
    );
    if (rows.length === 0) return false;
    return safeCompare(hashSecret(token), rows[0].webhook_secret_hash);
  } catch (err) {
    logger.warn({ err }, '按项目查找 webhook secret 失败，降级为全局验证');
    return false;
  }
}

// ─── GitLab API：获取单个 commit 的 diff ───

async function fetchCommitDiff(
  gitlabUrl: string,
  projectId: number,
  commitSha: string,
  privateToken: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch(
      `${gitlabUrl}/api/v4/projects/${projectId}/repository/commits/${commitSha}/diff`,
      { headers: { 'PRIVATE-TOKEN': privateToken }, signal: controller.signal },
    );
    if (!resp.ok) return '';
    const diffs = (await resp.json()) as Array<{ old_path: string; new_path: string; diff: string }>;
    return diffs
      .map(d => `--- a/${d.old_path}\n+++ b/${d.new_path}\n${d.diff}`)
      .join('\n');
  } catch (err) {
    logger.warn({ err, commitSha: commitSha.slice(0, 8) }, 'GitLab commit diff 获取失败');
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Push 事件处理：逐 commit 调用已有 handler ───

async function handlePushEvent(
  payload: GitLabWebhookPayload,
  sendJson: (res: ServerResponse, status: number, data: unknown) => void,
  res: ServerResponse,
  memoryServiceUrl: string,
): Promise<void> {
  const commits = payload.commits ?? [];
  if (commits.length === 0) {
    return sendJson(res, 200, { status: 'skipped', reason: 'no_commits' });
  }

  const ref = payload.ref ?? '';
  const branch = ref.replace('refs/heads/', '');
  const project = payload.project;
  const gitlabUrl = process.env.GITLAB_URL || 'https://gitlab.example.com';
  const privateToken = process.env.GITLAB_PRIVATE_TOKEN;

  const { handleCommitHook } = await import('./commit-handler.js');

  let processed = 0;
  for (const commit of commits) {
    const files = [...commit.added, ...commit.modified];
    let diff = '';
    if (privateToken) {
      diff = await fetchCommitDiff(gitlabUrl, project.id, commit.id, privateToken);
    }

    const fakeRes = createNoopResponse();
    await handleCommitHook(
      {
        commit: commit.id,
        message: commit.message,
        author: commit.author.name,
        branch,
        stats: '',
        files: files.join(','),
        deleted_files: commit.removed.join(','),
        repo: project.path_with_namespace.split('/').pop() ?? project.path_with_namespace,
        repo_id: project.path_with_namespace,
        repo_path: '',
        timestamp: Date.now(),
        is_merge: commit.message.toLowerCase().startsWith('merge '),
        diff,
      },
      (_r, _s, _d) => {},
      fakeRes as ServerResponse,
      memoryServiceUrl,
    );
    processed++;
  }

  sendJson(res, 200, { status: 'accepted', event: 'push', commits_processed: processed });
}

function createNoopResponse(): Partial<ServerResponse> {
  return {
    writeHead: () => ({} as ServerResponse),
    end: () => ({} as ServerResponse),
    write: () => true,
  };
}

// ─── 主入口 ───

export async function handleGitLabWebhook(
  req: IncomingMessage,
  sendJson: (res: ServerResponse, status: number, data: unknown) => void,
  res: ServerResponse,
  body: GitLabWebhookPayload,
  memoryServiceUrl: string,
): Promise<void> {
  const projectPath = body.project?.path_with_namespace ?? '';
  if (!(await verifyGitLabToken(req, projectPath))) {
    logger.warn({ ip: req.socket.remoteAddress, project: projectPath }, 'GitLab Webhook 认证失败');
    return sendJson(res, 401, { error: 'unauthorized', message: 'X-Gitlab-Token 无效' });
  }

  const eventType = body.object_kind;
  logger.info({
    event: eventType,
    project: body.project?.path_with_namespace,
    action: body.object_attributes?.action,
  }, 'GitLab Webhook 接收');

  switch (eventType) {
    case 'push':
      return handlePushEvent(body, sendJson, res, memoryServiceUrl);

    case 'merge_request': {
      const { handleMergeRequestEvent } = await import('./mr-handler.js');
      return handleMergeRequestEvent(body, sendJson, res, memoryServiceUrl);
    }

    default:
      return sendJson(res, 200, { status: 'ignored', reason: `event_type=${eventType}` });
  }
}
