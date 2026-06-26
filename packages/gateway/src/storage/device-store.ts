// Created by dev on 2026/04/10
// Copyright © 2026
// 可信设备数据访问层

import { query, getLogger } from '@memforgeai/shared';

const logger = getLogger('device-store');

export type DeviceStatus = 'pending' | 'approved' | 'revoked';

export interface TrustedDevice {
  id: string;
  userId: string;
  deviceId: string;
  deviceName: string | null;
  deviceType: string;
  userAgent: string | null;
  lastIp: string | null;
  status: DeviceStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface DeviceWithUser extends TrustedDevice {
  displayName: string | null;
  externalId: string;
  userRole: string;
}

interface DeviceRow {
  id: string;
  user_id: string;
  device_id: string;
  device_name: string | null;
  device_type: string;
  user_agent: string | null;
  last_ip: string | null;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  last_seen_at: string | null;
  created_at: string;
}

interface DeviceWithUserRow extends DeviceRow {
  display_name: string | null;
  external_id: string;
  user_role: string;
}

function mapRow(row: DeviceRow): TrustedDevice {
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    deviceType: row.device_type,
    userAgent: row.user_agent,
    lastIp: row.last_ip,
    status: row.status as DeviceStatus,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function mapRowWithUser(row: DeviceWithUserRow): DeviceWithUser {
  return {
    ...mapRow(row),
    displayName: row.display_name,
    externalId: row.external_id,
    userRole: row.user_role,
  };
}

export class DeviceStore {
  async findByUserAndDevice(userId: string, deviceId: string): Promise<TrustedDevice | null> {
    const result = await query<DeviceRow>(
      `SELECT * FROM memory.trusted_devices WHERE user_id = $1 AND device_id = $2`,
      [userId, deviceId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async register(params: {
    userId: string;
    deviceId: string;
    deviceName?: string;
    deviceType?: string;
    userAgent?: string;
    ip?: string;
    status?: DeviceStatus;
    approvedBy?: string;
  }): Promise<TrustedDevice> {
    const status = params.status ?? 'pending';
    const result = await query<DeviceRow>(
      `INSERT INTO memory.trusted_devices (user_id, device_id, device_name, device_type, user_agent, last_ip, status, approved_by, approved_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (user_id, device_id) DO UPDATE SET
         device_name = COALESCE(EXCLUDED.device_name, memory.trusted_devices.device_name),
         user_agent = COALESCE(EXCLUDED.user_agent, memory.trusted_devices.user_agent),
         last_ip = COALESCE(EXCLUDED.last_ip, memory.trusted_devices.last_ip),
         last_seen_at = NOW()
       RETURNING *`,
      [
        params.userId,
        params.deviceId,
        params.deviceName ?? null,
        params.deviceType ?? 'web',
        params.userAgent ?? null,
        params.ip ?? null,
        status,
        status === 'approved' ? (params.approvedBy ?? params.userId) : null,
        status === 'approved' ? new Date().toISOString() : null,
      ],
    );
    logger.info({ userId: params.userId, deviceId: params.deviceId, status }, '设备已注册');
    return mapRow(result.rows[0]);
  }

  async approve(id: string, approvedBy: string): Promise<boolean> {
    const result = await query(
      `UPDATE memory.trusted_devices SET status = 'approved', approved_by = $2, approved_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [id, approvedBy],
    );
    const done = (result.rowCount ?? 0) > 0;
    if (done) logger.info({ id, approvedBy }, '设备已批准');
    return done;
  }

  async revoke(id: string): Promise<boolean> {
    const result = await query(
      `UPDATE memory.trusted_devices SET status = 'revoked' WHERE id = $1 AND status = 'approved'`,
      [id],
    );
    const done = (result.rowCount ?? 0) > 0;
    if (done) logger.info({ id }, '设备已吊销');
    return done;
  }

  async remove(id: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM memory.trusted_devices WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listByUser(userId: string): Promise<TrustedDevice[]> {
    const result = await query<DeviceRow>(
      `SELECT * FROM memory.trusted_devices WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows.map(mapRow);
  }

  async listAll(statusFilter?: DeviceStatus): Promise<DeviceWithUser[]> {
    let sql = `SELECT d.*, u.display_name, u.external_id, u.role AS user_role
               FROM memory.trusted_devices d
               JOIN memory.users u ON d.user_id = u.id`;
    const params: string[] = [];
    if (statusFilter) {
      sql += ` WHERE d.status = $1`;
      params.push(statusFilter);
    }
    sql += ` ORDER BY d.created_at DESC`;
    const result = await query<DeviceWithUserRow>(sql, params);
    return result.rows.map(mapRowWithUser);
  }

  async updateLastSeen(userId: string, deviceId: string, ip?: string): Promise<void> {
    await query(
      `UPDATE memory.trusted_devices SET last_seen_at = NOW(), last_ip = COALESCE($3, last_ip)
       WHERE user_id = $1 AND device_id = $2`,
      [userId, deviceId, ip ?? null],
    );
  }

  /**
   * 判断是否为首个 admin 用户的首台设备（bootstrap 场景）。
   * 条件：该用户是 admin 角色，且当前不存在任何已批准的设备。
   */
  async isBootstrapScenario(userId: string): Promise<boolean> {
    const userResult = await query<{ role: string }>(
      `SELECT role FROM memory.users WHERE id = $1 AND is_active = TRUE`,
      [userId],
    );
    if (!userResult.rows[0] || userResult.rows[0].role !== 'admin') return false;

    const deviceResult = await query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM memory.trusted_devices WHERE status = 'approved'`,
    );
    return (deviceResult.rows[0]?.cnt ?? 0) === 0;
  }

  /**
   * 判断该用户是否有至少一台已批准设备（用于 admin 自动批准新设备）
   */
  async hasApprovedDevice(userId: string): Promise<boolean> {
    const result = await query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM memory.trusted_devices
       WHERE user_id = $1 AND status = 'approved'`,
      [userId],
    );
    return (result.rows[0]?.cnt ?? 0) > 0;
  }

  /**
   * 检查某用户某设备是否已批准
   */
  async isDeviceApproved(userId: string, deviceId: string): Promise<boolean> {
    const result = await query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM memory.trusted_devices
       WHERE user_id = $1 AND device_id = $2 AND status = 'approved'`,
      [userId, deviceId],
    );
    return (result.rows[0]?.cnt ?? 0) > 0;
  }

  async getPendingCount(): Promise<number> {
    const result = await query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM memory.trusted_devices WHERE status = 'pending'`,
    );
    return result.rows[0]?.cnt ?? 0;
  }
}
