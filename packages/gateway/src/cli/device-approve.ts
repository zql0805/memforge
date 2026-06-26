#!/usr/bin/env node
// Created by dev on 2026/04/11
// Copyright © 2026
// 紧急设备审批 CLI — 用于 admin 唯一设备丢失后恢复访问
// 用法: node dist/cli/device-approve.js --user <external_id> [--device <device_id>] [--list]

import { initPool, loadDbConfig, query, getLogger } from '@memforgeai/shared';

const logger = getLogger('device-approve-cli');

interface CliArgs {
  user?: string;
  device?: string;
  list?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--user': args.user = argv[++i]; break;
      case '--device': args.device = argv[++i]; break;
      case '--list': args.list = true; break;
      case '--help': case '-h': args.help = true; break;
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`
紧急设备审批工具 — 必须在服务器本地执行

用法:
  node dist/cli/device-approve.js --user <external_id> --device <device_id>
    审批指定用户的指定设备

  node dist/cli/device-approve.js --user <external_id> --list
    列出指定用户的所有待审批设备

  node dist/cli/device-approve.js --list
    列出所有待审批设备

环境变量:
  DATABASE_URL   PostgreSQL 连接字符串（必须）
`);
}

async function listPendingDevices(externalId?: string): Promise<void> {
  let sql = `SELECT d.id, d.device_id, d.device_name, d.device_type, d.last_ip, d.created_at,
                    u.external_id, u.display_name, u.role
             FROM memory.trusted_devices d
             JOIN memory.users u ON d.user_id = u.id
             WHERE d.status = 'pending'`;
  const params: string[] = [];

  if (externalId) {
    sql += ` AND u.external_id = $1`;
    params.push(externalId);
  }
  sql += ` ORDER BY d.created_at DESC`;

  const result = await query<{
    id: string; device_id: string; device_name: string | null; device_type: string;
    last_ip: string | null; created_at: string;
    external_id: string; display_name: string | null; role: string;
  }>(sql, params);

  if (result.rows.length === 0) {
    console.log('没有待审批的设备');
    return;
  }

  console.log(`\n待审批设备 (${result.rows.length} 台):\n`);
  console.log('ID\t\t\t\t\t用户\t\t角色\t设备ID\t\t设备名\t\tIP\t\t时间');
  console.log('-'.repeat(140));
  for (const row of result.rows) {
    console.log(
      `${row.id}\t${row.external_id}\t\t${row.role}\t${row.device_id.substring(0, 16)}...\t${row.device_name ?? '-'}\t\t${row.last_ip ?? '-'}\t\t${row.created_at}`,
    );
  }
}

async function approveDevice(externalId: string, deviceId: string): Promise<void> {
  const result = await query(
    `UPDATE memory.trusted_devices d
     SET status = 'approved', approved_by = d.user_id, approved_at = NOW()
     FROM memory.users u
     WHERE d.user_id = u.id AND u.external_id = $1 AND d.device_id = $2 AND d.status = 'pending'`,
    [externalId, deviceId],
  );

  if ((result.rowCount ?? 0) > 0) {
    console.log(`✓ 设备已审批: 用户=${externalId}, 设备=${deviceId}`);
    logger.info({ externalId, deviceId }, '通过 CLI 紧急审批设备');
  } else {
    console.error(`✗ 未找到匹配的 pending 设备 (用户=${externalId}, 设备=${deviceId})`);
    console.error('  请检查用户 ID 和设备 ID 是否正确，或使用 --list 查看待审批列表');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const dbConfig = loadDbConfig();
  await initPool(dbConfig);

  try {
    if (args.list) {
      await listPendingDevices(args.user);
    } else if (args.user && args.device) {
      await approveDevice(args.user, args.device);
    } else {
      printUsage();
      process.exit(1);
    }
  } finally {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
