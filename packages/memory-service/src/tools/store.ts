// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StoreMemoryInput, MemoryScope, MemorySource, ProjectScope, MemoryVisibility, getLogger } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { autoLinkNewMemory } from '../services/auto-link.js';
import { tryBridgeToRule } from '../services/rule-bridge.js';
import { routeByScope, writeToKnowledge } from '../storage/storage-router.js';
import { clampVisibilityByRole } from '../services/visibility-guard.js';

const logger = getLogger('tool:store');

export function registerStoreMemory(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'store_memory',
    '存储一条记忆到知识库。记忆会自动向量化并与当前项目/分支关联。',
    {
      title: z.string().describe('记忆标题，简洁描述（< 200 字符）'),
      content: z.string().describe('记忆内容，详细描述经验、教训、决策等'),
      scope: MemoryScope.describe('记忆类型，参见 MemoryScope 枚举'),
      source: MemorySource.optional().describe('记忆来源，参见 MemorySource 枚举'),
      tags: z.array(z.string()).optional().describe('标签列表'),
      metadata: z.record(z.unknown()).optional().describe('附加元数据'),
      project_scope: ProjectScope.optional().describe('可见范围: branch/project/organization'),
      product_line: z.string().optional().describe('产品线标识（跨项目共享记忆时指定，如 "my-product"），不传则使用当前项目名'),
      project_id: z.string().optional().describe('显式指定项目标识（优先级高于自动检测的 Git 项目名，如 "memforge"、"my-api"）'),
      visibility: MemoryVisibility.optional().describe(
        '可见性级别：personal（仅创建者，默认）、team（同团队可见）、product_line（产品线可见）、global（全局可见）。' +
        '全局规范建议设为 global，产品线通用经验设为 product_line',
      ),
    },
    async (params) => {
      try {
        const input = StoreMemoryInput.parse({
          title: params.title,
          content: params.content,
          scope: params.scope,
          source: params.source ?? 'manual',
          tags: params.tags ?? [],
          metadata: params.metadata ?? {},
          projectScope: params.project_scope ?? 'project',
        });

        const scanResult = ctx.scanner.scan(input.content);
        if (scanResult.blocked) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: scanResult.blockReason,
                detections: scanResult.detections,
              }),
            }],
          };
        }

        const contentToStore = scanResult.sanitizedContent ?? input.content;

        const embedding = await ctx.embedding.embedPassage(`${input.title} ${contentToStore}`);

        // P4-A: user_profile 追加合并 — 避免 profile 碎片化
        if (input.scope === 'user_profile' && ctx.userId) {
          const existing = await ctx.storage.list({
            scope: 'user_profile' as import('@memforgeai/shared').MemoryScope,
            createdBy: ctx.userId,
            includeArchived: false,
            limit: 1,
            sortBy: 'updated_at DESC',
          });
          if (existing.entries.length > 0) {
            const old = existing.entries[0];
            const merged = old.content.length < 2000
              ? `${old.content}\n\n---\n${new Date().toISOString().split('T')[0]}\n${contentToStore}`
              : `${old.content.slice(0, 1500)}\n\n---\n${new Date().toISOString().split('T')[0]}\n${contentToStore}`;
            await ctx.storage.update(old.id, { content: merged, embedding });
            logger.info({ id: old.id }, 'user_profile 追加合并完成');
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  id: old.id,
                  action: 'merged',
                  message: '已追加合并到现有 user_profile 记忆',
                }),
              }],
            };
          }
        }

        const duplicate = await ctx.storage.checkDuplicate(embedding, ctx.config.deduplicationThreshold);
        if (duplicate) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: '检测到高度相似的已有记忆，请确认是否需要更新而非新建。',
                existingMemory: {
                  id: duplicate.id,
                  title: duplicate.title,
                  createdAt: duplicate.createdAt,
                },
              }),
            }],
          };
        }

        const gitContext = ctx.gitContext;
        const resolvedVisibility = clampVisibilityByRole(params.visibility, ctx.userRole);

        let resolvedProjectId: string;
        if (resolvedVisibility === 'global') {
          resolvedProjectId = '_global_';
        } else if (resolvedVisibility === 'product_line' && params.product_line) {
          resolvedProjectId = params.product_line;
        } else {
          resolvedProjectId = params.project_id ?? params.product_line ?? gitContext?.projectName ?? 'default';
        }

        const resolvedTeamId = resolvedVisibility === 'personal' ? null : (ctx.teamId ?? null);

        const entry = await ctx.storage.store({
          projectId: resolvedProjectId,
          branchId: input.projectScope === 'branch' ? (gitContext?.branchName ?? null) : null,
          title: input.title,
          content: contentToStore,
          scope: input.scope,
          source: input.source,
          tags: input.tags,
          embedding,
          metadata: {
            ...input.metadata,
            source_project: gitContext?.projectName ?? params.product_line ?? params.project_id ?? 'unknown',
            source_product_line: params.product_line ?? null,
            ...(scanResult.sanitizedContent ? { sanitized: true, sanitizedFields: scanResult.detections.map(d => d.type) } : {}),
          },
          isArchived: false,
          archivedReason: null,
          createdBy: ctx.userId,
          expiresAt: null,
          orgId: ctx.orgId || null,
          teamId: resolvedTeamId || null,
          visibility: resolvedVisibility,
        });

        logger.info({ id: entry.id, scope: entry.scope, project: entry.projectId }, '记忆存储成功');

        const route = routeByScope(input.scope);
        if (route.type === 'dual' || route.type === 'knowledge') {
          const knowledgeType = 'knowledgeType' in route ? route.knowledgeType : 'technical';
          writeToKnowledge({
            projectId: resolvedProjectId,
            productLine: params.product_line,
            title: input.title,
            content: contentToStore,
            knowledgeType,
            sourceType: input.source,
            sourceRef: `memory:${entry.id}`,
            tags: input.tags,
            visibility: resolvedVisibility,
          }).catch(err => {
            logger.debug({ err, entryId: entry.id }, 'store_memory dual-write 到知识库失败（降级）');
          });
        }

        autoLinkNewMemory(
          entry.id, ctx.storage, ctx.embedding,
          [entry.projectId],
        ).catch(err => logger.warn({ error: err }, '自动关联异步执行失败'));

        let bridgedRuleId: string | null = null;
        try {
          bridgedRuleId = await tryBridgeToRule({
            memoryId: entry.id,
            title: entry.title,
            content: contentToStore,
            scope: entry.scope,
            projectId: resolvedProjectId,
            embedding,
            createdBy: ctx.userId,
          });
        } catch (err) {
          logger.warn({ error: err }, '规则桥接异步执行失败');
        }

        const bridgeNote = bridgedRuleId
          ? '（已自动创建 rules candidate，可通过 vote_rule 投票激活）'
          : '';

        const codeRelatedScopes = ['coding_standard', 'bug_pattern', 'performance_insight', 'review_insight', 'convention'];
        const isCodeRelated = codeRelatedScopes.includes(input.scope);
        const rulesWarning = (isCodeRelated && !ctx.rulesLoadedAt)
          ? '⚠️ 本会话尚未调用 get_system_rules 加载编码规范。建议在存储编码类记忆前先加载规范，避免与现有规则重复。'
          : undefined;

        if (rulesWarning) {
          logger.warn({ scope: input.scope }, 'store_memory 触发编码类存储但本会话未加载系统规则');
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              id: entry.id,
              title: entry.title,
              scope: entry.scope,
              project: entry.projectId,
              branch: gitContext?.branchName ?? null,
              createdAt: entry.createdAt,
              bridgedRuleId,
              message: `记忆已存储。${scanResult.sanitizedContent ? '（部分内容已自动脱敏）' : ''}${bridgeNote}`,
              ...(rulesWarning && { warning: rulesWarning }),
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'store_memory 执行失败');
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
