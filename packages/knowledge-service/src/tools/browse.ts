// Created by dev on 2026/05/25
// P5: browse_knowledge MCP 工具 — 按文件系统语义浏览知识库

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { KnowledgeToolContext } from './types.js';
import { parseVfsUri } from '../vfs/resolver.js';
import { formatDirectoryListing } from '../vfs/formatter.js';
import { resolveKnowledgeVisibilityFilters } from '../auth/visibility.js';

const logger = getLogger('tool:browse-knowledge');

export function registerBrowseKnowledge(
  server: McpServer,
  ctx: KnowledgeToolContext,
): void {
  server.tool(
    'browse_knowledge',
    '按文件系统语义浏览知识库目录。返回指定路径下的子分类和知识条目列表。',
    {
      uri: z.string().optional().describe('VFS URI（如 memforge://kb/faq/redis），不传则浏览根目录'),
      product_line: z.string().optional().describe('产品线过滤'),
      page: z.number().optional().describe('页码（默认 1）'),
      page_size: z.number().optional().describe('每页条目数（默认 20）'),
    },
    async (params) => {
      try {
        const uri = params.uri || 'memforge://kb/';
        const parsed = parseVfsUri(uri);

        if (!parsed) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Invalid VFS URI' }) }],
            isError: true,
          };
        }

        const categoryPath = parsed.categoryPath;
        const allCategories = await ctx.storage.listCategories(params.product_line);

        let targetCategory: typeof allCategories[number] | null = null;
        const normalizedPath = categoryPath.replace(/^\/+/, '');
        if (categoryPath !== '/') {
          targetCategory = allCategories.find(
            c => (c as unknown as Record<string, unknown>).fullPath === categoryPath
              || c.slug === normalizedPath
              || c.slug === categoryPath.split('/').pop(),
          ) ?? null;
        }

        const subcategories = allCategories.filter(c => {
          if (categoryPath === '/') return !c.parentId;
          return c.parentId === targetCategory?.id;
        });

        const page = params.page ?? 1;
        const pageSize = params.page_size ?? 20;

        const categorySlug = categoryPath === '/'
          ? undefined
          : (targetCategory?.slug ?? normalizedPath);

        const visibilityFilters = await resolveKnowledgeVisibilityFilters(ctx, params.product_line);
        const { items } = await ctx.storage.list({
          productLine: params.product_line,
          category: categorySlug,
          status: 'published',
          page,
          pageSize,
          visibilityFilters,
        });

        const listing = formatDirectoryListing(categoryPath, subcategories, items);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...listing }) }],
        };
      } catch (err) {
        logger.error({ err }, 'browse_knowledge 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }],
          isError: true,
        };
      }
    },
  );
}
