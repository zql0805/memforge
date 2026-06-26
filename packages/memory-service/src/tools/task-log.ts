// Created by dev on 2026/04/12
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import { TaskStore } from '../storage/task-store.js';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:task-log');

export function registerLogTaskProgress(server: McpServer, _ctx: ToolContext): void {
  server.tool(
    'log_task_progress',
    '记录任务执行过程日志（同时更新心跳）',
    {
      task_id: z.number(),
      message: z.string(),
      level: z.enum(['info', 'warn', 'error', 'debug']).optional(),
      metadata: z.record(z.unknown()).optional(),
    },
    async (params) => {
      try {
        const taskStore = new TaskStore();
        await taskStore.logProgress({
          task_id: params.task_id,
          message: params.message,
          level: params.level,
          metadata: params.metadata,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'log_task_progress failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
