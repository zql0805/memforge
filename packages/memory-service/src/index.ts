#!/usr/bin/env node
// Created by dev on 2026/04/04
// Copyright © 2026
// Memforge Memory Service — 支持 stdio / HTTP 双传输模式

import { createMemoryServer, initMemoryContext, buildMcpServer } from './server.js';
import { getLogger, closePool } from '@memforgeai/shared';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startTopologyAutoSync } from './auto/topology-sync.js';
import { startRulesMdcSync } from './auto/rules-mdc-sync.js';
import { runAutoInitHook } from './auto/init-hook.js';
import { GitChangeEngine } from './tools/git-engine/index.js';
import { handleTopologyRequest } from './api/topology-api.js';
import { handleRecallRequest } from './api/recall-api.js';
import { startGatewayWsClient } from './ws/gateway-client.js';
import { startRetentionScheduler } from './retention/cleanup.js';

const logger = getLogger('memory-service');

async function main() {
  const transportMode = process.env.TRANSPORT_MODE ?? 'stdio';

  try {
    if (transportMode === 'http') {
      // HTTP 模式：stateless per-request，重资源只初始化一次
      const ctx = await initMemoryContext();

      logger.info('MCP Server 已注册 37 个工具 (含 5 个基础记忆 + 5 个自动学习 + 2 个拓扑桥接 + 4 个拓扑查询 + 2 个导出导入 + 6 个知识积累 + 3 个工作追踪 + 6 个 Agent 任务 + 1 个开发者画像 + 1 个系统规则 + 1 个校验 + 1 个 API 索引)');

      startTopologyAutoSync(ctx).catch((err: Error) => {
        logger.warn({ err: err.message }, '拓扑自动同步启动失败（不影响主服务）');
      });
      runAutoInitHook(ctx).catch((err: Error) => {
        logger.warn({ err: err.message }, '自动初始化检查失败（不影响主服务）');
      });
      startRulesMdcSync().catch((err: Error) => {
        logger.warn({ err: err.message }, 'Rules ↔ .mdc 双向同步启动失败（不影响主服务）');
      });
      startRetentionScheduler();

      if (process.env.MEMFORGE_GIT_ENGINE !== 'off') {
        const gitEngine = new GitChangeEngine(ctx);
        gitEngine.start();
      }

      const port = parseInt(process.env.PORT ?? '3001', 10);
      const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
      const http = await import('node:http');

      const httpServer = http.createServer(async (req, res) => {
        // CORS
        const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173').split(',').map(s => s.trim());
        const origin = req.headers.origin ?? '';
        const corsOrigin = allowedOrigins.includes('*') ? '*' : (allowedOrigins.includes(origin) ? origin : '');
        if (corsOrigin) res.setHeader('Access-Control-Allow-Origin', corsOrigin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        const url = req.url ?? '/';

        if (req.method === 'POST' && url === '/mcp') {
          const userId = (req.headers['x-memforge-user-id'] as string) || null;
          const orgId = (req.headers['x-memforge-org-id'] as string) || null;
          const teamId = (req.headers['x-memforge-team-id'] as string) || null;
          const userRole = (req.headers['x-memforge-user-role'] as string) || null;
          const deviceId = (req.headers['x-memforge-device-id'] as string) || null;
          const isSuperAdmin = req.headers['x-memforge-super-admin'] === 'true';
          const reqCtx = userId || orgId || teamId || userRole || deviceId || isSuperAdmin ? { ...ctx, userId, orgId, teamId, userRole, deviceId, isSuperAdmin } : ctx;
          const server = buildMcpServer(reqCtx);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          await server.connect(transport);

          const { runWithRLSAsync } = await import('@memforgeai/shared');
          const rlsCtx = userId && orgId && userRole ? { userId, orgId, userRole } : undefined;
          if (rlsCtx) {
            await runWithRLSAsync(rlsCtx, () => transport.handleRequest(req, res));
          } else {
            await transport.handleRequest(req, res);
          }

          res.on('close', () => {
            transport.close();
            server.close();
          });
        } else if (url === '/health') {
          const mem = process.memoryUsage();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            service: 'memforge-memory',
            uptime: Math.floor(process.uptime()),
            memory: { rss: Math.floor(mem.rss / 1048576), heap: Math.floor(mem.heapUsed / 1048576) },
            pid: process.pid,
          }));
        } else if (url.startsWith('/api/topology/')) {
          const pathParts = url.replace('/api/topology/', '').split('?')[0].split('/').filter(Boolean);
          const topoUserId = (req.headers['x-memforge-user-id'] as string) ?? null;
          const topoUserRole = (req.headers['x-memforge-user-role'] as string) ?? null;
          const topoDeviceId = (req.headers['x-memforge-device-id'] as string) ?? null;
          await handleTopologyRequest(req, res, pathParts, { userId: topoUserId, userRole: topoUserRole, deviceId: topoDeviceId, toolContext: ctx });
        } else if (url === '/api/memory/recall' && req.method === 'POST') {
          const userId = (req.headers['x-memforge-user-id'] as string) || ctx.userId;
          const orgId = (req.headers['x-memforge-org-id'] as string) || ctx.orgId;
          const teamId = (req.headers['x-memforge-team-id'] as string) || ctx.teamId;
          const userRole = (req.headers['x-memforge-user-role'] as string) || ctx.userRole;
          const recallCtx = { ...ctx, userId, orgId, teamId, userRole };

          const { runWithRLSAsync } = await import('@memforgeai/shared');
          const rlsCtx = userId && orgId && userRole ? { userId, orgId, userRole } : undefined;
          if (rlsCtx) {
            await runWithRLSAsync(rlsCtx, () => handleRecallRequest(req, res, recallCtx));
          } else {
            await handleRecallRequest(req, res, recallCtx);
          }
        } else if (url === '/api/memories/distinct-projects' && req.method === 'GET') {
          const userId = (req.headers['x-memforge-user-id'] as string) || null;
          const orgId = (req.headers['x-memforge-org-id'] as string) || null;
          const userRole = (req.headers['x-memforge-user-role'] as string) || null;
          if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized', message: '此接口需要认证' }));
            return;
          }

          const { runWithRLSAsync } = await import('@memforgeai/shared');
          const rlsCtx = userId && orgId && userRole ? { userId, orgId, userRole } : undefined;
          const respond = async () => {
            const projectIds = await ctx.storage.getDistinctProjectIds();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ projectIds }));
          };
          if (rlsCtx) {
            await runWithRLSAsync(rlsCtx, respond);
          } else {
            await respond();
          }
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      const host = process.env.BIND_HOST ?? '127.0.0.1';
      httpServer.listen(port, host, () => {
        logger.info({ host, port, mode: 'http' }, 'Memforge Memory Service 运行中 (HTTP 模式)');
      });
    } else {
      // stdio 模式：单实例长连接
      const server = await createMemoryServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      logger.info('Memforge Memory Service 运行中 (stdio 模式)');

      // 如果配置了 Gateway URL，启动 WebSocket 连接以支持远程扫描
      const wsClient = startGatewayWsClient();
      if (wsClient) {
        logger.info('已启动 Gateway WebSocket 连接（支持远程扫描）');
        process.on('SIGTERM', () => wsClient.close());
        process.on('SIGINT', () => wsClient.close());
      }
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ err: err.message, stack: err.stack }, 'Memory Service 启动失败');
    await closePool();
    process.exit(1);
  }
}

main();
