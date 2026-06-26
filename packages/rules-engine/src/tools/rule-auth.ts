// Created by dev on 2026/06/11
// 规则读写权限校验

import type { Rule } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';

export function isAdminOrLead(ctx: RulesToolContext): boolean {
  return ctx.userRole === 'admin' || ctx.userRole === 'lead';
}

export function canModifyRule(
  ctx: RulesToolContext,
  createdBy: string | null | undefined,
): boolean {
  if (isAdminOrLead(ctx)) return true;
  return !!(ctx.userId && createdBy && ctx.userId === createdBy);
}

/** 非 admin/lead 只能查询自己的技能数据，防止 IDOR */
export function resolveSkillUserId(ctx: RulesToolContext, requestedUserId?: string): string {
  if (isAdminOrLead(ctx) && requestedUserId) return requestedUserId;
  return ctx.userId ?? 'default-user';
}

/** 活跃规则/列表查询的 visibility 过滤条件 */
export function buildVisibilityTeamFilter(ctx: RulesToolContext): {
  teamIds?: string[];
  userId?: string;
} | undefined {
  if (!ctx.userId) return undefined;
  return {
    teamIds: ctx.teamId ? [ctx.teamId] : undefined,
    userId: ctx.userId,
  };
}

/** 按 visibility 判断当前用户是否可读该规则 */
export function canViewRule(
  ctx: RulesToolContext,
  rule: Pick<Rule, 'visibility' | 'createdBy' | 'teamId' | 'projectId'>,
): boolean {
  if (isAdminOrLead(ctx)) return true;

  const visibility = rule.visibility ?? 'global';
  if (visibility === 'global') return true;

  if (visibility === 'personal') {
    return !!(ctx.userId && rule.createdBy && ctx.userId === rule.createdBy);
  }

  if (visibility === 'team') {
    // context 无 teamId 时无法校验，降级放行
    if (!ctx.teamId) return true;
    return rule.teamId === ctx.teamId;
  }

  if (visibility === 'product_line') {
    const userPl = ctx.gitContext?.projectName;
    if (!userPl) {
      // TODO: RulesToolContext 未携带用户可访问产品线列表，暂无法严格校验 product_line 可见性
      return false;
    }
    return rule.projectId === userPl;
  }

  return true;
}
