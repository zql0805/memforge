// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UpdateMemoryInput, getLogger } from '@memforgeai/shared';
import type { MemoryVisibility } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { clampVisibilityByRole } from '../services/visibility-guard.js';

const logger = getLogger('tool:update');

export function registerUpdateMemory(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'update_memory',
    '更新一条已有记忆的内容、标签或元数据。',
    {
      memory_id: z.string().describe('要更新的记忆 ID'),
      title: z.string().optional().describe('新标题'),
      content: z.string().optional().describe('新内容'),
      tags: z.array(z.string()).optional().describe('新标签列表'),
      metadata: z.record(z.unknown()).optional().describe('新元数据'),
      visibility: z.enum(['personal', 'team', 'product_line', 'global']).optional().describe(
        '修改可见范围：personal（仅创建者）、team（同团队）、product_line（产品线）、global（全局）',
      ),
      product_line: z.string().optional().describe('产品线标识（visibility 为 product_line 时必填）'),
    },
    async (params) => {
      try {
        const input = UpdateMemoryInput.parse({
          memoryId: params.memory_id,
          title: params.title,
          content: params.content,
          tags: params.tags,
          metadata: params.metadata,
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

        // IDOR 防护：非 admin 只能修改自己创建的记忆
        // createdBy 为 NULL 的旧数据无法校验归属，允许更新但记录告警
        if (ctx.userId && !existing.createdBy) {
          logger.warn({ memoryId: input.memoryId, userId: ctx.userId }, '旧记忆缺少 createdBy，跳过归属校验');
        } else if (ctx.userId && existing.createdBy && existing.createdBy !== ctx.userId) {
          if (ctx.userRole !== 'admin') {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: '无权修改他人创建的记忆' }),
              }],
            };
          }
        }

        if (input.content) {
          const scanResult = ctx.scanner.scan(input.content);
          if (scanResult.blocked) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: scanResult.blockReason }),
              }],
            };
          }
          if (scanResult.sanitizedContent) {
            input.content = scanResult.sanitizedContent;
          }
        }

        let newEmbedding: number[] | undefined;
        if (input.title || input.content) {
          const textToEmbed = `${input.title ?? existing.title} ${input.content ?? existing.content}`;
          newEmbedding = await ctx.embedding.embedPassage(textToEmbed);
        }

        let newProjectId: string | undefined;
        let newVisibility: MemoryVisibility | undefined;
        let newTeamId: string | null | undefined;
        if (params.visibility) {
          newVisibility = clampVisibilityByRole(params.visibility, ctx.userRole);
          if (newVisibility === 'global') {
            newProjectId = '_global_';
            newTeamId = null;
          } else if (newVisibility === 'product_line' && params.product_line) {
            newProjectId = params.product_line;
            newTeamId = ctx.teamId ?? null;
          } else if (newVisibility === 'personal') {
            newProjectId = ctx.gitContext?.projectName ?? 'default';
            newTeamId = null;
          } else if (newVisibility === 'team') {
            newProjectId = ctx.gitContext?.projectName ?? 'default';
            newTeamId = ctx.teamId ?? null;
          }
        }

        const updated = await ctx.storage.update(input.memoryId, {
          projectId: newProjectId,
          title: input.title,
          content: input.content,
          tags: input.tags,
          metadata: input.metadata,
          embedding: newEmbedding,
          visibility: newVisibility,
          teamId: newTeamId,
        });

        logger.info({ id: input.memoryId }, '记忆更新成功');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              id: updated!.id,
              title: updated!.title,
              updatedAt: updated!.updatedAt,
              message: '记忆已更新。',
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'update_memory 执行失败');
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
