// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: get_growth_path — 个性化成长路径推荐

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { GrowthPathResult, SkillRadarPoint } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';
import { resolveSkillUserId } from './rule-auth.js';

const logger = getLogger('tool:growth-path');

const LEVEL_LABELS = ['', '新手', '进阶', '胜任', '精通', '专家'];

const ROLE_REQUIREMENTS: Record<string, Record<string, number>> = {
  senior_developer: {
    '编程语言': 4, '数据库': 4, '缓存': 3, '系统架构': 3,
    '安全': 3, 'Code Review': 4, '测试策略': 3,
  },
  tech_lead: {
    '编程语言': 4, '数据库': 4, '缓存': 4, '系统架构': 4,
    '分布式系统': 3, '安全': 3, 'Code Review': 5, '测试策略': 4,
    'CI/CD': 3, '监控告警': 3,
  },
  architect: {
    '系统架构': 5, '分布式系统': 4, '数据库': 4, '缓存': 4,
    '安全': 4, 'Code Review': 4, '监控告警': 4,
  },
  engineering_manager: {
    '系统架构': 3, 'Code Review': 4, '测试策略': 3,
    'CI/CD': 3, '监控告警': 3,
  },
};

export function registerGetGrowthPath(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'get_growth_path',
    '根据当前技能状态和目标角色，推荐个性化的技能成长路径',
    {
      target_role: z.enum(['senior_developer', 'tech_lead', 'architect', 'engineering_manager']).optional()
        .describe('目标角色'),
      focus_area: z.string().optional().describe('关注领域'),
      user_id: z.string().optional().describe('用户 ID'),
    },
    async ({ target_role, focus_area, user_id }) => {
      const effectiveUserId = resolveSkillUserId(ctx, user_id);
      const targetRole = target_role ?? 'tech_lead';

      const radar = await ctx.skillStore.getSkillRadar(effectiveUserId);

      const strengths = radar
        .filter((p) => p.level >= 3)
        .sort((a, b) => b.level - a.level)
        .slice(0, 3)
        .map((p) => p.skill);

      const gaps = radar
        .filter((p) => p.level < 2)
        .map((p) => p.skill);

      const avgLevel = radar.length > 0
        ? radar.reduce((s, p) => s + p.level, 0) / radar.length
        : 1;
      const overallIdx = Math.min(Math.max(Math.round(avgLevel), 1), 5);

      const requirements = ROLE_REQUIREMENTS[targetRole] ?? {};
      const milestones = buildMilestones(radar, requirements, focus_area);

      const estimatedMonths = milestones.reduce((sum, m) => {
        const gap = m.target - m.current;
        return sum + gap * 2;
      }, 0);

      const result: GrowthPathResult = {
        currentProfile: {
          overallLevel: `${LEVEL_LABELS[overallIdx]} (Level ${overallIdx})`,
          strengths: strengths.length > 0 ? strengths : ['（暂无突出技能，建议先专注一个方向）'],
          gaps: gaps.length > 0 ? gaps : ['（暂无明显短板）'],
        },
        pathToTarget: {
          target: formatRoleName(targetRole),
          estimatedMonths: Math.max(estimatedMonths, 1),
          milestones,
        },
      };

      logger.info({ targetRole, milestoneCount: milestones.length }, '成长路径生成');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, ...result }, null, 2),
        }],
      };
    },
  );
}

function buildMilestones(
  radar: SkillRadarPoint[],
  requirements: Record<string, number>,
  focusArea?: string,
): GrowthPathResult['pathToTarget']['milestones'] {
  const milestones: GrowthPathResult['pathToTarget']['milestones'] = [];

  for (const [skillName, requiredLevel] of Object.entries(requirements)) {
    const current = radar.find((r) => r.skill === skillName);
    const currentLevel = current?.level ?? 0;

    if (currentLevel < requiredLevel) {
      milestones.push({
        skill: skillName,
        current: currentLevel,
        target: requiredLevel,
        suggestions: generateSkillSuggestions(skillName, currentLevel, requiredLevel),
      });
    }
  }

  if (focusArea) {
    const focusSkill = radar.find((r) => r.skill.includes(focusArea));
    if (focusSkill && !milestones.find((m) => m.skill === focusSkill.skill)) {
      milestones.unshift({
        skill: focusSkill.skill,
        current: focusSkill.level,
        target: Math.min(focusSkill.level + 2, focusSkill.maxLevel),
        suggestions: [`重点关注「${focusSkill.skill}」领域，从实际项目中积累经验`],
      });
    }
  }

  milestones.sort((a, b) => (b.target - b.current) - (a.target - a.current));
  return milestones.slice(0, 5);
}

function generateSkillSuggestions(skill: string, current: number, target: number): string[] {
  const suggestions: string[] = [];
  const gap = target - current;

  if (gap >= 3) {
    suggestions.push(`「${skill}」差距较大 (${gap} 级)，建议制定系统学习计划`);
  }

  if (current <= 1) {
    suggestions.push(`从基础教程和实际小任务开始练习「${skill}」`);
  } else if (current === 2) {
    suggestions.push(`尝试在项目中独立负责「${skill}」相关模块`);
  } else if (current === 3) {
    suggestions.push(`承担更大范围的「${skill}」设计工作，参与 Code Review`);
  }

  suggestions.push('每次技能突破时使用 record_milestone 记录');
  return suggestions;
}

function formatRoleName(role: string): string {
  const map: Record<string, string> = {
    senior_developer: 'Senior Developer',
    tech_lead: 'Tech Lead',
    architect: 'Architect',
    engineering_manager: 'Engineering Manager',
  };
  return map[role] ?? role;
}
