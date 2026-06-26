#!/usr/bin/env node
// Created by dev on 2026/04/06
// Copyright © 2026
// backfill metadata.source_project — 让 metadata 中的来源与 project_id 保持一致

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://memforge:memforge_dev@localhost:5432/memforge';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    console.log(`🔧 Backfill metadata.source_project (dry_run=${DRY_RUN})`);
    console.log('');

    const { rows: entries } = await pool.query(`
      SELECT id, title, project_id, metadata
      FROM memory.entries
      WHERE is_archived = false
        AND project_id IS NOT NULL
        AND project_id != 'default'
    `);

    let updated = 0;
    let skipped = 0;
    let alreadyCorrect = 0;

    for (const entry of entries) {
      const meta = entry.metadata ?? {};
      const currentSourceProject = meta.source_project;
      const projectId = entry.project_id;

      if (currentSourceProject === projectId) {
        alreadyCorrect++;
        continue;
      }

      if (DRY_RUN) {
        const from = currentSourceProject ?? '(未设置)';
        console.log(`  [DRY] ${entry.title.slice(0, 50)} : ${from} → ${projectId}`);
        updated++;
        continue;
      }

      const newMeta = { ...meta, source_project: projectId };
      await pool.query(
        `UPDATE memory.entries SET metadata = $1 WHERE id = $2`,
        [JSON.stringify(newMeta), entry.id],
      );
      updated++;
    }

    console.log('');
    console.log(`📊 结果:`);
    console.log(`  总记忆数: ${entries.length}`);
    console.log(`  已正确:   ${alreadyCorrect}`);
    console.log(`  需更新:   ${updated}`);
    console.log(`  跳过:     ${skipped}`);

    if (DRY_RUN) {
      console.log('');
      console.log('⚠️  DRY RUN 模式，未实际修改。移除 --dry-run 执行实际更新。');
    } else {
      console.log('');
      console.log('✅ Backfill 完成');
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌ 执行失败:', err.message);
  process.exit(1);
});
