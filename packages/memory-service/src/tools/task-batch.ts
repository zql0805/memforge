// Created by dev on 2026/04/12
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import { TaskStore } from '../storage/task-store.js';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:task-batch');

export function registerBatchUpdateTasks(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'batch_update_tasks',
    '批量更新多个任务的状态/分类/优先级',
    {
      task_ids: z.array(z.number()).max(100),
      updates: z.object({
        status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'suspended']).optional(),
        category: z.string().optional(),
        priority: z.string().optional(),
        execution_issues: z.string().optional(),
      }),
    },
    async (params) => {
      try {
        const taskStore = new TaskStore();
        const result = await taskStore.batchUpdateTasks(
          params.task_ids,
          params.updates as Record<string, unknown>,
          ctx.userId,
          ctx.userRole,
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, ...result }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'batch_update_tasks failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
