// Created by dev on 2026/06/12
import { resolveVisibilityContext, type VisibilityFilterParams } from '@memforgeai/shared';
import type { KnowledgeToolContext } from '../tools/types.js';
import { isAdminOrLead } from './permissions.js';

type VisibilityCtx = Pick<KnowledgeToolContext, 'userId' | 'orgId' | 'teamId' | 'userRole'>;

/** 解析 knowledge 列表/浏览查询的 visibility 过滤条件 */
export async function resolveKnowledgeVisibilityFilters(
  ctx: VisibilityCtx,
  productLine?: string,
): Promise<VisibilityFilterParams | undefined> {
  if (!ctx.userId) return undefined;

  if (productLine) {
    return {
      userId: ctx.userId,
      orgId: ctx.orgId ?? null,
      teamIds: ctx.teamId ? [ctx.teamId] : [],
      accessibleProductLines: [productLine],
    };
  }

  const visCtx = await resolveVisibilityContext(ctx.userId, ctx.orgId ?? null, ctx.teamId ?? null);
  return {
    userId: visCtx.userId,
    orgId: visCtx.orgId,
    teamIds: visCtx.teamIds,
    accessibleProductLines: visCtx.accessibleProductLines,
  };
}

/** 单条知识可见性校验（read/getById 场景） */
export function canViewKnowledgeItem(
  item: {
    visibility?: string | null;
    createdBy?: string | null;
    teamId?: string | null;
    productLine?: string | null;
  },
  ctx: VisibilityCtx & { accessibleProductLines?: string[] },
): boolean {
  if (isAdminOrLead(ctx.userRole)) return true;

  const visibility = item.visibility ?? 'product_line';

  if (visibility === 'global') return true;

  if (visibility === 'personal' || visibility == null) {
    return !!(ctx.userId && item.createdBy && ctx.userId === item.createdBy);
  }

  if (visibility === 'team') {
    if (!ctx.teamId) return false;
    return item.teamId === ctx.teamId;
  }

  if (visibility === 'product_line') {
    if (!ctx.accessibleProductLines?.length) {
      // TODO: 未解析用户可访问产品线时无法严格校验，拒绝访问
      return false;
    }
    return !!(item.productLine && ctx.accessibleProductLines.includes(item.productLine));
  }

  return false;
}
