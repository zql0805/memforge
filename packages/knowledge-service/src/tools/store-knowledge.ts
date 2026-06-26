// Created by dev on 2026/05/21
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, KnowledgeType, MemoryVisibility } from '@memforgeai/shared';
import type { KnowledgeToolContext } from './types.js';

const logger = getLogger('knowledge:store-tool');

export function registerStoreKnowledge(server: McpServer, ctx: KnowledgeToolContext): void {
  server.tool(
    'store_knowledge',
    'Store a knowledge item (FAQ, technical doc, incident, etc.)',
    {
      project_id: z.string().describe('Project ID'),
      product_line: z.string().optional().describe('Product line'),
      knowledge_type: KnowledgeType.optional().describe('Type: faq/how_to/troubleshooting/technical/project/incident/runbook/api_reference'),
      category: z.string().optional().describe('Category'),
      title: z.string().describe('Title (max 200 chars)'),
      question: z.string().optional().describe('Question (max 2000 chars, optional)'),
      content: z.string().describe('Content (max 20000 chars)'),
      summary: z.string().optional().describe('Summary (max 500 chars)'),
      metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
      tags: z.array(z.string()).optional().describe('Tags'),
      answer_type: z.string().optional().describe('Answer type: direct/guide/escalate'),
      visibility: MemoryVisibility.optional().describe('Visibility: personal/team/product_line/global'),
    },
    async (params) => {
      try {
        if (!ctx.userId) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: '未认证用户无法写入知识' }) }],
            isError: true,
          };
        }
        let embedding: number[] | null = null;
        if (ctx.embedding) {
          try {
            const text = [params.title, params.summary, params.question, params.content].filter(Boolean).join(' ');
            const [vec] = await ctx.embedding.embedBatch([text]);
            embedding = vec;
          } catch (err) {
            logger.warn({ err: String(err), title: params.title }, 'Embedding 生成失败，将由后台队列补充');
          }
        }

        const item = await ctx.storage.store({
          projectId: params.project_id,
          productLine: params.product_line,
          knowledgeType: params.knowledge_type ?? 'faq',
          category: params.category,
          title: params.title,
          summary: params.summary,
          content: params.content,
          question: params.question,
          metadata: params.metadata,
          tags: params.tags ?? [],
          answerType: params.answer_type ?? 'direct',
          embedding,
          mediaText: '',
          media: [],
          sourceType: 'manual',
          status: 'published',
          visibility: params.visibility ?? 'product_line',
          createdBy: ctx.userId,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, id: item.id }) }],
        };
      } catch (err) {
        logger.warn({ err }, 'store_knowledge 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }],
          isError: true,
        };
      }
    },
  );
}
