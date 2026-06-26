#!/usr/bin/env node
// Created by dev on 2026/05/21
// Memforge Knowledge Service — HTTP transport

import { initKnowledgeContext, buildKnowledgeMcpServer } from './server.js';
import { getLogger, closePool } from '@memforgeai/shared';
import { handleKnowledgeApiRequest } from './api/handler.js';
import { loadVlmConfig, VlmExtractor } from './import/vlm-extractor.js';

const logger = getLogger('knowledge-service');

async function main() {
  const transportMode = process.env.TRANSPORT_MODE ?? 'http';

  if (transportMode !== 'http') {
    logger.error('Knowledge service only supports HTTP mode');
    process.exit(1);
  }

  const { ctx, searchEngine, embedQueue, importer, lifecycle } = await initKnowledgeContext();

  if (ctx.embedding) {
    embedQueue.startInterval();
    logger.info('Embed queue started');
  } else {
    logger.warn('Embedding 未启用，跳过 embed queue');
  }

  const vlmConfig = loadVlmConfig();
  const vlmExtractor = vlmConfig ? new VlmExtractor(vlmConfig) : null;
  if (vlmExtractor) {
    logger.info({ model: vlmConfig!.model }, 'VLM 图片提取已启用');
  }

  const port = parseInt(process.env.PORT ?? '3003', 10);
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const http = await import('node:http');

  const httpServer = http.createServer(async (req, res) => {
    const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3000').split(',').map(s => s.trim());
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
      const reqCtx = { ...ctx, userId, orgId, teamId, userRole, deviceId, isSuperAdmin };
      const server = buildKnowledgeMcpServer(reqCtx, searchEngine);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      res.on('close', () => { transport.close(); server.close(); });
    } else if (url === '/health') {
      const mem = process.memoryUsage();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok', service: 'memforge-knowledge',
        uptime: Math.floor(process.uptime()),
        memory: { rss: Math.floor(mem.rss / 1048576), heap: Math.floor(mem.heapUsed / 1048576) },
        pid: process.pid,
      }));
    } else if (url.startsWith('/api/knowledge/')) {
      const userId = (req.headers['x-memforge-user-id'] as string) || null;
      const orgId = (req.headers['x-memforge-org-id'] as string) || null;
      const teamId = (req.headers['x-memforge-team-id'] as string) || null;
      const userRole = (req.headers['x-memforge-user-role'] as string) || null;
      await handleKnowledgeApiRequest(req, res, {
        storage: ctx.storage, searchEngine, embedding: ctx.embedding, importer, lifecycle, userId, userRole, orgId, teamId, vlmExtractor,
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const host = process.env.BIND_HOST ?? '127.0.0.1';
  httpServer.listen(port, host, () => {
    logger.info({ host, port, mode: 'http' }, 'Memforge Knowledge Service running');
  });

  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    httpServer.close();
    await closePool();
    process.exit(0);
  });
}

main().catch(err => {
  logger.error({ err }, 'Knowledge Service startup failed');
  process.exit(1);
});
