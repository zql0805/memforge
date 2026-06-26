#!/usr/bin/env node
// Created by dev on 2026/04/05
// Copyright © 2026
// Memforge MCP Gateway — OAuth 2.1 + RBAC + 审计日志

import { getLogger, closePool } from '@memforgeai/shared';
import { loadGatewayConfig } from './config.js';
import { createGateway } from './server.js';

const logger = getLogger('gateway');

async function main() {
  try {
    const config = loadGatewayConfig();
    const { server, ctx } = await createGateway(config);

    server.listen(config.port, config.host, () => {
      logger.info({
        host: config.host,
        port: config.port,
        memoryService: config.memoryServiceUrl,
        rulesService: config.rulesServiceUrl,
      }, 'Memforge Gateway 运行中');

      // 预热后端服务连接，降低首次请求延迟
      ctx.router.warmUp().catch((err) => {
        logger.warn({ err }, '后端服务连接预热失败');
      });
    });

    const shutdown = async (signal: string) => {
      logger.info({ signal }, '正在优雅关闭...');

      server.close();
      ctx.rateLimiter.destroy();
      await ctx.auditLogger.destroy();
      await closePool();

      logger.info('Gateway 已关闭');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error({ error }, 'Gateway 启动失败');
    await closePool();
    process.exit(1);
  }
}

main();
