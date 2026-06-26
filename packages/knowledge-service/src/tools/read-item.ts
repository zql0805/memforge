// Created by dev on 2026/05/25
// P5: read_knowledge_item MCP 工具 — 读取单条知识并格式化为 Markdown

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { KnowledgeToolContext } from './types.js';
import { parseVfsUri } from '../vfs/resolver.js';
import { formatAsMarkdown } from '../vfs/formatter.js';
import { canViewKnowledgeItem, resolveKnowledgeVisibilityFilters } from '../auth/visibility.js';

const logger = getLogger('tool:read-knowledge-item');

export function registerReadKnowledgeItem(
  server: McpServer,
  ctx: KnowledgeToolContext,
): void {
  server.tool(
    'read_knowledge_item',
    '读取单条知识条目，返回 Markdown 格式的完整内容。支持 ID 或 VFS URI。',
    {
      id: z.string().optional().describe('知识条目 ID（与 uri 二选一）'),
      uri: z.string().optional().describe('VFS URI（如 memforge://kb/faq/redis/redis-timeout）'),
    },
    async (params) => {
      try {
        let item = null;

        if (params.id) {
          item = await ctx.storage.getById(params.id);
        } else if (params.uri) {
          const parsed = parseVfsUri(params.uri);
          if (parsed && parsed.slug && !parsed.isDirectory) {
            item = await ctx.storage.getBySlug(parsed.slug);
          }
        }

        if (!item) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Knowledge item not found' }) }],
            isError: true,
          };
        }

        const visFilters = await resolveKnowledgeVisibilityFilters(ctx, item.productLine ?? undefined);
        if (!canViewKnowledgeItem(item, {
          ...ctx,
          accessibleProductLines: visFilters?.accessibleProductLines,
        })) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Knowledge item not found' }) }],
            isError: true,
          };
        }

        ctx.storage.incrementQueryCount([item.id]).catch((err) => {
          logger.debug({ err, id: item.id }, 'incrementQueryCount 失败（非阻塞）');
        });

        const markdown = formatAsMarkdown(item);
        return {
          content: [{ type: 'text' as const, text: markdown }],
        };
      } catch (err) {
        logger.error({ err }, 'read_knowledge_item 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }],
          isError: true,
        };
      }
    },
  );
}
