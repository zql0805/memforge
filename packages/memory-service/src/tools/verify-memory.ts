// Created by dev on 2026/04/09
// Copyright © 2026
// MCP 工具: verify_memory — lead/admin 审核确认记忆条目

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, getPool } from '@memforgeai/shared';
import type { MemoryEntry } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { resolveVisibilityContext } from '../services/team-resolver.js';

const logger = getLogger('tool:verify-memory');

export function registerVerifyMemory(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'verify_memory',
    '审核确认一条记忆：标记为已验证（verified），verified 记忆在 recall 时获得排序加权。仅 lead/admin 角色可用。',
    {
      memory_id: z.string().describe('记忆条目 ID'),
      verified: z.boolean().describe('true=确认验证，false=取消验证'),
    },
    async (params) => {
      try {
        if (ctx.userRole !== 'admin' && ctx.userRole !== 'lead') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: 'verify_memory 仅限 admin/lead 角色使用。' }),
            }],
          };
        }

        const existing = await ctx.storage.getById(params.memory_id);
        if (!existing) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: `记忆 ${params.memory_id} 不存在。` }),
            }],
          };
        }

        const canVerify = await canOperatorVerifyMemory(existing, ctx);
        if (!canVerify) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: '无权验证该记忆：需与操作者同属一个组织或可访问的产品线。',
              }),
            }],
          };
        }

        const pool = getPool();
        await pool.query(
          'UPDATE memory.entries SET is_verified = $1, updated_at = NOW() WHERE id = $2',
          [params.verified, params.memory_id],
        );

        logger.info({
          memoryId: params.memory_id,
          verified: params.verified,
          verifiedBy: ctx.userId,
        }, '记忆审核状态变更');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              memory_id: params.memory_id,
              title: existing.title,
              is_verified: params.verified,
              message: params.verified
                ? '记忆已标记为「已验证」，在 recall 检索时将获得排序加权。'
                : '记忆已取消验证标记。',
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'verify_memory 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}

async function canOperatorVerifyMemory(entry: MemoryEntry, ctx: ToolContext): Promise<boolean> {
  if (!ctx.userId) return false;

  const visCtx = await resolveVisibilityContext(ctx.userId, ctx.orgId ?? null, ctx.teamId ?? null, true);
  const sameOrg = !!(entry.orgId && ctx.orgId && entry.orgId === ctx.orgId);
  const sameProductLine = visCtx.accessibleProductLines.includes(entry.projectId);

  if (sameOrg || sameProductLine) {
    return true;
  }

  if (entry.visibility === 'team' && entry.teamId && visCtx.teamIds.includes(entry.teamId)) {
    return true;
  }

  return false;
}
