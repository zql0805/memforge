// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, buildProjectCascade, RuleSeverity } from '@memforgeai/shared';
import type { RuleViolation } from '@memforgeai/shared';
import { cosineSimilarity } from '../storage/postgres.js';
import type { RulesToolContext } from './types.js';

const logger = getLogger('tool:enforce');

const SEVERITY_ORDER: Record<string, number> = { critical: 0, error: 1, warning: 2, info: 3 };

export function registerEnforceRules(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'enforce_rules',
    '对代码片段执行已激活的编码规则检查。返回违规项、严重级别和修复建议。',
    {
      code: z.string().describe('要检查的代码片段'),
      language: z.string().describe('代码语言: php/java/go/python 等'),
      file_path: z.string().optional().describe('文件路径（用于上下文）'),
      severity_threshold: RuleSeverity.optional().describe('最低检查级别: critical/error/warning/info（默认 warning）'),
      product_line: z.string().optional().describe('产品线标识，用于级联获取产品线级规则'),
    },
    async (params) => {
      try {
        const projectIds = buildProjectCascade(
          ctx.gitContext?.projectName ?? 'default',
          params.product_line,
        );
        const threshold = params.severity_threshold ?? 'warning';
        const thresholdLevel = SEVERITY_ORDER[threshold] ?? 1;

        const activeRules = (await ctx.storage.getActiveRules(projectIds, params.language))
          .filter(r => (SEVERITY_ORDER[r.severity] ?? 2) <= thresholdLevel);

        if (activeRules.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                violations: [],
                rulesChecked: 0,
                message: '没有匹配的活跃规则。',
              }),
            }],
          };
        }

        const codeEmbedding = await ctx.embedding.embedPassage(params.code);
        const violations: RuleViolation[] = [];

        const relevantRules = activeRules.filter((rule) => {
          if (!rule.embedding) return false;
          return cosineSimilarity(codeEmbedding, rule.embedding) >= ctx.config.enforceRelevanceThreshold;
        });

        const exampleTexts: string[] = [];
        for (const rule of relevantRules) {
          if (rule.exampleBad) {
            exampleTexts.push(rule.exampleBad);
          }
          if (rule.exampleGood) {
            exampleTexts.push(rule.exampleGood);
          }
        }

        const exampleEmbeddings = exampleTexts.length > 0
          ? await ctx.embedding.embedPassageBatch(exampleTexts)
          : [];
        const embeddingByText = new Map<string, number[]>();
        for (let i = 0; i < exampleTexts.length; i++) {
          embeddingByText.set(exampleTexts[i], exampleEmbeddings[i]);
        }

        for (const rule of relevantRules) {
          const relevance = cosineSimilarity(codeEmbedding, rule.embedding!);
          let violationScore = 0;

          if (rule.exampleBad) {
            const badEmbedding = embeddingByText.get(rule.exampleBad)!;
            const simBad = cosineSimilarity(codeEmbedding, badEmbedding);

            if (rule.exampleGood) {
              const goodEmbedding = embeddingByText.get(rule.exampleGood)!;
              const simGood = cosineSimilarity(codeEmbedding, goodEmbedding);
              violationScore = simBad - simGood;
            } else {
              violationScore = simBad - 0.5;
            }
          } else {
            violationScore = relevance - 0.7;
          }

          if (violationScore > ctx.config.enforceViolationThreshold) {
            violations.push({
              ruleId: rule.id,
              ruleTitle: rule.title,
              severity: rule.severity as RuleSeverity,
              category: rule.category,
              description: rule.description,
              violationScore: Math.round(violationScore * 1000) / 1000,
              autoFix: rule.autoFix,
            });
          }
        }

        // 按严重级别排序
        violations.sort((a, b) =>
          (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2),
        );

        logger.info({
          language: params.language,
          rulesChecked: activeRules.length,
          violationsFound: violations.length,
        }, 'enforce_rules 检查完成');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              violations,
              rulesChecked: activeRules.length,
              filePath: params.file_path,
              language: params.language,
              message: violations.length > 0
                ? `发现 ${violations.length} 个违规项。`
                : '代码检查通过，未发现违规。',
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'enforce_rules 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
