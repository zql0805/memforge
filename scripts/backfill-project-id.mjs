#!/usr/bin/env node
// Created by dev on 2026/04/06
// Copyright © 2026
// 回填 project_id='default' 的记忆条目
//
// 策略：
//   1. tags 包含 'bootstrap' + 'document' + 'file:*.md' → memforge（来自 memforge docs 索引）
//   2. tags 包含 'bootstrap' + ('skill' 或 'cursor-rule') → _global_（全局技能/规则）
//   3. tags 包含 'memforge' → memforge（会话摘要等）
//   4. tags 包含 'session-summary' + 任何产品线名 → 对应产品线
//   5. 其余保留 default

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://memforge:memforge_dev@localhost:5432/memforge';
const DRY_RUN = process.argv.includes('--dry-run');

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, tags, title
    FROM memory.entries
    WHERE project_id = 'default'
    ORDER BY created_at
  `);

  console.log(`找到 ${rows.length} 条 project_id='default' 的记忆`);
  if (DRY_RUN) console.log('(DRY RUN 模式，不会实际修改)');

  const stats = { memforge: 0, _global_: 0, unchanged: 0 };

  for (const row of rows) {
    const tags = row.tags ?? [];
    let newProjectId = null;

    if (tags.includes('bootstrap') && tags.includes('document') && tags.some(t => t.startsWith('file:'))) {
      newProjectId = 'memforge';
    } else if (tags.includes('bootstrap') && (tags.includes('skill') || tags.includes('cursor-rule'))) {
      newProjectId = '_global_';
    } else if (tags.some(t => t.includes('memforge'))) {
      newProjectId = 'memforge';
    } else {
      // 从 pl:<product_line> 标签中通用解析产品线
      const plTag = tags.find(t => t.startsWith('pl:'));
      if (plTag) {
        newProjectId = plTag.slice(3); // 'pl:<product_line>' → '<product_line>'
      }
    }

    if (newProjectId) {
      if (!DRY_RUN) {
        await pool.query(
          `UPDATE memory.entries SET project_id = $1 WHERE id = $2`,
          [newProjectId, row.id],
        );
      }
      stats[newProjectId] = (stats[newProjectId] ?? 0) + 1;
    } else {
      stats.unchanged++;
    }
  }

  console.log('\n回填结果:');
  for (const [project, count] of Object.entries(stats)) {
    if (count > 0) console.log(`  ${project}: ${count} 条`);
  }

  const totalUpdated = rows.length - stats.unchanged;
  console.log(`\n总计: ${totalUpdated} 条已${DRY_RUN ? '(将被)' : ''}更新, ${stats.unchanged} 条保留 default`);

  await pool.end();
}

main().catch(err => {
  console.error('回填失败:', err);
  process.exit(1);
});
