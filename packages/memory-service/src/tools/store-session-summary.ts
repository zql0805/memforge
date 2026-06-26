// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: store_session_summary — 会话结束时提取关键决策/经验自动存入记忆

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, MemoryScope as MemoryScopeEnum } from '@memforgeai/shared';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:session-summary');

export function registerStoreSessionSummary(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'store_session_summary',
    '在对话结束时存储会话摘要。提取关键决策、解决方案、经验教训，自动存入记忆库以便后续复用。',
    {
      summary: z.string().describe('会话摘要：主要讨论了什么、做了什么决策'),
      decisions: z.array(z.object({
        title: z.string().describe('决策标题'),
        rationale: z.string().describe('决策理由'),
        alternatives: z.array(z.string()).optional().describe('被否决的备选方案'),
      })).optional().describe('关键决策列表'),
      lessons: z.array(z.string()).optional().describe('经验教训列表'),
      scope: MemoryScopeEnum.default('lesson_learned').describe('记忆类型'),
      tags: z.array(z.string()).optional().describe('标签'),
      product_line: z.string().optional().describe('产品线标识'),
      project_id: z.string().optional().describe('显式指定项目标识'),
    },
    async ({ summary, decisions, lessons, scope, tags, product_line, project_id }) => {
      const projectId = project_id ?? product_line ?? ctx.gitContext?.projectName ?? 'default';
      const branchId = null;
      const storedIds: string[] = [];

      // 1. 存储会话摘要
      const summaryTitle = summary.length > 100 ? summary.slice(0, 97) + '...' : summary;
      const summaryContent = buildSummaryContent(summary, decisions, lessons);

      const summaryEmbedding = await ctx.embedding.embedPassage(summaryContent);
      const summaryDup = await ctx.storage.checkDuplicate(summaryEmbedding, ctx.config.deduplicationThreshold);
      if (!summaryDup) {
        const entry = await ctx.storage.store({
          projectId, branchId,
          title: `[会话摘要] ${summaryTitle}`,
          content: summaryContent,
          scope: scope as MemoryScope,
          source: 'ai_suggestion' as MemorySource,
          tags: [...(tags ?? []), 'session-summary', `date:${new Date().toISOString().split('T')[0]}`],
          embedding: summaryEmbedding,
          metadata: {
            sessionDate: new Date().toISOString(),
            decisionCount: decisions?.length ?? 0,
            lessonCount: lessons?.length ?? 0,
          },
          isArchived: false,
          archivedReason: null,
          createdBy: ctx.userId,
          expiresAt: null,
          orgId: ctx.orgId || null,
          teamId: null,
          visibility: 'personal',
        });
        storedIds.push(entry.id);
      }

      // 2. 独立存储每个架构决策
      if (decisions && decisions.length > 0) {
        for (const decision of decisions) {
          const decContent = [
            `决策: ${decision.title}`,
            `理由: ${decision.rationale}`,
            ...(decision.alternatives?.length ? [`否决方案: ${decision.alternatives.join('; ')}`] : []),
          ].join('\n');

          const decEmbedding = await ctx.embedding.embedPassage(`${decision.title} ${decContent}`);
          const decDup = await ctx.storage.checkDuplicate(decEmbedding, ctx.config.deduplicationThreshold);
          if (!decDup) {
            const entry = await ctx.storage.store({
              projectId, branchId,
              title: `[决策] ${decision.title}`,
              content: decContent,
              scope: 'architecture' as MemoryScope,
              source: 'architecture_decision' as MemorySource,
              tags: [...(tags ?? []), 'decision', 'session-summary'],
              embedding: decEmbedding,
              metadata: { sessionDate: new Date().toISOString() },
              isArchived: false,
              archivedReason: null,
              createdBy: ctx.userId,
              expiresAt: null,
              orgId: ctx.orgId || null,
              teamId: null,
              visibility: 'personal',
            });
            storedIds.push(entry.id);
          }
        }
      }

      logger.info({ storedCount: storedIds.length, project: projectId }, '会话摘要已存储');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            stored: storedIds.length,
            ids: storedIds,
            message: `已存储 ${storedIds.length} 条会话记忆（含 ${decisions?.length ?? 0} 个决策）。`,
          }),
        }],
      };
    },
  );
}

function buildSummaryContent(
  summary: string,
  decisions?: Array<{ title: string; rationale: string; alternatives?: string[] }>,
  lessons?: string[],
): string {
  const parts: string[] = [summary];

  if (decisions && decisions.length > 0) {
    parts.push('\n--- 关键决策 ---');
    for (const d of decisions) {
      parts.push(`• ${d.title}: ${d.rationale}`);
    }
  }

  if (lessons && lessons.length > 0) {
    parts.push('\n--- 经验教训 ---');
    for (const l of lessons) {
      parts.push(`• ${l}`);
    }
  }

  return parts.join('\n');
}
