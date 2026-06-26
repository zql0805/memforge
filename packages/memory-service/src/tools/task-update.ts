// Created by dev on 2026/04/12
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import { TaskStore, type RelatedItem } from '../storage/task-store.js';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:task-update');

const relatedItemSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  value: z.string().optional(),
  path: z.string().optional(),
  title: z.string().optional(),
});

function normalizeRelatedItems(
  items: z.infer<typeof relatedItemSchema>[] | undefined,
): RelatedItem[] | undefined {
  if (!items?.length) return undefined;
  return items.map((it) => ({
    type: it.type as RelatedItem['type'],
    id: it.id,
    value: it.value,
    path: it.path,
    title: it.title,
  }));
}

export function registerUpdateAgentTask(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'update_agent_task',
    '更新 Agent 任务状态和执行信息',
    {
      task_id: z.number(),
      status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'suspended']).optional(),
      execution_summary: z.string().optional(),
      execution_issues: z.string().optional(),
      conversation_id: z.string().optional(),
      history_file_path: z.string().optional(),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      product_line: z.string().optional(),
      project: z.string().optional(),
      tags: z.array(z.string()).optional(),
      related_items: z.array(relatedItemSchema).optional(),
      sort_order: z.number().optional(),
      heartbeat: z.boolean().optional(),
      expected_updated_at: z.string().optional().describe('乐观锁：传入上次读取的 updated_at，若不匹配则拒绝更新'),
    },
    async (params) => {
      try {
        const taskStore = new TaskStore();
        const task = await taskStore.updateTask({
          task_id: params.task_id,
          status: params.status,
          title: params.title,
          description: params.description,
          category: params.category,
          product_line: params.product_line,
          project: params.project,
          execution_summary: params.execution_summary,
          execution_issues: params.execution_issues,
          conversation_id: params.conversation_id,
          history_file_path: params.history_file_path,
          priority: params.priority,
          tags: params.tags,
          related_items: normalizeRelatedItems(params.related_items),
          sort_order: params.sort_order,
          heartbeat: params.heartbeat,
          expected_updated_at: params.expected_updated_at,
          userId: ctx.userId,
          userRole: ctx.userRole,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, task }) }],
        };
      } catch (error) {
        logger.error({ error }, 'update_agent_task failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
