// Created by dev on 2026/04/06
// Copyright © 2026
// MCP 工具: store_code_review — Code Review 发现结构化存储到记忆库
// AI 完成 Code Review 后自动调用，将 P0/P1 级发现存为可检索记忆

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { tryBridgeToRule } from '../services/rule-bridge.js';
import { matchAndRecordViolations } from '../services/rule-matcher.js';
import { clampVisibilityByRole } from '../services/visibility-guard.js';

const logger = getLogger('tool:store-code-review');

const FindingSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2']).describe('严重级别：P0=必须修复, P1=建议修复, P2=可选优化'),
  category: z.enum([
    'security', 'exception_handling', 'logic', 'performance',
    'compatibility', 'naming', 'architecture', 'other',
  ]).describe('问题分类'),
  file: z.string().describe('文件路径'),
  line: z.number().optional().describe('行号'),
  description: z.string().describe('问题描述'),
  suggestion: z.string().optional().describe('修复建议'),
  fixed: z.boolean().default(false).describe('是否已在本次修复'),
});

export function registerStoreCodeReview(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'store_code_review',
    '存储 Code Review 结果到记忆库。将代码审查中发现的安全、性能、逻辑等问题结构化存储，供未来检索复用。仅存储 P0/P1 级问题。',
    {
      review_summary: z.string().describe('Review 总结：本次审查了什么变更、整体质量如何'),
      findings: z.array(FindingSchema).describe('Review 发现列表'),
      files_reviewed: z.array(z.string()).optional().describe('审查的文件列表'),
      tags: z.array(z.string()).optional().describe('额外标签'),
      product_line: z.string().optional().describe('产品线标识'),
      project_id: z.string().optional().describe('显式指定项目标识'),
      visibility: z.enum(['personal', 'team', 'product_line', 'global']).default('personal').describe(
        '可见性级别：personal（仅创建者，默认）、team（同团队可见）、product_line（产品线可见）、global（全局可见）',
      ),
    },
    async ({ review_summary, findings, files_reviewed, tags, product_line, project_id, visibility }) => {
      const fallbackProjectId = project_id ?? product_line ?? ctx.gitContext?.projectName ?? 'default';
      const branchId = null;
      const storedIds: string[] = [];

      const importantFindings = findings.filter(f => f.severity === 'P0' || f.severity === 'P1');

      if (importantFindings.length === 0) {
        return text(JSON.stringify({
          success: true,
          stored: 0,
          message: '未发现 P0/P1 级问题，无需存储。',
        }));
      }

      const bridgedRuleIds: string[] = [];

      // 按分类聚合发现
      const byCategory = new Map<string, typeof importantFindings>();
      for (const f of importantFindings) {
        const key = f.category;
        if (!byCategory.has(key)) byCategory.set(key, []);
        byCategory.get(key)!.push(f);
      }

      const categoryLabels: Record<string, string> = {
        security: '安全性',
        exception_handling: '异常处理',
        logic: '逻辑正确性',
        performance: '性能',
        compatibility: '兼容性',
        naming: '命名规范',
        architecture: '架构',
        other: '其他',
      };

      for (const [category, catFindings] of byCategory) {
        const content = buildCategoryContent(
          category, catFindings, review_summary, categoryLabels,
        );
        const title = `[Code Review·${categoryLabels[category] ?? category}] ${catFindings.length} 个问题`;

        const scope = mapCategoryToScope(category);
        const source: MemorySource = 'code_review';
        const effectiveVisibility = clampVisibilityByRole(
          resolveVisibility(category, visibility),
          ctx.userRole,
        ) as VisibilityLevel;

        const embedding = await ctx.embedding.embedPassage(`${title} ${content}`);
        const dup = await ctx.storage.checkDuplicate(embedding, ctx.config.deduplicationThreshold);
        if (dup) continue;

        const resolvedProjectId = effectiveVisibility === 'global' ? '_global_'
          : (effectiveVisibility === 'product_line' && product_line) ? product_line
          : fallbackProjectId;
        const resolvedTeamId = effectiveVisibility === 'personal' ? null : (ctx.teamId ?? null);

        const allTags = [
          ...(tags ?? []),
          'code-review',
          `cr-category:${category}`,
          `date:${new Date().toISOString().split('T')[0]}`,
        ];
        if (product_line) allTags.push(`pl:${product_line}`);

        const entry = await ctx.storage.store({
          projectId: resolvedProjectId,
          branchId,
          title,
          content,
          scope,
          source,
          tags: allTags,
          embedding,
          metadata: {
            reviewDate: new Date().toISOString(),
            findingCount: catFindings.length,
            category,
            filesReviewed: files_reviewed,
          },
          isArchived: false,
          archivedReason: null,
          createdBy: ctx.userId,
          expiresAt: null,
          orgId: ctx.orgId || null,
          teamId: resolvedTeamId,
          visibility: effectiveVisibility,
        });
        storedIds.push(entry.id);

        try {
          const bridgedId = await tryBridgeToRule({
            memoryId: entry.id,
            title,
            content,
            scope,
            projectId: resolvedProjectId,
            embedding,
            createdBy: ctx.userId,
          });
          if (bridgedId) {
            bridgedRuleIds.push(bridgedId);
          }
        } catch (err) {
          logger.warn({ err, memoryId: entry.id }, 'Code Review 规则桥接失败（不影响存储结果）');
        }
      }

      logger.info({
        storedCount: storedIds.length,
        totalFindings: findings.length,
        importantFindings: importantFindings.length,
        project: fallbackProjectId,
      }, 'Code Review 结果已存储');

      // C: 自动对比规则库 —— 将 finding 描述嵌入后与已有 active 规则做向量匹配 + 记录 violated 事件
      const matchedRules = await matchAndRecordViolations(ctx, importantFindings);

      const bridgeNote = bridgedRuleIds.length > 0
        ? ` 其中 ${bridgedRuleIds.length} 条已自动创建规范候选（可通过 vote_rule 投票激活）。`
        : '';

      const result: Record<string, unknown> = {
        success: true,
        stored: storedIds.length,
        ids: storedIds,
        totalFindings: findings.length,
        storedFindings: importantFindings.length,
        bridgedRuleIds: bridgedRuleIds.length > 0 ? bridgedRuleIds : undefined,
        message: `已存储 ${storedIds.length} 条 Code Review 记忆（${importantFindings.length} 个 P0/P1 问题）。${bridgeNote}`,
      };

      if (matchedRules.length > 0) {
        result.matchedRules = matchedRules;
        result.matchedRulesNote = `${matchedRules.length} 个问题匹配到已有规则，建议确认这些规则是否已在团队中充分执行。`;
      }

      if (!ctx.rulesLoadedAt) {
        result.warning = '⚠️ 本会话尚未调用 get_system_rules 加载编码规范。Code Review 可能遗漏已有规则覆盖的问题。建议先执行: get_system_rules({ rule_types: ["coding", "business"] })';
        logger.warn('store_code_review 触发但本会话未加载系统规则');
      }

      return text(JSON.stringify(result));
    },
  );
}

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

function buildCategoryContent(
  category: string,
  findings: Array<z.infer<typeof FindingSchema>>,
  reviewSummary: string,
  labels: Record<string, string>,
): string {
  const parts: string[] = [
    `审查背景: ${reviewSummary}`,
    `问题分类: ${labels[category] ?? category}`,
    `问题数量: ${findings.length}`,
    '',
  ];

  for (const f of findings) {
    parts.push(`[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''}`);
    parts.push(`  问题: ${f.description}`);
    if (f.suggestion) parts.push(`  建议: ${f.suggestion}`);
    if (f.fixed) parts.push(`  状态: 已修复`);
    parts.push('');
  }

  return parts.join('\n');
}

function mapCategoryToScope(category: string): MemoryScope {
  const mapping: Record<string, MemoryScope> = {
    security: 'coding_standard',
    exception_handling: 'coding_standard',
    logic: 'bug_pattern',
    performance: 'performance_insight',
    compatibility: 'coding_standard',
    naming: 'convention',
    architecture: 'architecture',
    other: 'lesson_learned',
  };
  return mapping[category] ?? ('lesson_learned' as MemoryScope);
}

type VisibilityLevel = 'personal' | 'team' | 'product_line' | 'global';

function resolveVisibility(category: string, userChoice: string): VisibilityLevel {
  if (category === 'security') return 'global';
  if (category === 'performance' && userChoice !== 'personal') return 'product_line';
  const mapped = userChoice === 'project' ? 'personal' : userChoice;
  if (['personal', 'team', 'product_line', 'global'].includes(mapped)) {
    return mapped as VisibilityLevel;
  }
  return 'personal';
}

