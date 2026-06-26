// Created by dev on 2026/04/05
// Copyright © 2026
// 用户数据访问层

import { query, getLogger } from '@memforgeai/shared';
import bcrypt from 'bcryptjs';
import type { AuthUser, AuthUserFull, UserRole } from '../auth/types.js';
import { validatePassword } from '../auth/password-policy.js';

const logger = getLogger('user-store');
const BCRYPT_ROUNDS = 10;

export class UserStore {
  /**
   * 按内部 ID 查找用户
   */
  async findById(id: string): Promise<AuthUser | null> {
    const result = await query<UserRow>(
      `SELECT id, org_id, external_id, email, display_name, role
       FROM memory.users WHERE id = $1 AND is_active = TRUE`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /**
   * 按外部 ID（SSO subject）查找或创建用户
   */
  async findOrCreateByExternalId(params: {
    orgId: string;
    externalId: string;
    email?: string;
    displayName?: string;
    role?: UserRole;
  }): Promise<AuthUser> {
    const existing = await query<UserRow>(
      `SELECT id, org_id, external_id, email, display_name, role
       FROM memory.users WHERE org_id = $1 AND external_id = $2`,
      [params.orgId, params.externalId],
    );

    if (existing.rows[0]) {
      // 更新最后登录时间
      await query(
        `UPDATE memory.users SET last_login_at = NOW() WHERE id = $1`,
        [existing.rows[0].id],
      );
      return mapRow(existing.rows[0]);
    }

    // 创建新用户
    const result = await query<UserRow>(
      `INSERT INTO memory.users (org_id, external_id, email, display_name, role, last_login_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, org_id, external_id, email, display_name, role`,
      [params.orgId, params.externalId, params.email ?? null, params.displayName ?? null, params.role ?? 'developer'],
    );

    logger.info({ externalId: params.externalId, orgId: params.orgId }, '新用户已创建');
    return mapRow(result.rows[0]);
  }

  /**
   * 纯登录验证 — 只验证已有用户，不自动注册。
   * 返回 { user } | { error, message }（弱密码） | null（不存在/密码错误/已停用）。
   */
  async authenticateOnly(params: {
    orgId: string;
    externalId: string;
    password: string;
  }): Promise<{ user: AuthUser } | { error: string; message: string } | null> {
    const existing = await query<UserRow & { password_hash: string | null; is_active: boolean }>(
      `SELECT id, org_id, external_id, email, display_name, role, password_hash, is_active
       FROM memory.users WHERE org_id = $1 AND external_id = $2`,
      [params.orgId, params.externalId],
    );

    if (!existing.rows[0]) return null;

    const row = existing.rows[0];
    if (!row.is_active) {
      logger.warn({ externalId: params.externalId }, '已停用的用户尝试登录');
      return null;
    }

    if (!row.password_hash) {
      const pwCheck = validatePassword(params.password);
      if (!pwCheck.valid) {
        return { error: 'weak_password', message: pwCheck.message };
      }
      const hash = await bcrypt.hash(params.password, BCRYPT_ROUNDS);
      await query(
        `UPDATE memory.users SET password_hash = $1, last_login_at = NOW() WHERE id = $2`,
        [hash, row.id],
      );
      logger.info({ externalId: params.externalId }, '老用户首次设置密码');
      return { user: mapRow(row) };
    }

    const valid = await bcrypt.compare(params.password, row.password_hash);
    if (!valid) return null;

    await query(`UPDATE memory.users SET last_login_at = NOW() WHERE id = $1`, [row.id]);
    return { user: mapRow(row) };
  }

  /**
   * 验证用户密码。若用户存在但未设置密码，自动设置密码并返回成功。
   * 若用户不存在，自动注册。
   * 返回 { user, isNewUser } | { error, message } | null（密码错误/用户停用）。
   */
  async authenticateWithPassword(params: {
    orgId: string;
    externalId: string;
    password: string;
    displayName?: string;
  }): Promise<{ user: AuthUser; isNewUser: boolean } | { error: string; message: string } | null> {
    // 不过滤 is_active：先找到用户再判断状态，防止停用用户触发 INSERT 唯一约束冲突
    const existing = await query<UserRow & { password_hash: string | null; is_active: boolean }>(
      `SELECT id, org_id, external_id, email, display_name, role, password_hash, is_active
       FROM memory.users WHERE org_id = $1 AND external_id = $2`,
      [params.orgId, params.externalId],
    );

    if (existing.rows[0]) {
      const row = existing.rows[0];

      if (!row.is_active) {
        logger.warn({ externalId: params.externalId }, '已停用的用户尝试登录');
        return null;
      }

      if (!row.password_hash) {
        const pwCheck = validatePassword(params.password);
        if (!pwCheck.valid) {
          logger.warn({ externalId: params.externalId }, '老用户首次设密码但不满足强度要求');
          return { error: 'weak_password', message: pwCheck.message };
        }
        const hash = await bcrypt.hash(params.password, BCRYPT_ROUNDS);
        await query(
          `UPDATE memory.users SET password_hash = $1, last_login_at = NOW() WHERE id = $2`,
          [hash, row.id],
        );
        logger.info({ externalId: params.externalId }, '老用户首次设置密码');
        return { user: mapRow(row), isNewUser: false };
      }

      const valid = await bcrypt.compare(params.password, row.password_hash);
      if (!valid) return null;

      await query(`UPDATE memory.users SET last_login_at = NOW() WHERE id = $1`, [row.id]);
      return { user: mapRow(row), isNewUser: false };
    }

    // 新用户注册
    const pwCheck = validatePassword(params.password);
    if (!pwCheck.valid) {
      logger.warn({ externalId: params.externalId }, '新用户注册密码不满足强度要求');
      return { error: 'weak_password', message: pwCheck.message };
    }
    const hash = await bcrypt.hash(params.password, BCRYPT_ROUNDS);
    const result = await query<UserRow>(
      `INSERT INTO memory.users (org_id, external_id, email, display_name, role, password_hash, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id, org_id, external_id, email, display_name, role`,
      [params.orgId, params.externalId, null, params.displayName ?? null, 'developer', hash],
    );
    logger.info({ externalId: params.externalId }, '新用户注册');
    return { user: mapRow(result.rows[0]), isNewUser: true };
  }

  /**
   * 列出组织下的所有活跃用户
   */
  async listByOrg(orgId: string): Promise<AuthUser[]> {
    const result = await query<UserRow>(
      `SELECT id, org_id, external_id, email, display_name, role
       FROM memory.users WHERE org_id = $1 AND is_active = TRUE
       ORDER BY created_at`,
      [orgId],
    );
    return result.rows.map(mapRow);
  }

  /**
   * 更新用户角色
   */
  async updateRole(userId: string, role: UserRole): Promise<void> {
    await query(
      `UPDATE memory.users SET role = $1 WHERE id = $2`,
      [role, userId],
    );
    logger.info({ userId, role }, '用户角色已更新');
  }

  /**
   * 列出所有活跃用户（admin 用）
   */
  async listAll(): Promise<AuthUserFull[]> {
    const result = await query<UserRowFull>(
      `SELECT id, org_id, external_id, email, display_name, role, is_super_admin, last_login_at, created_at
       FROM memory.users WHERE is_active = TRUE
       ORDER BY created_at`,
    );
    return result.rows.map(mapRowFull);
  }

  /** 按 ID 获取完整用户信息（含 is_super_admin） */
  async findFullById(id: string): Promise<AuthUserFull | null> {
    const result = await query<UserRowFull>(
      `SELECT id, org_id, external_id, email, display_name, role, is_super_admin, last_login_at, created_at
       FROM memory.users WHERE id = $1 AND is_active = TRUE`,
      [id],
    );
    return result.rows[0] ? mapRowFull(result.rows[0]) : null;
  }

  /**
   * 停用用户（软删除）
   */
  async deactivate(userId: string): Promise<boolean> {
    const result = await query(
      `UPDATE memory.users SET is_active = FALSE WHERE id = $1 AND is_active = TRUE`,
      [userId],
    );
    const done = (result.rowCount ?? 0) > 0;
    if (done) logger.info({ userId }, '用户已停用');
    return done;
  }

  /**
   * 修改密码（需要验证旧密码）
   */
  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<boolean> {
    const result = await query<{ password_hash: string | null }>(
      `SELECT password_hash FROM memory.users WHERE id = $1 AND is_active = TRUE`,
      [userId],
    );
    if (!result.rows[0]) return false;

    const row = result.rows[0];
    if (row.password_hash) {
      const valid = await bcrypt.compare(oldPassword, row.password_hash);
      if (!valid) return false;
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await query(`UPDATE memory.users SET password_hash = $1 WHERE id = $2`, [hash, userId]);
    logger.info({ userId }, '密码已修改');
    return true;
  }

  /**
   * 管理员重置密码（不需要旧密码）
   */
  async resetPassword(userId: string, newPassword: string): Promise<boolean> {
    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const result = await query(
      `UPDATE memory.users SET password_hash = $1 WHERE id = $2 AND is_active = TRUE`,
      [hash, userId],
    );
    const done = (result.rowCount ?? 0) > 0;
    if (done) logger.info({ userId }, '密码已由管理员重置');
    return done;
  }

  /**
   * 修改昵称
   */
  async updateDisplayName(userId: string, displayName: string): Promise<boolean> {
    const result = await query(
      `UPDATE memory.users SET display_name = $1 WHERE id = $2 AND is_active = TRUE`,
      [displayName, userId],
    );
    const done = (result.rowCount ?? 0) > 0;
    if (done) logger.info({ userId }, '昵称已修改');
    return done;
  }

  /**
   * 更新超级管理员状态
   */
  async updateSuperAdmin(userId: string, isSuperAdmin: boolean): Promise<void> {
    await query(
      `UPDATE memory.users SET is_super_admin = $1 WHERE id = $2`,
      [isSuperAdmin, userId],
    );
    logger.info({ userId, isSuperAdmin }, '超级管理员状态已更新');
  }
}

interface UserRow {
  id: string;
  org_id: string;
  external_id: string;
  email: string | null;
  display_name: string | null;
  role: string;
}

interface UserRowFull extends UserRow {
  is_super_admin: boolean;
  last_login_at: string | null;
  created_at: string;
}

function mapRow(row: UserRow): AuthUser {
  return {
    id: row.id,
    orgId: row.org_id,
    externalId: row.external_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role as UserRole,
  };
}

function mapRowFull(row: UserRowFull): AuthUserFull {
  return {
    ...mapRow(row),
    isSuperAdmin: row.is_super_admin,
  };
}
