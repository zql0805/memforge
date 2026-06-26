import { getLogger, getPool } from '@memforgeai/shared';
import type { ServerResponse } from 'node:http';
import { getReviewBranches } from './shared-config.js';
import type { GitLabWebhookPayload } from './gitlab-webhook-handler.js';

const logger = getLogger('hooks:mr');

const MR_DIFF_TIMEOUT_MS = 30_000;
const GITLAB_NOTE_TIMEOUT_MS = 15_000;
const MEMFORGE_NOTE_MARKER = '<!-- memforge-review -->';

// ─── MR 事件入口 ───

export async function handleMergeRequestEvent(
  payload: GitLabWebhookPayload,
  sendJson: (res: ServerResponse, status: number, data: unknown) => void,
  res: ServerResponse,
  memoryServiceUrl: string,
): Promise<void> {
  if (!payload.object_attributes) {
    return sendJson(res, 200, { status: 'skipped', reason: 'missing_object_attributes' });
  }
  const mr = payload.object_attributes;
  const project = payload.project;

  if (!['open', 'update'].includes(mr.action)) {
    return sendJson(res, 200, { status: 'skipped', reason: `action=${mr.action}` });
  }

  const skipWip = process.env.MR_SKIP_WIP !== 'false';
  if (
    skipWip &&
    (mr.work_in_progress || mr.title.startsWith('WIP:') || mr.title.startsWith('Draft:'))
  ) {
    return sendJson(res, 200, { status: 'skipped', reason: 'wip_or_draft' });
  }

  const reviewTargets = getReviewBranches();
  if (!reviewTargets.has(mr.target_branch)) {
    return sendJson(res, 200, { status: 'skipped', reason: 'target_branch_not_reviewable' });
  }

  if (await isDuplicate(project.path_with_namespace, mr.iid, mr.last_commit.id)) {
    return sendJson(res, 200, { status: 'skipped', reason: 'already_reviewed' });
  }

  triggerMrReview(project, mr, memoryServiceUrl).catch(err => {
    logger.error({ err, mrIid: mr.iid, project: project.path_with_namespace }, 'MR 审查触发失败');
  });

  sendJson(res, 200, { status: 'accepted', mr_iid: mr.iid });
}

// ─── 去重检查 ───

async function isDuplicate(repoId: string, mrIid: number, commitHash: string): Promise<boolean> {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT 1 FROM memory.code_reviews
       WHERE repo_id = $1 AND mr_iid = $2 AND commit_hash = $3
       LIMIT 1`,
      [repoId, mrIid, commitHash],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

// ─── 产品线推断 ───

function inferProductLine(repoPath: string): string | undefined {
  const group = repoPath.split('/')[0];
  if (!group || group === repoPath) return undefined;
  const groupMap: Record<string, string> = JSON.parse(
    process.env.GITLAB_GROUP_MAP || '{"live":"default","lateral":"default","trade":"default"}'
  );
  return groupMap[group] || group;
}

// ─── 核心审查触发 ───

async function triggerMrReview(
  project: GitLabWebhookPayload['project'],
  mr: NonNullable<GitLabWebhookPayload['object_attributes']>,
  memoryServiceUrl: string,
): Promise<void> {
  const gitlabUrl = process.env.GITLAB_URL || 'https://gitlab.example.com';
  const privateToken = process.env.GITLAB_PRIVATE_TOKEN;
  if (!privateToken) {
    logger.warn('GITLAB_PRIVATE_TOKEN 未配置，跳过 MR 审查');
    return;
  }

  const { diff, files } = await fetchMrDiff(gitlabUrl, project.id, mr.iid, privateToken);
  if (!diff || files.length === 0) {
    logger.info({ mrIid: mr.iid }, 'MR diff 为空，跳过');
    return;
  }

  await triggerReviewViaMcp(memoryServiceUrl, project, mr, diff, files);
}

// ─── MCP 调用方式（当直接 import pipeline 失败时的降级路径）───

async function triggerReviewViaMcp(
  memoryServiceUrl: string,
  project: GitLabWebhookPayload['project'],
  mr: NonNullable<GitLabWebhookPayload['object_attributes']>,
  diff: string,
  files: string[],
): Promise<void> {
  const crypto = await import('node:crypto');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const internalSecret = process.env.MEMFORGE_INTERNAL_SECRET;
  if (internalSecret) {
    try {
      const { getInternalHeaders } = await import('@memforgeai/shared');
      Object.assign(headers, getInternalHeaders(internalSecret));
    } catch { /* shared 不可用，继续 */ }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
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
            commit_hash: mr.last_commit.id,
            message: `[MR !${mr.iid}] ${mr.title}`,
            branch: mr.source_branch,
            author: mr.last_commit.author.name,
            repo_id: project.path_with_namespace,
            repo_path: '',
            classification: 'merge_request',
            diff,
            files: files.join(','),
            review_type: 'merge_request',
            mr_iid: mr.iid,
            mr_url: mr.url,
            gitlab_project_id: project.id,
          },
        },
      }),
    });
    const body = await resp.json();
    logger.info({ mrIid: mr.iid, status: resp.status }, 'MR review_commit MCP 响应');

    if (process.env.MR_NOTE_ENABLED !== 'false') {
      const gitlabUrl = process.env.GITLAB_URL || 'https://gitlab.example.com';
      const privateToken = process.env.GITLAB_PRIVATE_TOKEN;
      if (privateToken) {
        await upsertMrNote(gitlabUrl, project.id, mr.iid, privateToken, body);
      }
    }
  } catch (err) {
    logger.warn({ err, mrIid: mr.iid }, 'MCP review_commit 调用失败');
  } finally {
    clearTimeout(timeout);
  }
}

// ─── 获取 MR 累积 diff ───

async function fetchMrDiff(
  gitlabUrl: string,
  projectId: number,
  mrIid: number,
  privateToken: string,
): Promise<{ diff: string; files: string[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MR_DIFF_TIMEOUT_MS);

  try {
    const resp = await fetch(
      `${gitlabUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/changes?access_raw_diffs=true`,
      {
        headers: { 'PRIVATE-TOKEN': privateToken },
        signal: controller.signal,
      },
    );

    if (!resp.ok) {
      throw new Error(`GitLab API 返回 ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as {
      changes?: Array<{ old_path: string; new_path: string; diff: string }>;
    };
    if (!data.changes || data.changes.length === 0) {
      return { diff: '', files: [] };
    }

    const files: string[] = [];
    const diffParts: string[] = [];

    for (const change of data.changes) {
      files.push(change.new_path);
      diffParts.push(`--- a/${change.old_path}\n+++ b/${change.new_path}\n${change.diff}`);
    }

    return { diff: diffParts.join('\n'), files };
  } catch (err) {
    logger.error({ err, projectId, mrIid }, 'MR diff 获取失败');
    return { diff: '', files: [] };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── GitLab MR Note Upsert ───

async function upsertMrNote(
  gitlabUrl: string,
  projectId: number,
  mrIid: number,
  privateToken: string,
  result: unknown,
): Promise<void> {
  const noteBody = MEMFORGE_NOTE_MARKER + '\n' + buildMrNoteBody(result);
  const headers = { 'PRIVATE-TOKEN': privateToken, 'Content-Type': 'application/json' };

  try {
    const existingNoteId = await findExistingNote(gitlabUrl, projectId, mrIid, privateToken);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITLAB_NOTE_TIMEOUT_MS);

    try {
      if (existingNoteId) {
        await fetch(
          `${gitlabUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes/${existingNoteId}`,
          { method: 'PUT', headers, body: JSON.stringify({ body: noteBody }), signal: controller.signal },
        );
        logger.info({ projectId, mrIid, noteId: existingNoteId }, 'MR Note 已更新');
      } else {
        await fetch(
          `${gitlabUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes`,
          { method: 'POST', headers, body: JSON.stringify({ body: noteBody }), signal: controller.signal },
        );
        logger.info({ projectId, mrIid }, 'MR Note 已创建');
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    logger.error({ err, projectId, mrIid }, 'GitLab MR Note 回写失败（审查结果已持久化到 DB）');
  }
}

async function findExistingNote(
  gitlabUrl: string,
  projectId: number,
  mrIid: number,
  privateToken: string,
): Promise<number | null> {
  try {
    const resp = await fetch(
      `${gitlabUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes?per_page=100&sort=desc`,
      { headers: { 'PRIVATE-TOKEN': privateToken } },
    );
    if (!resp.ok) return null;
    const notes = (await resp.json()) as Array<{ id: number; body: string }>;
    const found = notes.find(n => n.body.includes(MEMFORGE_NOTE_MARKER));
    return found?.id ?? null;
  } catch {
    return null;
  }
}

function buildMrNoteBody(result: unknown): string {
  const r = result as Record<string, unknown> | null;
  if (!r) return '## Memforge Code Review\n\n审查完成，未返回结果。';

  const totalFindings = (r.totalFindings as number) ?? 0;
  const p0 = (r.p0Count as number) ?? 0;
  const p1 = (r.p1Count as number) ?? 0;
  const p2 = (r.p2Count as number) ?? 0;
  const duration = (r.duration as number) ?? 0;

  const lines: string[] = ['## 🔍 Memforge Code Review', ''];

  if (totalFindings === 0) {
    lines.push('✅ **未发现问题**');
  } else {
    lines.push(`发现 **${totalFindings}** 个问题：`);
    if (p0 > 0) lines.push(`- 🔴 P0 (必须修复): ${p0}`);
    if (p1 > 0) lines.push(`- 🟡 P1 (建议修复): ${p1}`);
    if (p2 > 0) lines.push(`- 🔵 P2 (可选优化): ${p2}`);
  }

  lines.push('', `> 耗时 ${(duration / 1000).toFixed(1)}s | Powered by Memforge`);

  return lines.join('\n');
}
