// Created by dev on 2026/06/01
// 知识/记忆可见性级联查询 — 从 memory-service 提取的通用隔离逻辑

import { getPool } from './db.js';
import { getLogger } from './logger.js';

const logger = getLogger('visibility');

export interface VisibilityContext {
  orgId: string | null;
  userId: string | null;
  teamIds: string[];
  accessibleProductLines: string[];
}

export interface VisibilityFilterParams {
  orgId?: string | null;
  userId?: string | null;
  teamIds?: string[];
  accessibleProductLines?: string[];
}

/**
 * 可见性 SQL 条件构建器（entries 和 knowledge_items 共用）。
 *
 * 级联规则：
 *   personal (created_by 匹配)
 *   OR team (team_id ∈ 用户所有团队)
 *   OR product_line (project_id ∈ 用户可访问产品线)
 *   OR global
 *
 * @param tableName - 表名前缀，用于区分 entries(project_id) 和 knowledge_items(product_line) 的产品线字段
 * @param productLineColumn - 产品线列名，entries 用 'project_id'，knowledge_items 用 'product_line'
 */
export function buildVisibilityClause(
  filters: VisibilityFilterParams,
  bindings: unknown[],
  startIdx: number,
  productLineColumn = 'project_id',
): { clause: string; nextIdx: number } {
  const vc: string[] = [];
  let idx = startIdx;
  if (filters.userId) {
    vc.push(`(visibility = 'personal' AND created_by = $${idx})`);
    vc.push(`(visibility IS NULL AND created_by = $${idx++})`);
    bindings.push(filters.userId);
  }
  if (filters.teamIds && filters.teamIds.length > 0) {
    vc.push(`(visibility = 'team' AND team_id = ANY($${idx++}))`);
    bindings.push(filters.teamIds);
  }
  if (filters.accessibleProductLines && filters.accessibleProductLines.length > 0) {
    vc.push(`(visibility = 'product_line' AND ${productLineColumn} = ANY($${idx++}))`);
    bindings.push(filters.accessibleProductLines);
  }
  vc.push("visibility = 'global'");
  let clause = `(${vc.join(' OR ')})`;
  if (filters.orgId) {
    clause = `(${clause} AND (org_id = $${idx} OR org_id IS NULL))`;
    bindings.push(filters.orgId);
    idx++;
  }
  return { clause, nextIdx: idx };
}

/**
 * 根据用户/组织/主团队信息，解析完整的 visibility 查询上下文。
 * cross_team=true 时查所有所属团队，否则仅用主团队。
 */
export async function resolveVisibilityContext(
  userId: string | null,
  orgId: string | null,
  primaryTeamId: string | null,
  crossTeam?: boolean,
): Promise<VisibilityContext> {
  if (!userId) {
    return { orgId, userId: null, teamIds: [], accessibleProductLines: [] };
  }

  const pool = getPool();
  let teamIds: string[] = [];

  try {
    if (crossTeam) {
      const { rows } = await pool.query<{ team_id: string }>(
        `SELECT tm.team_id FROM memory.team_members tm
         JOIN memory.teams t ON tm.team_id = t.id
         WHERE tm.user_id = $1 AND ($2::uuid IS NULL OR t.org_id = $2)`,
        [userId, orgId],
      );
      teamIds = rows.map(r => r.team_id);
    } else if (primaryTeamId) {
      teamIds = [primaryTeamId];
    } else {
      const { rows } = await pool.query<{ team_id: string }>(
        `SELECT tm.team_id FROM memory.team_members tm
         JOIN memory.teams t ON tm.team_id = t.id
         WHERE tm.user_id = $1 AND tm.is_primary = TRUE
           AND ($2::uuid IS NULL OR t.org_id = $2)
         LIMIT 1`,
        [userId, orgId],
      );
      teamIds = rows.map(r => r.team_id);
    }
  } catch (err) {
    logger.debug({ err }, '团队查询失败，降级为无团队过滤');
  }

  let accessibleProductLines: string[] = [];
  try {
    const { rows } = await pool.query<{ product_line: string }>(
      `SELECT DISTINCT product_line FROM (
         SELECT product_line FROM memory.user_product_lines WHERE user_id = $1
         UNION
         SELECT product_line FROM memory.team_product_lines WHERE team_id = ANY($2)
       ) sub`,
      [userId, teamIds.length > 0 ? teamIds : ['__none__']],
    );
    accessibleProductLines = rows.map(r => r.product_line);
  } catch {
    logger.debug('产品线权限查询失败，降级为无产品线过滤');
  }

  return { orgId, userId, teamIds, accessibleProductLines };
}
