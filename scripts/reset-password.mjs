#!/usr/bin/env node
// 管理员一次性密码重置脚本 — 在服务器上执行
// 用法: node scripts/reset-password.mjs <external_id> <new_password>

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const [,, externalId, newPassword] = process.argv;
if (!externalId || !newPassword) {
  console.error('用法: node scripts/reset-password.mjs <external_id> <new_password>');
  process.exit(1);
}

const client = new Client({ database: 'memforge' });
await client.connect();

try {
  const hash = await bcrypt.hash(newPassword, 10);
  const result = await client.query(
    `UPDATE memory.users SET password_hash = $1 WHERE external_id = $2 AND is_active = TRUE RETURNING id, external_id, display_name`,
    [hash, externalId],
  );
  if (result.rows.length === 0) {
    console.error(`用户 ${externalId} 不存在或已停用`);
    process.exit(1);
  }
  const user = result.rows[0];
  console.log(`密码已重置: ${user.display_name ?? user.external_id} (id: ${user.id})`);
} finally {
  await client.end();
}
