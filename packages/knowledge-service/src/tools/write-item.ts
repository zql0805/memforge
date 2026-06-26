// Created by dev on 2026/05/25
// P5: write_knowledge_item MCP 工具 — 以文件系统语义创建/更新知识条目

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, KnowledgeType } from '@memforgeai/shared';
import type { KnowledgeToolContext } from './types.js';
import { canModifyKnowledgeItem } from '../auth/permissions.js';
import { slugify, buildVfsUri } from '../vfs/resolver.js';

const logger = getLogger('tool:write-knowledge-item');

export function registerWriteKnowledgeItem(
  server: McpServer,
  ctx: KnowledgeToolContext,
): void {
  server.tool(
    'write_knowledge_item',
    '以文件系统语义创建或更新知识条目。自动生成 slug 和 VFS URI。',
    {
      title: z.string().describe('知识标题'),
      content: z.string().describe('知识内容（Markdown 格式）'),
      category: z.string().optional().describe('分类路径（如 faq/redis）'),
      knowledge_type: KnowledgeType.optional().describe('知识类型（faq/how_to/troubleshooting/technical/project/incident/runbook/api_reference）'),
      question: z.string().optional().describe('关联的问题（FAQ 类型时使用）'),
      tags: z.array(z.string()).optional().describe('标签列表'),
      product_line: z.string().optional().describe('产品线'),
      project_id: z.string().optional().describe('项目 ID'),
      update_id: z.string().optional().describe('如果是更新现有条目，传入 ID'),
    },
    async (params) => {
      try {
        if (!ctx.userId) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: '未认证用户无法写入知识' }) }],
            isError: true,
          };
        }

        const slug = slugify(params.title);

        if (params.update_id) {
          const existing = await ctx.storage.getById(params.update_id);
          if (!existing) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Item not found' }) }],
              isError: true,
            };
          }
          if (!canModifyKnowledgeItem(existing, ctx.userId, ctx.userRole)) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: '无权限修改此知识条目' }) }],
              isError: true,
            };
          }
          const updated = await ctx.storage.update(
            params.update_id,
            {
              title: params.title,
              content: params.content,
              question: params.question,
              tags: params.tags,
              slug,
            },
            ctx.userId,
          );

          if (!updated) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Item not found' }) }],
              isError: true,
            };
          }

          const categoryPath = params.category ? `/${params.category}` : '/';
          const uri = buildVfsUri(categoryPath, slug);

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: true, action: 'updated', id: updated.id, uri, slug }),
            }],
          };
        }

        let embedding: number[] | null = null;
        if (ctx.embedding) {
          try {
            const text = [params.title, params.content].filter(Boolean).join(' ');
            const [vec] = await ctx.embedding.embedBatch([text]);
            embedding = vec;
          } catch (err) {
            logger.warn({ err: String(err), title: params.title }, 'Embedding 生成失败，将由后台队列补充');
          }
        }

        const item = await ctx.storage.store({
          projectId: params.project_id || ctx.projectId || 'default',
          productLine: params.product_line,
          knowledgeType: params.knowledge_type || 'faq',
          category: params.category,
          title: params.title,
          summary: params.content.slice(0, 200),
          content: params.content,
          question: params.question,
          metadata: {},
          tags: params.tags || [],
          answerType: 'direct',
          embedding,
          mediaText: '',
          media: [],
          visibility: 'product_line',
          createdBy: ctx.userId,
        });

        const categoryPath = params.category ? `/${params.category}` : '/';
        const uri = buildVfsUri(categoryPath, slug);

        await ctx.storage.update(item.id, { slug }, ctx.userId);

        logger.info({ id: item.id, slug, uri }, '知识条目已创建');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, action: 'created', id: item.id, uri, slug }),
          }],
        };
      } catch (err) {
        logger.error({ err }, 'write_knowledge_item 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }],
          isError: true,
        };
      }
    },
  );
}
