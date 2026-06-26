// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: assess_skill — AI 辅助技能评估

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';
import { resolveSkillUserId } from './rule-auth.js';

const logger = getLogger('tool:assess-skill');

const LEVEL_LABELS = ['', '新手 (Novice)', '进阶 (Advanced Beginner)', '胜任 (Competent)', '精通 (Proficient)', '专家 (Expert)'];

export function registerAssessSkill(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'assess_skill',
    '基于开发者的代码记忆和工作记录，AI 辅助评估其在特定技能上的当前水平',
    {
      skill_name: z.string().describe('技能名称'),
      user_id: z.string().optional().describe('被评估者 ID（省略则使用默认用户）'),
    },
    async ({ skill_name, user_id }) => {
      const orgId = ctx.orgId ?? '00000000-0000-0000-0000-000000000001';
      const effectiveUserId = resolveSkillUserId(ctx, user_id);

      const skillDef = await ctx.skillStore.findSkillByName(orgId, skill_name);
      if (!skillDef) {
        const allSkills = await ctx.skillStore.listSkillDefinitions(orgId);
        const skillNames = allSkills.map((s) => s.name).join(', ');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `未找到技能「${skill_name}」。可用技能: ${skillNames}`,
            }, null, 2),
          }],
        };
      }

      const userSkill = await ctx.skillStore.getUserSkill(effectiveUserId, skillDef.id);
      const currentLevel = userSkill?.currentLevel ?? 1;
      const confidence = userSkill?.confidence ?? 0.3;
      const evidence = userSkill?.evidence ?? [];

      const criteria = skillDef.levelCriteria;
      const currentCriteria = criteria.find((c) => c.level === currentLevel);
      const nextCriteria = criteria.find((c) => c.level === currentLevel + 1);

      const result = {
        success: true as const,
        skill: skillDef.name,
        category: skillDef.category,
        currentLevel,
        levelLabel: LEVEL_LABELS[currentLevel] ?? `Level ${currentLevel}`,
        confidence: Math.round(confidence * 100) + '%',
        currentCriteria: currentCriteria?.criteria ?? '（暂无定义）',
        nextLevelCriteria: nextCriteria?.criteria ?? '已达最高级别',
        evidenceCount: evidence.length,
        recentEvidence: evidence.slice(-3).map((e) => ({
          description: e.description,
          type: e.evidenceType,
          date: e.observedAt,
        })),
        suggestions: generateSuggestions(skillDef.name, currentLevel, skillDef.maxLevel),
      };

      logger.info({ skill: skill_name, level: currentLevel }, '技能评估完成');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );
}

function generateSuggestions(skillName: string, current: number, max: number): string[] {
  if (current >= max) {
    return ['已达最高级别，建议指导团队成员提升该技能', '尝试在该领域进行创新实践并记录'];
  }

  const suggestions: string[] = [];
  if (current <= 2) {
    suggestions.push(`多练习「${skillName}」的基础操作，从简单任务开始`);
    suggestions.push('遇到问题时记录解决过程，使用 store_memory 存储经验');
  } else if (current === 3) {
    suggestions.push(`尝试独立处理更复杂的「${skillName}」相关问题`);
    suggestions.push('在 Code Review 中关注他人的解决方案，总结最佳实践');
  } else {
    suggestions.push('主动参与架构设计和技术决策');
    suggestions.push('指导初级开发者，将经验转化为编码规范 (propose_rule)');
  }
  suggestions.push('使用 record_milestone 记录关键技能成长事件');
  return suggestions;
}
