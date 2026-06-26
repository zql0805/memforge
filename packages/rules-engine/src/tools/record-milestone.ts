// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: record_milestone — 记录技能成长里程碑

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { SkillEvidence } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';

const logger = getLogger('tool:record-milestone');

export function registerRecordMilestone(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'record_milestone',
    '记录一个技能成长里程碑事件，自动关联到技能树和记忆库',
    {
      skill_name: z.string().describe('技能名称'),
      description: z.string().describe('里程碑描述'),
      evidence_type: z.enum([
        'code_commit', 'code_review', 'bug_fix',
        'architecture_decision', 'mentoring', 'learning',
      ]).optional().describe('证据类型'),
      evidence_ref: z.string().optional().describe('证据引用 (commit hash / URL / 记忆 ID)'),
      user_id: z.string().optional().describe('（已忽略，操作人由 Gateway 身份决定）'),
    },
    async ({ skill_name, description, evidence_type, evidence_ref }) => {
      const orgId = ctx.orgId ?? '00000000-0000-0000-0000-000000000001';
      const effectiveUserId = ctx.userId ?? 'default-user';

      const skillDef = await ctx.skillStore.findSkillByName(orgId, skill_name);
      if (!skillDef) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `未找到技能「${skill_name}」。请先通过 assess_skill 查看可用技能列表。`,
            }, null, 2),
          }],
        };
      }

      const existingSkill = await ctx.skillStore.getUserSkill(effectiveUserId, skillDef.id);
      const currentLevel = existingSkill?.currentLevel ?? 1;
      const currentEvidence = existingSkill?.evidence ?? [];

      const newEvidence: SkillEvidence = {
        level: currentLevel,
        evidenceType: (evidence_type ?? 'learning') as SkillEvidence['evidenceType'],
        evidenceRef: evidence_ref ?? null,
        description,
        observedAt: new Date().toISOString().split('T')[0],
        assessedBy: 'self',
      };

      const allEvidence = [...currentEvidence, newEvidence];

      const shouldLevelUp = allEvidence.filter((e) => e.level === currentLevel).length >= 3
        && currentLevel < skillDef.maxLevel;

      const newLevel = shouldLevelUp ? currentLevel + 1 : currentLevel;
      const newConfidence = Math.min(0.9, (existingSkill?.confidence ?? 0.3) + 0.1);

      await ctx.skillStore.upsertUserSkill(
        effectiveUserId,
        skillDef.id,
        newLevel,
        newConfidence,
        allEvidence,
      );

      const eventType = shouldLevelUp ? 'level_up' : 'milestone_reached';
      await ctx.skillStore.recordSkillEvent(
        effectiveUserId,
        skillDef.id,
        eventType,
        currentLevel,
        newLevel,
        { description, evidence_type, evidence_ref },
      );

      logger.info({
        skill: skill_name,
        level: newLevel,
        levelUp: shouldLevelUp,
      }, '里程碑记录成功');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            skill: skillDef.name,
            level: newLevel,
            previousLevel: currentLevel,
            leveledUp: shouldLevelUp,
            confidencePercent: Math.round(newConfidence * 100),
            evidenceCount: allEvidence.length,
            description,
            eventType,
            levelUpMessage: shouldLevelUp
              ? `恭喜！「${skill_name}」技能升级：Level ${currentLevel} → Level ${newLevel}！`
              : null,
          }, null, 2),
        }],
      };
    },
  );
}
