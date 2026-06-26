// Created by dev on 2026/04/12
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import { TaskStore, type AgentTask } from '../storage/task-store.js';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:task-get');

function formatTasksPrompt(tasks: AgentTask[], total: number): string {
  const header = `## Agent 任务列表 (${tasks.length} 条，共 ${total} 条)\n\n`;
  const tableHeader =
    '| # | 优先级 | 标题 | 分类 | 状态 | 创建时间 |\n|---|--------|------|------|------|----------|\n';
  const rows = tasks.map((t, i) => {
    const date = t.created_at ? new Date(t.created_at).toISOString().slice(0, 10) : '';
    const title = String(t.title ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    return `| ${i + 1} | ${t.priority} | ${title} | ${t.category} | ${t.status} | ${date} |`;
  });
  return header + tableHeader + rows.join('\n');
}

export function registerGetAgentTasks(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'get_agent_tasks',
    '查询 Agent 任务列表（支持按分类/状态/产品线/优先级筛选）',
    {
      user_id: z.string().optional().describe('用户 UUID，缺省使用当前 MCP 用户'),
      status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'suspended', 'all']).optional(),
      category: z.string().optional(),
      product_line: z.string().optional(),
      project: z.string().optional(),
      tags_filter: z.array(z.string()).optional(),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
      sort_by: z.enum(['priority', 'created_at', 'updated_at', 'sort_order']).optional(),
      sort_order: z.enum(['asc', 'desc']).optional(),
      format: z.enum(['json', 'prompt']).optional(),
      include_options: z.boolean().optional().describe('同时返回分类/产品线/项目的可选值列表'),
    },
    async (params) => {
      try {
        // 非 admin/lead 只能查询自己的任务，忽略客户端传入的 user_id
        const isPrivileged = ctx.userRole === 'admin' || ctx.userRole === 'lead';
        const userId = isPrivileged ? (params.user_id ?? ctx.userId) : ctx.userId;
        if (!userId) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: '缺少 user_id，且当前会话未绑定用户' }),
            }],
            isError: true,
          };
        }

        const taskStore = new TaskStore();
        const [{ tasks, total }, options] = await Promise.all([
          taskStore.getTasks({
          user_id: userId,
          status: params.status,
          category: params.category,
          product_line: params.product_line,
          project: params.project,
          tags_filter: params.tags_filter,
          priority: params.priority,
          limit: params.limit,
          offset: params.offset,
          sort_by: params.sort_by,
          sort_order: params.sort_order,
        }),
          params.include_options ? taskStore.getDistinctValues(userId) : Promise.resolve(undefined),
        ]);

        if (params.format === 'prompt') {
          const text = formatTasksPrompt(tasks, total);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: true, format: 'prompt', text, total, ...(options ? { options } : {}) }) }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, tasks, total, ...(options ? { options } : {}) }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'get_agent_tasks failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
