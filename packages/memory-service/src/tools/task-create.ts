// Created by dev on 2026/04/12
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import { TaskStore, type RelatedItem } from '../storage/task-store.js';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:task-create');

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

export function registerCreateAgentTask(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'create_agent_task',
    '创建一个 Agent 任务',
    {
      title: z.string(),
      description: z.string().optional(),
      category: z.string().optional(),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
      product_line: z.string().optional(),
      project: z.string().optional(),
      tags: z.array(z.string()).optional(),
      related_items: z.array(relatedItemSchema).optional(),
      sort_order: z.number().optional(),
      status: z.enum(['pending', 'suspended']).optional().describe('初始状态，默认 pending'),
    },
    async (params) => {
      try {
        if (!ctx.userId) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: '当前会话未绑定用户，无法创建任务' }),
            }],
            isError: true,
          };
        }

        const taskStore = new TaskStore();
        const task = await taskStore.createTask({
          user_id: ctx.userId,
          title: params.title,
          description: params.description,
          category: params.category,
          priority: params.priority,
          status: params.status,
          product_line: params.product_line,
          project: params.project,
          tags: params.tags,
          related_items: normalizeRelatedItems(params.related_items),
          sort_order: params.sort_order,
          created_by: ctx.userId,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, task }) }],
        };
      } catch (error) {
        logger.error({ error }, 'create_agent_task failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
