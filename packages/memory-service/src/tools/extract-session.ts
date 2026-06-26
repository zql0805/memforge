// Created by dev on 2026/05/25
// P4-B: extract_session_memories MCP 工具

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, loadLlmConfig } from '@memforgeai/shared';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { SessionExtractor } from '../session/extractor.js';
import { MemoryDeduplicator } from '../session/deduplicator.js';
import { resolveVisibilityContext } from '../services/team-resolver.js';
import { clampVisibilityByRole } from '../services/visibility-guard.js';

const logger = getLogger('tool:extract-session');

export interface LLMProvider {
  chat(messages: Array<{ role: string; content: string }>, options?: { signal?: AbortSignal }): Promise<string>;
}

export function createSessionLlmProvider(): LLMProvider | undefined {
  const llmConfig = loadLlmConfig();
  if (!llmConfig) return undefined;

  return {
    async chat(messages, options?) {
      const response = await fetch(`${llmConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${llmConfig.apiKey}`,
        },
        body: JSON.stringify({ model: llmConfig.model, messages, temperature: 0.3, max_tokens: 4096 }),
        signal: options?.signal ?? AbortSignal.timeout(180_000),
      });

      if (!response.ok) {
        throw new Error(`LLM API ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices?.[0]?.message?.content ?? '';
    },
  };
}

export function registerExtractSessionMemories(
  server: McpServer,
  ctx: ToolContext,
  llmProvider?: LLMProvider,
): void {
  server.tool(
    'extract_session_memories',
    '自动从当前会话内容中提取有价值的记忆（架构决策、Bug 模式、经验教训、编码规范、用户画像、实体引用）。在会话结束时调用，替代手动 store_session_summary。',
    {
      session_content: z.string().describe('会话的核心内容（对话摘要或关键片段）'),
      product_line: z.string().optional().describe('产品线标识'),
      dry_run: z.boolean().optional().describe('仅分析不存储（默认 false）'),
    },
    async (params) => {
      if (!llmProvider) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'LLM provider not configured. Use store_session_summary instead.',
            }),
          }],
          isError: true,
        };
      }

      try {
        const extractor = new SessionExtractor(llmProvider);
        const { memories } = await extractor.extract(params.session_content);

        if (memories.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message: '未发现需要提取的有价值记忆',
                extracted: 0,
              }),
            }],
          };
        }

        const deduplicator = new MemoryDeduplicator(
          ctx.storage, ctx.embedding, llmProvider,
          ctx.config.deduplicationThreshold,
        );

        const projectId = ctx.gitContext?.projectName ?? 'unknown';
        const visCtx = ctx.userId
          ? await resolveVisibilityContext(ctx.userId, ctx.orgId, ctx.teamId)
          : { orgId: null, userId: null, teamIds: [], accessibleProductLines: [] };
        const results: Array<{
          title: string;
          scope: string;
          action: string;
          reason: string;
          id?: string;
        }> = [];

        for (const memory of memories) {
          if (params.dry_run) {
            results.push({
              title: memory.title,
              scope: memory.scope,
              action: 'DRY_RUN',
              reason: '仅分析模式',
            });
            continue;
          }

          const dedupResult = await deduplicator.deduplicate(memory, projectId, {
            orgId: visCtx.orgId,
            userId: visCtx.userId,
            teamIds: visCtx.teamIds,
            accessibleProductLines: visCtx.accessibleProductLines,
          });

          if (dedupResult.action === 'SKIP') {
            results.push({
              title: memory.title,
              scope: memory.scope,
              action: 'SKIP',
              reason: dedupResult.reason,
            });
            continue;
          }

          if (dedupResult.action === 'MERGE' && dedupResult.mergeWithId && dedupResult.mergedContent) {
            await ctx.storage.update(dedupResult.mergeWithId, {
              content: dedupResult.mergedContent,
              title: memory.title,
            });
            results.push({
              title: memory.title,
              scope: memory.scope,
              action: 'MERGE',
              reason: dedupResult.reason,
              id: dedupResult.mergeWithId,
            });
            continue;
          }

          if (dedupResult.action === 'DELETE' && dedupResult.mergeWithId) {
            await ctx.storage.archive(dedupResult.mergeWithId, '被新记忆取代');
          }

          const embedding = await ctx.embedding.embedQuery(`${memory.title}\n${memory.content}`);
          const safeVisibility = clampVisibilityByRole(memory.visibility, ctx.userRole);
          const entry = await ctx.storage.store({
            projectId,
            branchId: ctx.gitContext?.branchName ?? null,
            title: memory.title,
            content: memory.content,
            scope: memory.scope as MemoryScope,
            source: 'session_extraction' as MemorySource,
            tags: memory.tags,
            embedding,
            metadata: { extractedFrom: 'session', productLine: params.product_line },
            createdBy: ctx.userId,
            visibility: safeVisibility,
            orgId: ctx.orgId,
            teamId: ctx.teamId,
            isArchived: false,
            archivedReason: null,
            expiresAt: null,
          });

          results.push({
            title: memory.title,
            scope: memory.scope,
            action: dedupResult.action,
            reason: dedupResult.reason,
            id: entry.id,
          });
        }

        const summary = {
          success: true,
          extracted: memories.length,
          stored: results.filter(r => r.action === 'CREATE' || r.action === 'DELETE').length,
          merged: results.filter(r => r.action === 'MERGE').length,
          skipped: results.filter(r => r.action === 'SKIP').length,
          details: results,
        };

        logger.info({
          extracted: summary.extracted,
          stored: summary.stored,
          merged: summary.merged,
          skipped: summary.skipped,
        }, '会话记忆提取完成');

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(summary) }],
        };
      } catch (err) {
        logger.error({ err }, 'extract_session_memories 执行失败');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: String(err) }),
          }],
          isError: true,
        };
      }
    },
  );
}
