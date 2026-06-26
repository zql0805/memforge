// Created by dev on 2026/04/09
// Copyright © 2026
// 产品线级别访问控制（ACL）

import { query, getLogger } from '@memforgeai/shared';
import type { ProductLineAccessLevel, ProductLineAccess } from './types.js';

const logger = getLogger('pl-acl');

const LEVEL_HIERARCHY: Record<ProductLineAccessLevel, number> = {
  read: 1,
  write: 2,
  manage: 3,
};

export class ProductLineACL {
  /**
   * 检查用户是否有权访问指定产品线。
   * is_super_admin 用户跳过检查。
   */
  async checkAccess(
    userId: string,
    productLine: string,
    requiredLevel: ProductLineAccessLevel,
  ): Promise<boolean> {
    if (await this.isSuperAdmin(userId)) return true;

    const plLower = productLine.toLowerCase();

    // 先检查直接授权
    const direct = await query<{ access_level: string }>(
      `SELECT access_level FROM memory.user_product_lines
       WHERE user_id = $1 AND product_line = $2`,
      [userId, plLower],
    );
    if (direct.rows.length > 0) {
      const userLevel = direct.rows[0].access_level as ProductLineAccessLevel;
      return LEVEL_HIERARCHY[userLevel] >= LEVEL_HIERARCHY[requiredLevel];
    }

    // 再检查团队继承（团队成员默认获得 read 权限）
    if (requiredLevel === 'read') {
      const teamAccess = await query<{ product_line: string }>(
        `SELECT tpl.product_line FROM memory.team_product_lines tpl
         JOIN memory.team_members tm ON tm.team_id = tpl.team_id
         WHERE tm.user_id = $1 AND tpl.product_line = $2
         LIMIT 1`,
        [userId, plLower],
      );
      return teamAccess.rows.length > 0;
    }

    return false;
  }

  /**
   * 检查产品线是否已存在（ACL 表中至少有一条记录）。
   * 用于区分"新产品线首次创建"和"已有产品线无权访问"。
   */
  async isProductLineExists(productLine: string): Promise<boolean> {
    const result = await query<{ cnt: number }>(
      `SELECT COUNT(*)::int as cnt FROM memory.user_product_lines WHERE product_line = $1`,
      [productLine.toLowerCase()],
    );
    return result.rows[0].cnt > 0;
  }

  /** 获取用户可访问的所有产品线（合并 user_product_lines + team_product_lines） */
  async getAccessibleProductLines(userId: string): Promise<ProductLineAccess[]> {
    if (await this.isSuperAdmin(userId)) {
      // 超管看到所有产品线：合并 topology_nodes + user_product_lines + entries 中出现的产品线
      const result = await query<{ product_line: string }>(
        `SELECT DISTINCT product_line FROM (
           SELECT DISTINCT product_line FROM memory.topology_nodes WHERE product_line != '_default_'
           UNION
           SELECT DISTINCT product_line FROM memory.user_product_lines
           UNION
           SELECT DISTINCT project_id AS product_line FROM memory.entries
             WHERE project_id IS NOT NULL AND project_id != '' AND project_id != '_global_'
         ) sub ORDER BY product_line`,
      );
      return result.rows.map(r => ({
        productLine: r.product_line,
        accessLevel: 'manage' as ProductLineAccessLevel,
        grantedBy: null,
        createdAt: new Date().toISOString(),
      }));
    }

    const result = await query<{
      product_line: string;
      access_level: string;
      granted_by: string | null;
      created_at: string;
      source: string;
    }>(
      `SELECT product_line, access_level, granted_by::text, created_at::text, 'user' AS source
       FROM memory.user_product_lines
       WHERE user_id = $1
       UNION
       SELECT tpl.product_line, 'read' AS access_level, NULL AS granted_by, tpl.created_at::text, 'team' AS source
       FROM memory.team_product_lines tpl
       JOIN memory.team_members tm ON tm.team_id = tpl.team_id
       WHERE tm.user_id = $1
       ORDER BY product_line`,
      [userId],
    );

    const merged = new Map<string, ProductLineAccess>();
    for (const r of result.rows) {
      const existing = merged.get(r.product_line);
      if (!existing || LEVEL_HIERARCHY[r.access_level as ProductLineAccessLevel] > LEVEL_HIERARCHY[existing.accessLevel]) {
        merged.set(r.product_line, {
          productLine: r.product_line,
          accessLevel: r.access_level as ProductLineAccessLevel,
          grantedBy: r.granted_by,
          createdAt: r.created_at,
        });
      }
    }
    return [...merged.values()];
  }

  /** 获取用户可访问的产品线名称列表 */
  async getAccessibleProductLineNames(userId: string): Promise<string[]> {
    const list = await this.getAccessibleProductLines(userId);
    return list.map(p => p.productLine);
  }

  /** 授予用户产品线访问权限 */
  async grantAccess(
    userId: string,
    productLine: string,
    level: ProductLineAccessLevel,
    grantedBy: string,
  ): Promise<void> {
    await query(
      `INSERT INTO memory.user_product_lines (user_id, product_line, access_level, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, product_line) DO UPDATE SET
         access_level = EXCLUDED.access_level,
         granted_by = EXCLUDED.granted_by`,
      [userId, productLine.toLowerCase(), level, grantedBy],
    );
    logger.info({ userId, productLine, level, grantedBy }, '产品线权限已授予');
  }

  /** 撤销用户产品线访问权限 */
  async revokeAccess(userId: string, productLine: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM memory.user_product_lines
       WHERE user_id = $1 AND product_line = $2`,
      [userId, productLine.toLowerCase()],
    );
    const deleted = (result.rowCount ?? 0) > 0;
    if (deleted) {
      logger.info({ userId, productLine }, '产品线权限已撤销');
    }
    return deleted;
  }

  /** 列出产品线的所有成员 */
  async getProductLineMembers(productLine: string): Promise<Array<{
    userId: string;
    displayName: string | null;
    email: string | null;
    role: string;
    accessLevel: ProductLineAccessLevel;
  }>> {
    const result = await query<{
      user_id: string;
      display_name: string | null;
      email: string | null;
      role: string;
      access_level: string;
    }>(
      `SELECT upl.user_id, u.display_name, u.email, u.role, upl.access_level
       FROM memory.user_product_lines upl
       JOIN memory.users u ON u.id = upl.user_id AND u.is_active = TRUE
       WHERE upl.product_line = $1
       ORDER BY upl.access_level DESC, u.display_name`,
      [productLine.toLowerCase()],
    );

    return result.rows.map(r => ({
      userId: r.user_id,
      displayName: r.display_name,
      email: r.email,
      role: r.role,
      accessLevel: r.access_level as ProductLineAccessLevel,
    }));
  }

  private async isSuperAdmin(userId: string): Promise<boolean> {
    const result = await query<{ is_super_admin: boolean }>(
      `SELECT is_super_admin FROM memory.users WHERE id = $1 AND is_active = TRUE`,
      [userId],
    );
    return result.rows[0]?.is_super_admin === true;
  }
}
