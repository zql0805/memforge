// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ArchiveMemoryInput, getLogger } from '@memforgeai/shared';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:archive');

export function registerArchiveMemory(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'archive_memory',
    '归档一条记忆（不删除，标记为归档状态）。',
    {
      memory_id: z.string().describe('要归档的记忆 ID'),
      reason: z.string().describe('归档原因（如：分支已合并、规则已升级等）'),
    },
    async (params) => {
      try {
        const input = ArchiveMemoryInput.parse({
          memoryId: params.memory_id,
          reason: params.reason,
        });

        const existing = await ctx.storage.getById(input.memoryId);
        if (!existing) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: `记忆 ${input.memoryId} 不存在` }),
            }],
          };
        }

        // IDOR 防护：非 admin 只能归档自己创建的记忆
        if (ctx.userId && existing.createdBy && existing.createdBy !== ctx.userId) {
          if (ctx.userRole !== 'admin') {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: '无权归档他人创建的记忆' }),
              }],
            };
          }
        }

        if (existing.isArchived) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: '该记忆已处于归档状态' }),
            }],
          };
        }

        const archived = await ctx.storage.archive(input.memoryId, input.reason);
        logger.info({ id: input.memoryId, reason: input.reason }, '记忆已归档');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: archived,
              id: input.memoryId,
              title: existing.title,
              reason: input.reason,
              message: archived ? '记忆已归档。' : '归档失败。',
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'archive_memory 执行失败');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: String(error) }),
          }],
          isError: true,
        };
      }
    },
  );
}
