// Created by dev on 2026/04/08
// Copyright © 2026
// MCP 工具: store_structured_memory — 4 个结构化存储工具的统一入口
// 通过 type 字段路由到对应的内部逻辑，降低 AI 误用率

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, buildProjectCascade } from '@memforgeai/shared';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { tryBridgeP0Finding } from '../services/rule-bridge.js';
import { matchAndRecordViolations } from '../services/rule-matcher.js';
import { routeByScope, writeToKnowledge } from '../storage/storage-router.js';
import { clampVisibilityByRole } from '../services/visibility-guard.js';

const logger = getLogger('tool:store-structured-memory');

export function registerStoreStructuredMemory(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'store_structured_memory',
    [
      '结构化存储的统一入口。通过 type 字段路由到对应的专用存储逻辑：',
      '• session_summary — 对话结束时总结决策和经验',
      '• log_insight    — 通过 ES 日志定位问题后记录根因',
      '• troubleshoot   — 多步骤排查流程记录',
      '• incident       — 线上故障/事故复盘',
      '• code_review    — Code Review 发现（P0/P1 问题）',
    ].join('\n'),
    {
      type: z.enum(['session_summary', 'log_insight', 'troubleshoot', 'incident', 'code_review']).describe(
        '存储类型：session_summary/log_insight/troubleshoot/incident/code_review',
      ),
      title: z.string().describe('标题（简洁，<50字）'),
      content: z.string().describe('主体内容（根因、摘要、日志摘录等）'),
      tags: z.array(z.string()).optional().describe('标签'),
      product_line: z.string().optional().describe('产品线标识（用于跨项目共享）'),
      visibility: z.enum(['personal', 'team', 'product_line', 'global']).optional().describe(
        '可见性级别：personal（仅创建者，默认）、team（同团队可见）、product_line（产品线可见）、global（全局可见）',
      ),

      // session_summary 字段
      decisions: z.array(z.object({
        title: z.string(),
        rationale: z.string(),
        alternatives: z.array(z.string()).optional(),
      })).optional().describe('[session_summary] 关键决策列表'),
      lessons: z.array(z.string()).optional().describe('[session_summary] 经验教训列表'),

      // troubleshoot 字段
      steps: z.array(z.string()).optional().describe('[troubleshoot] 排查步骤列表'),
      root_cause: z.string().optional().describe('[troubleshoot/incident] 根本原因'),
      solution: z.string().optional().describe('[troubleshoot] 解决方案'),

      // incident 字段
      timeline: z.array(z.string()).optional().describe('[incident] 故障时间线'),
      impact: z.string().optional().describe('[incident] 影响范围'),

      // log_insight 字段
      log_source: z.string().optional().describe('[log_insight] 日志来源（ES 索引、服务名）'),

      // code_review 字段
      review_summary: z.string().optional().describe('[code_review] 审查变更简述'),
      findings: z.array(z.object({
        severity: z.enum(['P0', 'P1', 'P2']),
        category: z.string(),
        file: z.string(),
        line: z.number().optional(),
        description: z.string(),
        suggestion: z.string().optional(),
        fixed: z.boolean().optional(),
      })).optional().describe('[code_review] 审查发现列表（仅 P0/P1 入库）'),
      files_reviewed: z.array(z.string()).optional().describe('[code_review] 审查的文件列表'),
    },
    async (params) => {
      try {
        const fallbackProjectId = params.product_line ?? ctx.gitContext?.projectName ?? 'default';
        const branchId = null;
        const { resolvedVisibility, resolvedProjectId, resolvedTeamId } = resolveVisibilityAndProject(
          params.visibility, params.product_line, fallbackProjectId, ctx,
        );

        switch (params.type) {
          case 'session_summary':
            return await storeSessionSummary(ctx, params, resolvedProjectId, branchId, resolvedVisibility, resolvedTeamId);
          case 'log_insight':
            return await storeLogInsight(ctx, params, resolvedProjectId, branchId, resolvedVisibility, resolvedTeamId);
          case 'troubleshoot':
            return await storeTroubleshoot(ctx, params, resolvedProjectId, branchId, resolvedVisibility, resolvedTeamId);
          case 'incident':
            return await storeIncident(ctx, params, resolvedProjectId, branchId, resolvedVisibility, resolvedTeamId);
          case 'code_review':
            return await storeCodeReview(ctx, params, resolvedProjectId, branchId, resolvedVisibility, resolvedTeamId);
          default:
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: `未知类型: ${String(params.type)}` }),
              }],
              isError: true,
            };
        }
      } catch (error) {
        logger.error({ error, type: params.type }, 'store_structured_memory 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}

// ─── 内部路由实现 ─────────────────────────────────────────────────────────────

type Params = {
  type: string;
  title: string;
  content: string;
  tags?: string[];
  product_line?: string;
  visibility?: 'personal' | 'team' | 'product_line' | 'global';
  decisions?: Array<{ title: string; rationale: string; alternatives?: string[] }>;
  lessons?: string[];
  steps?: string[];
  root_cause?: string;
  solution?: string;
  timeline?: string[];
  impact?: string;
  log_source?: string;
  review_summary?: string;
  findings?: Array<{
    severity: 'P0' | 'P1' | 'P2';
    category: string;
    file: string;
    line?: number;
    description: string;
    suggestion?: string;
    fixed?: boolean;
  }>;
  files_reviewed?: string[];
};

type McpResult = { content: Array<{ type: 'text'; text: string }> };

type VisibilityLevel = 'personal' | 'team' | 'product_line' | 'global';

function resolveVisibilityAndProject(
  visibility: VisibilityLevel | undefined,
  productLine: string | undefined,
  fallbackProjectId: string,
  ctx: ToolContext,
): { resolvedVisibility: VisibilityLevel; resolvedProjectId: string; resolvedTeamId: string | null } {
  const resolvedVisibility = clampVisibilityByRole(visibility, ctx.userRole) as VisibilityLevel;
  let resolvedProjectId: string;
  if (resolvedVisibility === 'global') {
    resolvedProjectId = '_global_';
  } else if (resolvedVisibility === 'product_line' && productLine) {
    resolvedProjectId = productLine;
  } else {
    resolvedProjectId = fallbackProjectId;
  }
  const resolvedTeamId = resolvedVisibility === 'personal' ? null : (ctx.teamId ?? null);
  return { resolvedVisibility, resolvedProjectId, resolvedTeamId };
}

async function storeEntry(
  ctx: ToolContext,
  content: string,
  title: string,
  scope: MemoryScope,
  source: MemorySource,
  tags: string[],
  projectId: string,
  branchId: string | null,
  visibility: VisibilityLevel = 'personal',
  teamId: string | null = null,
): Promise<{ id: string; embedding: number[] } | null> {
  const embedding = await ctx.embedding.embedPassage(content);
  const dup = await ctx.storage.checkDuplicate(embedding, ctx.config.deduplicationThreshold);
  if (dup) return null;
  const entry = await ctx.storage.store({
    projectId, branchId,
    title,
    content,
    scope,
    source,
    tags,
    embedding,
    metadata: { storedAt: new Date().toISOString() },
    isArchived: false,
    archivedReason: null,
    createdBy: ctx.userId,
    expiresAt: null,
    orgId: ctx.orgId || null,
    teamId,
    visibility,
  });

  const route = routeByScope(scope);
  if (route.type === 'dual' || route.type === 'knowledge') {
    const knowledgeType = 'knowledgeType' in route ? route.knowledgeType : 'technical';
    writeToKnowledge({
      projectId,
      title,
      content,
      knowledgeType,
      sourceType: source,
      sourceRef: `memory:${entry.id}`,
      tags,
      visibility,
    }).catch(err => {
      logger.debug({ err, entryId: entry.id }, 'structured_memory dual-write 到知识库失败（降级）');
    });
  }

  return { id: entry.id, embedding };
}

async function storeSessionSummary(ctx: ToolContext, p: Params, projectId: string, branchId: string | null, visibility: VisibilityLevel, teamId: string | null): Promise<McpResult> {
  const ids: string[] = [];
  const tags = [...(p.tags ?? []), 'session-summary', `date:${new Date().toISOString().split('T')[0]}`];

  const summaryContent = [
    p.content,
    ...(p.decisions?.length ? ['\n--- 关键决策 ---', ...p.decisions.map(d => `• ${d.title}: ${d.rationale}`)] : []),
    ...(p.lessons?.length ? ['\n--- 经验教训 ---', ...p.lessons.map(l => `• ${l}`)] : []),
  ].join('\n');

  const result = await storeEntry(ctx, summaryContent, `[会话摘要] ${p.title}`, 'lesson_learned', 'ai_suggestion', tags, projectId, branchId, visibility, teamId);
  if (result) ids.push(result.id);

  if (p.decisions) {
    for (const d of p.decisions) {
      const decContent = [`决策: ${d.title}`, `理由: ${d.rationale}`, ...(d.alternatives?.length ? [`否决方案: ${d.alternatives.join('; ')}`] : [])].join('\n');
      const decResult = await storeEntry(ctx, decContent, `[决策] ${d.title}`, 'architecture', 'architecture_decision', [...(p.tags ?? []), 'decision'], projectId, branchId, visibility, teamId);
      if (decResult) ids.push(decResult.id);
    }
  }

  logger.info({ stored: ids.length, projectId, visibility }, 'store_structured_memory: session_summary 已存储');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, type: 'session_summary', stored: ids.length, ids, visibility }) }] };
}

async function storeLogInsight(ctx: ToolContext, p: Params, projectId: string, branchId: string | null, visibility: VisibilityLevel, teamId: string | null): Promise<McpResult> {
  const tags = [...(p.tags ?? []), 'log-insight', 'es-search'];
  const content = [p.content, p.log_source ? `\n日志来源: ${p.log_source}` : ''].join('');
  const result = await storeEntry(ctx, content, `[日志洞察] ${p.title}`, 'bug_pattern', 'bug_fix', tags, projectId, branchId, visibility, teamId);
  logger.info({ stored: result ? 1 : 0, projectId, visibility }, 'store_structured_memory: log_insight 已存储');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, type: 'log_insight', stored: result ? 1 : 0, ids: result ? [result.id] : [], visibility }) }] };
}

async function storeTroubleshoot(ctx: ToolContext, p: Params, projectId: string, branchId: string | null, visibility: VisibilityLevel, teamId: string | null): Promise<McpResult> {
  const tags = [...(p.tags ?? []), 'troubleshoot'];
  const content = [
    p.content,
    ...(p.steps?.length ? ['\n--- 排查步骤 ---', ...p.steps.map((s, i) => `${i + 1}. ${s}`)] : []),
    p.root_cause ? `\n根本原因: ${p.root_cause}` : '',
    p.solution ? `\n解决方案: ${p.solution}` : '',
  ].join('\n');
  const result = await storeEntry(ctx, content, `[排查] ${p.title}`, 'lesson_learned', 'bug_fix', tags, projectId, branchId, visibility, teamId);
  logger.info({ stored: result ? 1 : 0, projectId, visibility }, 'store_structured_memory: troubleshoot 已存储');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, type: 'troubleshoot', stored: result ? 1 : 0, ids: result ? [result.id] : [], visibility }) }] };
}

async function storeIncident(ctx: ToolContext, p: Params, projectId: string, branchId: string | null, visibility: VisibilityLevel, teamId: string | null): Promise<McpResult> {
  const tags = [...(p.tags ?? []), 'incident', 'postmortem'];
  const content = [
    p.content,
    ...(p.timeline?.length ? ['\n--- 时间线 ---', ...p.timeline] : []),
    p.root_cause ? `\n根本原因: ${p.root_cause}` : '',
    p.impact ? `\n影响范围: ${p.impact}` : '',
  ].join('\n');
  const result = await storeEntry(ctx, content, `[故障] ${p.title}`, 'bug_pattern', 'bug_fix', tags, projectId, branchId, visibility, teamId);
  logger.info({ stored: result ? 1 : 0, projectId, visibility }, 'store_structured_memory: incident 已存储');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, type: 'incident', stored: result ? 1 : 0, ids: result ? [result.id] : [], visibility }) }] };
}

async function storeCodeReview(ctx: ToolContext, p: Params, projectId: string, branchId: string | null, visibility: VisibilityLevel, teamId: string | null): Promise<McpResult> {
  const ids: string[] = [];
  const criticalFindings = (p.findings ?? []).filter(f => f.severity === 'P0' || f.severity === 'P1');
  let p0BridgedCount = 0;

  const summaryContent = [
    p.review_summary ?? p.content,
    `\n审查文件: ${(p.files_reviewed ?? []).join(', ')}`,
    `\n发现问题: ${p.findings?.length ?? 0} 个（P0: ${p.findings?.filter(f => f.severity === 'P0').length ?? 0}, P1: ${p.findings?.filter(f => f.severity === 'P1').length ?? 0}）`,
  ].join('\n');

  const summaryResult = await storeEntry(ctx, summaryContent, `[Code Review] ${p.title}`, 'lesson_learned', 'code_review', [...(p.tags ?? []), 'code-review'], projectId, branchId, visibility, teamId);
  if (summaryResult) ids.push(summaryResult.id);

  for (const finding of criticalFindings) {
    const content = [`${finding.severity} ${finding.category}: ${finding.description}`, `文件: ${finding.file}${finding.line ? `:${finding.line}` : ''}`, finding.suggestion ? `修复建议: ${finding.suggestion}` : '', finding.fixed ? '状态: 已修复' : '状态: 未修复'].filter(Boolean).join('\n');
    const findingTitle = `[${finding.severity}] ${finding.description.slice(0, 50)}`;
    const findingResult = await storeEntry(ctx, content, findingTitle, 'bug_pattern', 'code_review', [...(p.tags ?? []), 'code-review', finding.category], projectId, branchId, visibility, teamId);
    if (findingResult) {
      ids.push(findingResult.id);

      if (finding.severity === 'P0') {
        tryBridgeP0Finding({
          memoryId: findingResult.id,
          title: findingTitle,
          content,
          scope: 'bug_pattern',
          projectId,
          embedding: findingResult.embedding,
          createdBy: ctx.userId,
        }).then(ruleId => {
          if (ruleId) {
            p0BridgedCount++;
            logger.info({ ruleId, findingTitle }, 'P0 发现已通过快速通道直接激活规则');
          }
        }).catch(err => logger.warn({ err }, 'P0 快速通道桥接失败'));
      }
    }
  }

  let matchedCount = 0;
  if (criticalFindings.length > 0) {
    const matched = await matchAndRecordViolations(ctx, criticalFindings);
    matchedCount = matched.length;
  }

  logger.info({ stored: ids.length, findings: criticalFindings.length, p0BridgedCount, matchedCount, projectId, visibility }, 'store_structured_memory: code_review 已存储');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, type: 'code_review', stored: ids.length, ids, findingsStored: criticalFindings.length, matchedRules: matchedCount, visibility }) }] };
}
