// Created by dev on 2026/04/07
// Copyright © 2026
// 拓扑 REST API — 供 WebUI 直接 CRUD

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getLogger } from '@memforgeai/shared';
import { TopologyStore } from '../storage/topology-store.js';
import { getPool } from '@memforgeai/shared';
import { getGitStats, getProductLineStats, getHealthAlerts } from '../tools/git-engine/stats-store.js';

const logger = getLogger('topology-api');
let _store: TopologyStore | null = null;
function getStore(): TopologyStore {
  if (!_store) _store = new TopologyStore();
  return _store;
}

export interface TopologyRequestContext {
  userId: string | null;
  userRole: string | null;
  deviceId?: string | null;
  toolContext?: import('../tools/types.js').ToolContext | null;
}

export async function handleTopologyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathParts: string[],
  userCtx?: TopologyRequestContext,
): Promise<void> {
  const method = req.method ?? 'GET';
  const userId = userCtx?.userId ?? null;

  // V-05: 验证内部通信签名
  const internalToken = req.headers['x-memforge-internal-token'] as string | undefined;
  const internalTs = req.headers['x-memforge-internal-ts'] as string | undefined;
  const internalSecret = process.env.MEMFORGE_INTERNAL_SECRET;
  if (internalSecret && internalToken && internalTs) {
    const { verifyInternalRequest } = await import('@memforgeai/shared');
    if (!verifyInternalRequest(internalToken, internalTs, internalSecret)) {
      return sendJson(res, 403, { error: '内部通信签名验证失败' });
    }
  }

  // V-05: 写操作需要角色校验
  const userRole = userCtx?.userRole ?? 'viewer';
  if (method === 'DELETE') {
    if (userRole !== 'admin' && userRole !== 'super_admin') {
      return sendJson(res, 403, { error: '仅管理员可执行删除操作' });
    }
  } else if (method === 'POST' || method === 'PUT') {
    if (userRole !== 'admin' && userRole !== 'super_admin' && userRole !== 'lead') {
      return sendJson(res, 403, { error: '仅 lead 或管理员可执行写操作' });
    }
  }

  try {
    // GET /api/topology/product-lines
    // Gateway 层已按用户权限过滤 productLines 列表，此处返回全量数据
    if (pathParts.length === 1 && pathParts[0] === 'product-lines' && method === 'GET') {
      const productLines = await getStore().listProductLines();
      return sendJson(res, 200, { productLines });
    }

    // GET /api/topology/:productLine/settings — 获取产品线设置（脱敏）
    if (pathParts.length === 2 && pathParts[1] === 'settings' && method === 'GET') {
      const settings = await getProductLineSettings(pathParts[0]);
      return sendJson(res, 200, { settings: maskSettings(settings) });
    }

    // PUT /api/topology/:productLine/settings — 更新产品线设置
    if (pathParts.length === 2 && pathParts[1] === 'settings' && method === 'PUT') {
      const body = await readBody(req);
      await updateProductLineSettings(pathParts[0], body as Record<string, unknown>);
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/topology/:productLine/user-paths — 用户路径覆盖统计
    if (pathParts.length === 2 && pathParts[1] === 'user-paths' && method === 'GET') {
      const coverage = await getStore().getUserPathsCoverage(pathParts[0]);
      return sendJson(res, 200, { coverage });
    }

    // GET /api/topology/:productLine — 注入当前用户+设备的 local_path
    if (pathParts.length === 1 && method === 'GET') {
      const deviceId = userCtx?.deviceId ?? undefined;
      const data = userId
        ? await getStore().getFullTopologyWithUserPaths(pathParts[0], userId, deviceId)
        : await getStore().getFullTopology(pathParts[0]);
      return sendJson(res, 200, data);
    }

    // PUT /api/topology/:productLine/nodes/:repoId (repoId may contain slashes)
    if (pathParts.length >= 3 && pathParts[1] === 'nodes' && method === 'PUT') {
      const pl = pathParts[0];
      const repoId = pathParts.slice(2).join('/');
      const body = await readBody(req);
      const result = await getStore().updateNode(pl, repoId, {
        displayName: body.displayName as string | undefined,
        layerIndex: body.layerIndex as number | undefined,
        layerName: body.layerName as string | undefined,
        description: body.description as string | undefined,
        isHidden: body.isHidden as boolean | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
      });
      if (!result) return sendJson(res, 404, { error: '节点未找到' });
      return sendJson(res, 200, result);
    }

    // POST /api/topology/:productLine/nodes
    if (pathParts.length === 2 && pathParts[1] === 'nodes' && method === 'POST') {
      const pl = pathParts[0];
      const body = await readBody(req);
      if (!body.repoId || !body.displayName) {
        return sendJson(res, 400, { error: '缺少必填字段: repoId, displayName' });
      }
      const result = await getStore().addManualNode(pl, body.repoId as string, body.displayName as string, {
        techStack: body.techStack as string | undefined,
        layerIndex: body.layerIndex as number | undefined,
        layerName: body.layerName as string | undefined,
        description: body.description as string | undefined,
        localPath: body.localPath as string | undefined,
      });
      return sendJson(res, 201, result);
    }

    // POST /api/topology/:productLine/edges
    if (pathParts.length === 2 && pathParts[1] === 'edges' && method === 'POST') {
      const pl = pathParts[0];
      const body = await readBody(req);
      if (!body.fromRepoId || !body.toRepoId || !body.protocol) {
        return sendJson(res, 400, { error: '缺少必填字段: fromRepoId, toRepoId, protocol' });
      }
      const edge = await getStore().addEdge(pl, body.fromRepoId as string, body.toRepoId as string, body.protocol as string, body.sourceFile as string | undefined);
      return sendJson(res, 201, edge);
    }

    // DELETE /api/topology/:productLine/edges/:edgeId
    if (pathParts.length === 3 && pathParts[1] === 'edges' && method === 'DELETE') {
      const edgeId = pathParts[2];
      const ok = await getStore().removeEdge(edgeId);
      return sendJson(res, ok ? 200 : 404, { success: ok });
    }

    // GET /api/topology/:productLine/call-graph — 全量调用关系图
    if (pathParts.length >= 2 && pathParts[1] === 'call-graph' && method === 'GET' && !pathParts[2]) {
      const pl = pathParts[0];
      const result = await getStore().getCallGraph(pl);
      return sendJson(res, 200, result);
    }

    // GET /api/topology/:productLine/call-graph/interfaces?from=X&to=Y — 两节点间接口详情
    if (pathParts.length >= 3 && pathParts[1] === 'call-graph' && pathParts[2] === 'interfaces' && method === 'GET') {
      const pl = pathParts[0];
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';
      if (!from || !to) {
        return sendJson(res, 400, { error: '缺少参数 from 或 to' });
      }
      const interfaces = await getStore().getEdgeInterfaces(pl, from, to);
      return sendJson(res, 200, { interfaces });
    }

    // GET /api/topology/:productLine/call-graph/search — 搜索调用关系子图
    if (pathParts.length >= 3 && pathParts[1] === 'call-graph' && pathParts[2] === 'search' && method === 'GET') {
      const pl = pathParts[0];
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const q = url.searchParams.get('q') || '';
      const searchType = (url.searchParams.get('type') || 'url') as 'url' | 'node' | 'appkey';
      if (!q) {
        return sendJson(res, 400, { error: '缺少查询参数 q' });
      }
      const result = await getStore().searchCallGraph(pl, q, searchType);
      return sendJson(res, 200, result);
    }

    // POST /api/topology/:productLine/call-graph/refresh-traffic — 刷新 Hubble 流量
    if (pathParts.length >= 3 && pathParts[1] === 'call-graph' && pathParts[2] === 'refresh-traffic' && method === 'POST') {
      const pl = pathParts[0];
      const result = await getStore().refreshTraffic(pl);
      return sendJson(res, 200, { message: '流量刷新完成', updated: result.updated });
    }

    // GET /api/topology/:productLine/release-order
    if (pathParts.length === 2 && pathParts[1] === 'release-order' && method === 'GET') {
      const result = await getStore().computeReleaseOrder(pathParts[0]);
      return sendJson(res, 200, result);
    }

    // GET /api/topology/:productLine/impact/:repoId (repoId may contain slashes)
    if (pathParts.length >= 3 && pathParts[1] === 'impact' && method === 'GET') {
      const pl = pathParts[0];
      const repoId = pathParts.slice(2).join('/');
      const result = await getStore().computeChangeImpact(pl, repoId);
      return sendJson(res, 200, result);
    }

    // POST /api/topology/:productLine/import (导入 registry JSON)
    if (pathParts.length === 2 && pathParts[1] === 'import' && method === 'POST') {
      const pl = pathParts[0];
      const body = await readBody(req) as unknown as {
        repos?: Record<string, { localPath?: string; [key: string]: unknown }>;
        productLine?: string;
        edges?: unknown[];
        groups?: Record<string, unknown>;
        force?: boolean;
        [key: string]: unknown;
      };
      if (!body.repos || typeof body.repos !== 'object') {
        return sendJson(res, 400, { error: '无效的 registry 数据：缺少 repos 字段' });
      }
      body.productLine = pl;
      const store = getStore();
      const result = await store.importFromRegistry(body as never, userId ?? undefined);
      if (body.force && userId) {
        const validRepoIds = Object.keys(body.repos);
        await store.cleanupOrphanedByUser(pl, userId, validRepoIds);
      }

      if (userId) {
        const deviceId = userCtx?.deviceId ?? undefined;
        const paths = Object.entries(body.repos)
          .filter(([, r]) => r?.localPath)
          .map(([id, r]) => ({ repoId: id, localPath: r.localPath as string }));
        if (paths.length > 0) {
          try {
            await store.upsertUserPaths(userId, pl, paths, deviceId ?? undefined);
            const validRepoIds = paths.map(p => p.repoId);
            await store.cleanupStaleUserPaths(userId, pl, validRepoIds, deviceId ?? undefined);
          } catch (pathErr) {
            logger.warn({ err: (pathErr as Error).message, userId, pl }, '更新用户本地路径失败（不影响主流程）');
          }
        }
      }

      logger.info({ productLine: pl, ...result }, 'Registry 数据已导入');
      return sendJson(res, 200, { success: true, ...result });
    }

    // POST /api/topology/:productLine/move-nodes — 批量移动节点到另一个产品线
    if (pathParts.length === 2 && pathParts[1] === 'move-nodes' && method === 'POST') {
      const sourcePl = pathParts[0];
      const body = await readBody(req);
      const targetPl = (body.target_product_line as string)?.toLowerCase();
      const repoIds = body.repo_ids as string[] | undefined;
      if (!targetPl) return sendJson(res, 400, { error: '缺少 target_product_line' });
      if (!repoIds || !Array.isArray(repoIds) || repoIds.length === 0) {
        return sendJson(res, 400, { error: '缺少 repo_ids（待移动的节点列表）' });
      }
      if (targetPl === sourcePl.toLowerCase()) {
        return sendJson(res, 400, { error: '源产品线和目标产品线相同' });
      }
      const result = await getStore().moveNodes(sourcePl, targetPl, repoIds);
      logger.info({ sourcePl, targetPl, moved: result }, '批量移动节点完成');
      return sendJson(res, 200, { success: true, ...result });
    }

    // POST /api/topology/:productLine/copy-nodes — 复制节点到另一个产品线（保留源）
    if (pathParts.length === 2 && pathParts[1] === 'copy-nodes' && method === 'POST') {
      const sourcePl = pathParts[0];
      const body = await readBody(req);
      const targetPl = (body.target_product_line as string)?.toLowerCase();
      const repoIds = body.repo_ids as string[] | undefined;
      if (!targetPl) return sendJson(res, 400, { error: '缺少 target_product_line' });
      if (!repoIds || !Array.isArray(repoIds) || repoIds.length === 0) {
        return sendJson(res, 400, { error: '缺少 repo_ids（待复制的节点列表）' });
      }
      if (targetPl === sourcePl.toLowerCase()) {
        return sendJson(res, 400, { error: '源产品线和目标产品线相同' });
      }
      const result = await getStore().copyNodes(sourcePl, targetPl, repoIds);
      logger.info({ sourcePl, targetPl, copied: result }, '批量复制节点完成');
      return sendJson(res, 200, { success: true, ...result });
    }

    // DELETE /api/topology/:productLine (清空产品线数据)
    if (pathParts.length === 1 && method === 'DELETE') {
      const pl = pathParts[0];
      await getStore().clearProductLine(pl);
      return sendJson(res, 200, { success: true, message: `已清空 ${pl} 拓扑数据` });
    }

    // GET /api/topology/:productLine/nodes/:repoId/profile — 项目画像
    if (pathParts.length >= 4 && pathParts[1] === 'nodes' && pathParts[pathParts.length - 1] === 'profile' && method === 'GET') {
      const pl = pathParts[0];
      const repoId = pathParts.slice(2, -1).join('/');
      const profile = await getProjectProfile(pl, repoId);
      return sendJson(res, 200, { profile });
    }

    // GET /api/topology/:productLine/nodes/:repoId/timeline — 关键事件时间线
    if (pathParts.length >= 4 && pathParts[1] === 'nodes' && pathParts[pathParts.length - 1] === 'timeline' && method === 'GET') {
      const pl = pathParts[0];
      const repoId = pathParts.slice(2, -1).join('/');
      const url = new URL(`http://localhost${req.url ?? '/'}`);
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
      const timeline = await getProjectTimeline(pl, repoId, limit);
      return sendJson(res, 200, { timeline });
    }

    // GET /api/topology/:productLine/nodes/:repoId/changelog — 最近提交日志
    if (pathParts.length >= 4 && pathParts[1] === 'nodes' && pathParts[pathParts.length - 1] === 'changelog' && method === 'GET') {
      const pl = pathParts[0];
      const repoId = pathParts.slice(2, -1).join('/');
      const url = new URL(`http://localhost${req.url ?? '/'}`);
      const limit = parseInt(url.searchParams.get('limit') ?? '30', 10);
      const changelog = await getProjectChangelog(pl, repoId, limit);
      return sendJson(res, 200, { changelog });
    }

    // GET /api/topology/:productLine/git-stats — 产品线下所有仓库的 Git 统计
    if (pathParts.length === 2 && pathParts[1] === 'git-stats' && method === 'GET') {
      const stats = await getProductLineStats(pathParts[0]);
      return sendJson(res, 200, { stats });
    }

    // GET /api/topology/:productLine/nodes/:repoId/stats — 单仓库 Git 统计
    if (pathParts.length === 4 && pathParts[1] === 'nodes' && pathParts[3] === 'stats' && method === 'GET') {
      const repoIdDecoded = decodeURIComponent(pathParts[2]);
      const stats = await getGitStats(pathParts[0], repoIdDecoded);
      if (!stats) return sendJson(res, 404, { error: '未找到该仓库的 Git 统计' });
      return sendJson(res, 200, { stats });
    }

    // GET /api/topology/:productLine/health-alerts — 产品线健康度预警
    if (pathParts.length === 2 && pathParts[1] === 'health-alerts' && method === 'GET') {
      const alerts = await getHealthAlerts(pathParts[0]);
      return sendJson(res, 200, { alerts });
    }

    // GET /api/topology/:productLine/nodes/:repoId/bootstrap-status — 查询导入进度
    if (pathParts.length >= 4 && pathParts[1] === 'nodes' && pathParts[pathParts.length - 1] === 'bootstrap-status' && method === 'GET') {
      const repoId = pathParts.slice(2, -1).join('/');
      const status = await getBootstrapStatus(repoId);
      return sendJson(res, 200, { status });
    }

    // POST /api/topology/:productLine/nodes/:repoId/bootstrap — 触发历史导入
    if (pathParts.length >= 4 && pathParts[1] === 'nodes' && pathParts[pathParts.length - 1] === 'bootstrap' && method === 'POST') {
      const toolCtx = userCtx?.toolContext;
      if (!toolCtx) {
        return sendJson(res, 503, { error: 'service_unavailable', message: '服务端不支持直接触发 bootstrap，请通过 MCP 工具调用' });
      }
      const pl = pathParts[0];
      const repoId = pathParts.slice(2, -1).join('/');
      const body = await readBody(req);
      const projectRoot = body.project_root as string | undefined;
      if (!projectRoot) {
        return sendJson(res, 400, { error: 'invalid_request', message: '缺少 project_root 参数' });
      }
      const depth = (body.depth as string) ?? '6months';
      const batchSize = (body.batch_size as number) ?? 50;

      const { runBootstrapFromApi } = await import('../tools/bootstrap-project-history.js');
      const reqCtx = { ...toolCtx, userId: userId ?? toolCtx.userId };
      runBootstrapFromApi(reqCtx, {
        projectRoot, productLine: pl, repoId, depth: depth as 'full' | '6months' | '1year', batchSize, resume: true,
      }).catch(err => logger.error({ err: (err as Error).message, repoId }, 'Bootstrap 后台任务失败'));

      return sendJson(res, 202, { message: '导入任务已启动', repoId, depth, batchSize });
    }

    sendJson(res, 404, { error: 'topology API 路由未找到' });
  } catch (err) {
    logger.error({ err, path: pathParts.join('/') }, '拓扑 API 异常');
    sendJson(res, 500, { error: '服务器内部错误' });
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── 项目画像 API 实现 ──────────────────────────────

async function getProjectProfile(productLine: string, repoId: string): Promise<Record<string, unknown>> {
  const pool = getPool();

  const { rows: nodeRows } = await pool.query<{ metadata: Record<string, unknown>; display_name: string; tech_stack: string; description: string }>(
    `SELECT metadata, display_name, tech_stack, description FROM memory.topology_nodes
     WHERE product_line = $1 AND repo_id = $2`,
    [productLine, repoId],
  );
  const node = nodeRows[0] ?? {};

  const stats = await getGitStats(productLine, repoId);

  const profile: Record<string, unknown> = {
    repoId,
    productLine,
    displayName: node.display_name ?? repoId.split('/').pop(),
    techStack: node.tech_stack ?? 'unknown',
    description: node.description ?? '',
    nodeMetadata: node.metadata ?? {},
    ...(stats ? {
      totalCommits: stats.totalCommits,
      firstCommitAt: stats.firstCommitAt,
      lastCommitAt: stats.lastCommitAt,
      commitsLast7d: stats.commitsLast7d,
      commitsLast30d: stats.commitsLast30d,
      activeContributors7d: stats.activeContributors7d,
      activeContributors30d: stats.activeContributors30d,
      topContributors: stats.topContributors,
      hotFiles30d: stats.hotFiles30d,
      defaultBranch: stats.defaultBranch,
      latestLocalHash: stats.latestLocalHash,
      localBehindCount: stats.localBehindCount,
    } : {}),
  };

  if (node.metadata && typeof node.metadata === 'object' && 'profile' in (node.metadata as Record<string, unknown>)) {
    profile.bootstrapProfile = (node.metadata as Record<string, unknown>).profile;
  }

  return profile;
}

async function getProjectTimeline(productLine: string, repoId: string, limit: number): Promise<unknown[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string; title: string; content: string; scope: string;
    created_at: string; metadata: Record<string, unknown>; tags: string[];
  }>(
    `SELECT id, title, content, scope, created_at, metadata, tags
     FROM memory.entries
     WHERE (
       scope IN ('project_history', 'architecture', 'lesson_learned')
       OR 'from-commit' = ANY(tags)
     )
     AND (
       metadata->>'source_repo_id' = $2
       OR (
         metadata->>'source_product_line' = $1
         AND metadata->>'source_repo_id' IS NULL
         AND scope IN ('project_history', 'architecture')
       )
     )
     AND (
       metadata->>'category' IN ('migration', 'refactor', 'security')
       OR scope IN ('project_history', 'architecture')
       OR (metadata->>'shouldDeepAnalyze')::boolean = true
     )
     AND is_archived = false
     ORDER BY created_at DESC
     LIMIT $3`,
    [productLine, repoId, limit],
  );

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    content: r.content.substring(0, 300),
    scope: r.scope,
    category: r.metadata?.category,
    date: r.created_at,
    author: r.metadata?.author,
    commitHash: r.metadata?.commitHash,
    tags: r.tags,
  }));
}

async function getProjectChangelog(productLine: string, repoId: string, limit: number): Promise<unknown[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string; title: string; content: string; scope: string; source: string;
    created_at: string; metadata: Record<string, unknown>; tags: string[];
  }>(
    `SELECT id, title, content, scope, source, created_at, metadata, tags
     FROM memory.entries
     WHERE 'from-commit' = ANY(tags)
     AND metadata->>'source_product_line' = $1
     AND metadata->>'source_repo_id' = $2
     AND is_archived = false
     ORDER BY created_at DESC
     LIMIT $3`,
    [productLine, repoId, limit],
  );

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    content: r.content.substring(0, 500),
    scope: r.scope,
    source: r.source,
    date: r.created_at,
    author: r.metadata?.author,
    commitHash: r.metadata?.commitHash,
    category: r.metadata?.category,
    filesChanged: r.metadata?.filesChanged,
    insertions: r.metadata?.insertions,
    deletions: r.metadata?.deletions,
  }));
}

async function getBootstrapStatus(repoId: string): Promise<Record<string, unknown> | null> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{
      last_run_at: string; last_status: string; last_result: Record<string, unknown>; run_count: number;
    }>(
      `SELECT last_run_at, last_status, last_result, run_count
       FROM memory.auto_init_state
       WHERE project_id = $1 AND init_type = 'project_bootstrap'`,
      [repoId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      lastRunAt: r.last_run_at,
      status: r.last_status,
      runCount: r.run_count,
      totalCommits: r.last_result?.totalCommits ?? 0,
      processedCommits: r.last_result?.processedCommits ?? 0,
      storedMemories: r.last_result?.storedMemories ?? 0,
      progressPercent: r.last_result?.progressPercent ?? 0,
    };
  } catch {
    return null;
  }
}

async function getProductLineSettings(productLine: string): Promise<Record<string, unknown>> {
  const pool = getPool();
  const { rows } = await pool.query<{ settings: Record<string, unknown>; scan_roots: string[]; git_patterns: string[] }>(
    `SELECT settings, scan_roots, git_patterns FROM memory.product_lines WHERE name = $1 OR slug = $1`,
    [productLine.toLowerCase()],
  );
  if (!rows[0]) return {};
  return { ...rows[0].settings, scan_roots: rows[0].scan_roots ?? [], git_patterns: rows[0].git_patterns ?? [] };
}

async function updateProductLineSettings(productLine: string, updates: Record<string, unknown>): Promise<void> {
  const pool = getPool();
  const { scan_roots, git_patterns, ...settingsUpdates } = updates;
  const current = await getProductLineSettings(productLine);
  const { scan_roots: _sr, git_patterns: _gp, ...currentSettings } = current;
  const merged = { ...currentSettings, ...settingsUpdates };

  const setClauses = ['settings = $2', 'updated_at = NOW()'];
  const params: unknown[] = [productLine.toLowerCase(), JSON.stringify(merged)];

  if (Array.isArray(scan_roots)) {
    setClauses.push(`scan_roots = $${params.length + 1}`);
    params.push(scan_roots);
  }
  if (Array.isArray(git_patterns)) {
    setClauses.push(`git_patterns = $${params.length + 1}`);
    params.push(git_patterns);
  }

  await pool.query(
    `UPDATE memory.product_lines SET ${setClauses.join(', ')} WHERE name = $1 OR slug = $1`,
    params,
  );
}

function maskSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...settings };
  if (typeof masked.git_token === 'string' && masked.git_token.length > 0) {
    const token = masked.git_token as string;
    masked.git_token = token.length > 8
      ? `${token.substring(0, 4)}${'*'.repeat(token.length - 8)}${token.substring(token.length - 4)}`
      : '****';
    masked.has_git_token = true;
  } else {
    masked.has_git_token = false;
  }
  return masked;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('请求体 JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}
