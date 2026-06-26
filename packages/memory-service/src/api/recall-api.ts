// Created by dev on 2026/06/04
// recall_memory REST API handler — POST /api/memory/recall

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { getLogger } from '@memforgeai/shared';
import type { ToolContext } from '../tools/types.js';
import { executeRecallSearch, type RecallSearchParams } from '../search/recall-engine.js';

const logger = getLogger('api:recall');

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 200;
const cache = new Map<string, { ts: number; data: unknown }>();

function cacheKey(
  userId: string,
  orgId: string | null | undefined,
  teamId: string | null | undefined,
  body: Record<string, unknown>,
): string {
  const raw = JSON.stringify({ u: userId, o: orgId ?? '', tid: teamId ?? '', ...body });
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function getCached(key: string): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.data;
}

function putCache(key: string, data: unknown): void {
  if (cache.size >= CACHE_MAX_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), data });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

export async function handleRecallRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ToolContext,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const body = await readBody(req);
    const query = body.query as string;
    if (!query) {
      sendJson(res, 400, { error: 'query is required' });
      return;
    }

    const userId = (req.headers['x-memforge-user-id'] as string) || ctx.userId;
    const orgId = (req.headers['x-memforge-org-id'] as string) || ctx.orgId;
    const teamId = (req.headers['x-memforge-team-id'] as string) || ctx.teamId;

    const params: RecallSearchParams = {
      query,
      scopeFilter: body.scope_filter as string[] | undefined,
      tagsFilter: body.tags_filter as string[] | undefined,
      includeArchived: body.include_archived as boolean | undefined,
      limit: body.limit as number | undefined,
      minSimilarity: body.min_similarity as number | undefined,
      format: (body.format as 'json' | 'prompt') ?? 'json',
      productLine: (body.product_line ?? body.productLine) as string | undefined,
      crossProject: body.cross_project as boolean | undefined,
      crossTeam: body.cross_team as boolean | undefined,
      teamFilter: body.team_filter as string[] | undefined,
      maxContentLength: (body.max_content_length ?? body.maxContentLength) as number | undefined,
      timeDecay: body.time_decay as boolean | undefined,
      searchMethod: body.search_method as 'semantic' | 'keyword' | 'hybrid' | undefined,
      detailLevel: body.detail_level as 'full' | 'summary' | undefined,
    };

    const key = cacheKey(userId ?? '', orgId, teamId, body);
    const cached = getCached(key);
    if (cached) {
      sendJson(res, 200, cached);
      return;
    }

    const result = await executeRecallSearch(params, {
      storage: ctx.storage,
      embedding: ctx.embedding,
      userId,
      orgId,
      teamId,
      gitProjectName: ctx.gitContext?.projectName ?? null,
      gitBranchName: ctx.gitContext?.branchName ?? null,
    });

    putCache(key, result);
    sendJson(res, 200, result);
  } catch (err) {
    logger.error({ err }, 'recall REST API error');
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { error: message });
  }
}
