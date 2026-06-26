// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: store_log_insight — ES 日志排查结论自动存入记忆库

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:store-log-insight');

export function registerStoreLogInsight(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'store_log_insight',
    '将 ES 日志排查的结论存入记忆库。当通过 es-search 查到问题原因后，自动记录错误模式和解决方案，下次遇到相似问题可直接召回。',
    {
      error_pattern: z.string().describe('错误模式/关键字（如 "redis_like_snail"、"MySQL server has gone away"）'),
      service_name: z.string().describe('涉及的服务名'),
      root_cause: z.string().describe('根因分析'),
      solution: z.string().describe('解决方案'),
      es_query: z.string().optional().describe('用于定位问题的 ES 查询条件'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).default('medium').describe('严重程度'),
      product_line: z.string().optional().describe('产品线标识（跨项目共享时指定，如 "my-product"）'),
      tags: z.array(z.string()).optional().describe('额外标签'),
    },
    async ({ error_pattern, service_name, root_cause, solution, es_query, severity, product_line, tags }) => {
      const projectId = product_line ?? ctx.gitContext?.projectName ?? 'default';
      const plTag = product_line ? `pl:${product_line.toLowerCase()}` : undefined;

      const content = [
        `错误模式: ${error_pattern}`,
        `服务: ${service_name}`,
        `严重程度: ${severity}`,
        '',
        `根因: ${root_cause}`,
        '',
        `解决方案: ${solution}`,
        ...(es_query ? ['', `ES 查询: ${es_query}`] : []),
      ].join('\n');

      const title = `[日志洞察] ${service_name}: ${error_pattern}`;
      const embedding = await ctx.embedding.embedPassage(`${title} ${content}`);

      const dup = await ctx.storage.checkDuplicate(embedding, 0.88);
      if (dup) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: '已存在相似的日志洞察记忆',
              existingId: dup.id,
              existingTitle: dup.title,
            }),
          }],
        };
      }

      const entry = await ctx.storage.store({
        projectId,
        branchId: null,
        title,
        content,
        scope: 'bug_pattern' as MemoryScope,
        source: 'bug_fix' as MemorySource,
        tags: [
          ...(tags ?? []),
          ...(plTag ? [plTag] : []),
          'log-insight', 'es-search',
          `service:${service_name}`,
          `severity:${severity}`,
        ],
        embedding,
        metadata: {
          errorPattern: error_pattern,
          serviceName: service_name,
          severity,
          esQuery: es_query ?? null,
          storedAt: new Date().toISOString(),
        },
        isArchived: false,
        archivedReason: null,
        createdBy: ctx.userId,
        expiresAt: null,
        orgId: ctx.orgId || null,
        teamId: null,
        visibility: 'personal',
      });

      logger.info({ id: entry.id, service: service_name, pattern: error_pattern }, '日志洞察已存储');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            id: entry.id,
            title: entry.title,
            message: `日志排查结论已存入记忆库。下次遇到 "${error_pattern}" 相关问题时将自动召回。`,
          }),
        }],
      };
    },
  );
}
