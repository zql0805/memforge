#!/usr/bin/env node
// Created by dev on 2026/04/04
// Copyright © 2026
// Memforge Rules Engine — 支持 stdio / HTTP 双传输模式

import { createRulesServer, initRulesContext, buildRulesMcpServer } from './server.js';
import { getLogger, closePool, runWithRLSAsync } from '@memforgeai/shared';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const logger = getLogger('rules-engine');

async function main() {
  const transportMode = process.env.TRANSPORT_MODE ?? 'stdio';

  try {
    if (transportMode === 'http') {
      // HTTP 模式：stateless per-request，重资源只初始化一次
      const ctx = await initRulesContext();

      logger.info('MCP Server 已注册 17 个工具 + 1 个资源 (含 M6 技能树/知识图谱)');

      const port = parseInt(process.env.PORT ?? '3002', 10);
      const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
      const http = await import('node:http');

      const httpServer = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/mcp') {
          const userId = (req.headers['x-memforge-user-id'] as string) ?? null;
          const orgId = (req.headers['x-memforge-org-id'] as string) ?? null;
          const userRole = (req.headers['x-memforge-user-role'] as string) ?? null;
          const teamId = (req.headers['x-memforge-team-id'] as string) || null;
          const reqCtx = userId || userRole ? { ...ctx, userId, userRole, teamId, orgId } : ctx;
          const server = buildRulesMcpServer(reqCtx);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          await server.connect(transport);

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
        } else if (req.url === '/health') {
          const mem = process.memoryUsage();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            service: 'memforge-rules',
            uptime: Math.floor(process.uptime()),
            memory: { rss: Math.floor(mem.rss / 1048576), heap: Math.floor(mem.heapUsed / 1048576) },
            pid: process.pid,
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      const host = process.env.BIND_HOST ?? '127.0.0.1';
      httpServer.listen(port, host, () => {
        logger.info({ host, port, mode: 'http' }, 'Memforge Rules Engine 运行中 (HTTP 模式)');
      });
    } else {
      // stdio 模式：单实例长连接
      const server = await createRulesServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      logger.info('Memforge Rules Engine 运行中 (stdio 模式)');
    }
  } catch (error) {
    logger.error({ error }, 'Rules Engine 启动失败');
    await closePool();
    process.exit(1);
  }
}

main();
