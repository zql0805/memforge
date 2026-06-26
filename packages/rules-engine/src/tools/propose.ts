// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, RuleProposeSource, RuleSeverity, type MemorySource, type RuleType, type Rule } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';

const logger = getLogger('tool:propose');

export function registerProposeRule(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'propose_rule',
    '提议一条新的编码规则。自动执行冲突检测（语义重复、逻辑矛盾、范围冲突），通过后进入 candidate 状态。',
    {
      title: z.string().describe('规则标题（简洁明了）'),
      description: z.string().describe('规则详细描述'),
      rationale: z.string().optional().describe('为什么需要这条规则'),
      example_good: z.string().optional().describe('正确代码示例'),
      example_bad: z.string().optional().describe('错误代码示例'),
      auto_fix: z.string().optional().describe('自动修复建议代码'),
      category: z.enum(['security', 'performance', 'style', 'logic', 'convention', 'architecture'])
        .describe('分类: security/performance/style/logic/convention/architecture'),
      language: z.string().optional().describe('编程语言: php/java/go/python 等，留空表示语言无关'),
      severity: RuleSeverity.describe('严重级别: critical/error/warning/info'),
      source: RuleProposeSource.optional().describe('来源: manual/code_review/bug_fix/ai_suggestion/codebase_scan'),
      source_ref: z.record(z.unknown()).optional().describe('来源引用（如 review_url、bug_id）'),
      created_by: z.string().optional().describe('（已忽略，提议人由 Gateway 身份决定）'),
      team_id: z.string().optional().describe('指定规则所属团队 ID（team 级隔离时使用）'),
      auto_activate: z.boolean().optional().describe('是否跳过投票直接激活（仅限 admin 使用）'),
      product_line: z.string().optional().describe('产品线标识，不传则使用当前项目名'),
      visibility: z.enum(['personal', 'team', 'product_line', 'global']).optional().describe(
        '可见性级别：personal（仅创建者，默认）、team（同团队可见）、product_line（产品线可见）、global（全局可见）。' +
        '新建规则默认 personal，需通过 WebUI 编辑升级可见范围',
      ),
      rule_type: z.enum(['coding', 'ai_agent', 'workflow', 'business', 'infra']).optional().describe(
        '规则一级类型，默认 coding',
      ),
    },
    async (params) => {
      try {
        const ruleEmbedding = await ctx.embedding.embedPassage(`${params.title} ${params.description}`);

        const gitProjectName = ctx.gitContext?.projectName ?? 'default';
        let projectId: string;
        if (params.visibility === 'global') {
          projectId = '_global_';
        } else if (params.visibility === 'product_line' && params.product_line) {
          projectId = params.product_line;
        } else {
          projectId = params.product_line ?? gitProjectName;
        }

        const conflict = await ctx.conflictDetector.check(ruleEmbedding, {
          title: params.title,
          description: params.description,
          category: params.category,
          severity: params.severity,
          exampleGood: params.example_good,
          exampleBad: params.example_bad,
          projectId,
        });

        if (conflict.hasDuplicate) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: '检测到高度相似的已有规则，请确认是否需要更新而非新建。',
                duplicateRule: conflict.duplicateRule,
                relatedRules: conflict.relatedRules,
              }),
            }],
          };
        }

        if (params.auto_activate && ctx.userRole !== 'admin' && ctx.userRole !== 'lead') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'auto_activate 仅限 admin/lead 角色使用，当前角色无权跳过投票流程。',
              }),
            }],
          };
        }

        const status = params.auto_activate ? 'active' : 'candidate';

        const rule = await ctx.storage.storeRule({
          projectId,
          ruleType: (params.rule_type ?? 'coding') as RuleType,
          title: params.title,
          description: params.description,
          rationale: params.rationale ?? null,
          exampleGood: params.example_good ?? null,
          exampleBad: params.example_bad ?? null,
          autoFix: params.auto_fix ?? null,
          category: params.category,
          language: params.language ?? null,
          severity: params.severity,
          status,
          source: (params.source ?? 'manual') as MemorySource,
          sourceRef: {
            ...params.source_ref,
            source_project: gitProjectName,
            source_product_line: params.product_line ?? null,
            visibility: params.visibility ?? 'personal',
          },
          embedding: ruleEmbedding,
          createdBy: ctx.userId ?? null,
          teamId: params.team_id ?? ctx.teamId ?? null,
          visibility: (params.visibility as Rule['visibility']) ?? 'personal',
        });

        logger.info({ id: rule.id, title: rule.title, status }, '规则提议成功');

        const warnings: string[] = [];
        if (conflict.hasContradiction) {
          warnings.push(`逻辑矛盾警告: ${conflict.contradictionRule?.detail}`);
        }
        if (conflict.hasScopeConflict) {
          warnings.push(`范围冲突警告: ${conflict.scopeConflictDetail}`);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              id: rule.id,
              title: rule.title,
              status: rule.status,
              category: rule.category,
              severity: rule.severity,
              project: projectId,
              warnings: warnings.length > 0 ? warnings : undefined,
              relatedRules: conflict.relatedRules.length > 0 ? conflict.relatedRules : undefined,
              message: status === 'active'
                ? '规则已直接激活。'
                : '规则已创建为候选状态。可使用 vote_rule 发起投票流程。',
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'propose_rule 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
