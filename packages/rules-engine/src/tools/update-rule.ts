// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, RuleCategory, RuleSeverity } from '@memforgeai/shared';
import type { RuleCategory as RuleCategoryValue, RuleSeverity as RuleSeverityValue, RuleType } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';
import { canModifyRule } from './rule-auth.js';

const logger = getLogger('tool:update-rule');

export function registerUpdateRule(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'update_rule',
    '更新编码规则内容（candidate/voting 可修改；active 状态仅 admin 可修改）',
    {
      rule_id: z.string().describe('规则 ID'),
      title: z.string().optional().describe('新标题'),
      description: z.string().optional().describe('新描述'),
      rationale: z.string().optional().describe('新理由'),
      example_good: z.string().optional().describe('新的正确示例'),
      example_bad: z.string().optional().describe('新的错误示例'),
      auto_fix: z.string().optional().describe('新的自动修复建议'),
      category: RuleCategory.optional().describe('新分类'),
      language: z.string().optional().describe('新语言'),
      severity: RuleSeverity.optional().describe('新严重级别: critical/error/warning/info'),
      rule_type: z.enum(['coding', 'ai_agent', 'workflow', 'business', 'infra']).optional().describe('新规则一级类型'),
    },
    async (params) => {
      try {
        const rule = await ctx.storage.getRuleById(params.rule_id);
        if (!rule) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: '规则不存在' }) }],
          };
        }

        if (!['candidate', 'voting', 'active'].includes(rule.status)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `仅 candidate/voting/active 状态的规则可修改，当前状态: ${rule.status}`,
              }),
            }],
          };
        }

        if (rule.status === 'active' && ctx.userRole !== 'admin') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: '活跃规则不可直接修改，请提议新规则',
              }),
            }],
          };
        }

        if (!canModifyRule(ctx, rule.createdBy)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: '无权修改此规则，仅 admin/lead 或规则创建者可操作。',
              }),
            }],
          };
        }

        const fields: Record<string, unknown> = {};
        if (params.title !== undefined) fields.title = params.title;
        if (params.description !== undefined) fields.description = params.description;
        if (params.rationale !== undefined) fields.rationale = params.rationale;
        if (params.example_good !== undefined) fields.exampleGood = params.example_good;
        if (params.example_bad !== undefined) fields.exampleBad = params.example_bad;
        if (params.auto_fix !== undefined) fields.autoFix = params.auto_fix;
        if (params.category !== undefined) fields.category = params.category as RuleCategoryValue;
        if (params.language !== undefined) fields.language = params.language;
        if (params.severity !== undefined) fields.severity = params.severity as RuleSeverityValue;
        if (params.rule_type !== undefined) fields.ruleType = params.rule_type as RuleType;

        // 内容变更时重新生成 embedding
        if (params.title !== undefined || params.description !== undefined) {
          const newTitle = params.title ?? rule.title;
          const newDesc = params.description ?? rule.description;
          fields.embedding = await ctx.embedding.embedPassage(`${newTitle} ${newDesc}`);
        }

        const updated = await ctx.storage.updateRule(params.rule_id, fields as Parameters<typeof ctx.storage.updateRule>[1]);

        logger.info({ ruleId: params.rule_id }, '规则更新完成');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              rule: updated ? {
                id: updated.id,
                title: updated.title,
                status: updated.status,
                updatedAt: updated.updatedAt,
              } : null,
              message: '规则已更新。',
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'update_rule 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
