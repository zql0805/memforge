#!/usr/bin/env node
// Created by dev on 2026/04/04
// Copyright © 2026
// SQLite → PostgreSQL 数据迁移脚本
// 用法: node scripts/migrate-sqlite-to-pg.mjs --memory-db ./data/memforge.db --rules-db ./data/rules.db

import Database from 'better-sqlite3';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i += 2) {
  flags[args[i].replace('--', '')] = args[i + 1];
}

const PG_URL = process.env.DATABASE_URL ?? 'postgresql://memforge:memforge_dev@localhost:5432/memforge';

async function main() {
  console.log('\n📦 SQLite → PostgreSQL 数据迁移\n');

  const pool = new pg.Pool({ connectionString: PG_URL });
  const client = await pool.connect();
  await client.query('SET search_path TO memory, public');

  try {
    if (flags['memory-db'] && existsSync(flags['memory-db'])) {
      await migrateMemories(client, flags['memory-db']);
    } else if (flags['memory-db']) {
      console.log(`⚠️  Memory DB 文件不存在: ${flags['memory-db']}`);
    }

    if (flags['rules-db'] && existsSync(flags['rules-db'])) {
      await migrateRules(client, flags['rules-db']);
    } else if (flags['rules-db']) {
      console.log(`⚠️  Rules DB 文件不存在: ${flags['rules-db']}`);
    }

    if (!flags['memory-db'] && !flags['rules-db']) {
      console.log('用法: node scripts/migrate-sqlite-to-pg.mjs --memory-db ./data/memforge.db --rules-db ./data/rules.db');
      console.log('  --memory-db  SQLite memory 数据库路径');
      console.log('  --rules-db   SQLite rules 数据库路径');
      console.log('  DATABASE_URL 环境变量指定 PostgreSQL 连接（默认 localhost）');
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log('\n✅ 迁移完成\n');
}

async function migrateMemories(pgClient, sqlitePath) {
  console.log(`── 迁移 Memory 数据 (${sqlitePath}) ──`);
  const db = new Database(sqlitePath, { readonly: true });
  const rows = db.prepare('SELECT * FROM entries').all();
  console.log(`  找到 ${rows.length} 条记忆`);

  let migrated = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      let embedding = null;
      if (row.embedding) {
        try {
          const parsed = JSON.parse(row.embedding);
          if (Array.isArray(parsed)) embedding = `[${parsed.join(',')}]`;
        } catch { /* 无法解析的 embedding 跳过 */ }
      }

      let metadata = '{}';
      if (row.metadata) {
        try { metadata = typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata); }
        catch { metadata = '{}'; }
      }

      let tags = [];
      if (row.tags) {
        try { tags = JSON.parse(row.tags); } catch { tags = []; }
      }

      await pgClient.query(
        `INSERT INTO memory.entries
          (id, project_id, branch_id, title, content, scope, source, tags, embedding, metadata, is_archived, archived_reason, created_at, updated_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id ?? randomUUID(),
          row.project_id ?? 'default',
          row.branch_id ?? null,
          row.title,
          row.content,
          row.scope ?? 'project',
          row.source ?? 'manual',
          tags,
          embedding,
          metadata,
          row.is_archived ? true : false,
          row.archived_reason ?? null,
          row.created_at ?? new Date().toISOString(),
          row.updated_at ?? new Date().toISOString(),
          row.expires_at ?? null,
        ],
      );
      migrated++;
    } catch (err) {
      console.log(`  ⚠️ 跳过记忆 ${row.id}: ${err.message}`);
      skipped++;
    }
  }

  const metaRows = db.prepare("SELECT * FROM embedding_meta WHERE key = 'embedding_dimensions'").all();
  for (const meta of metaRows) {
    await pgClient.query(
      `INSERT INTO memory.embedding_meta (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [meta.key, meta.value],
    );
  }

  db.close();
  console.log(`  ✅ 迁移 ${migrated} 条，跳过 ${skipped} 条\n`);
}

async function migrateRules(pgClient, sqlitePath) {
  console.log(`── 迁移 Rules 数据 (${sqlitePath}) ──`);
  const db = new Database(sqlitePath, { readonly: true });

  // 迁移规则
  const rules = db.prepare('SELECT * FROM coding_rules').all();
  console.log(`  找到 ${rules.length} 条规则`);

  let rulesMigrated = 0;
  for (const row of rules) {
    try {
      let embedding = null;
      if (row.embedding) {
        try {
          const parsed = JSON.parse(row.embedding);
          if (Array.isArray(parsed)) embedding = `[${parsed.join(',')}]`;
        } catch { /* skip */ }
      }

      let sourceRef = null;
      if (row.source_ref) {
        try { sourceRef = typeof row.source_ref === 'string' ? row.source_ref : JSON.stringify(row.source_ref); }
        catch { sourceRef = null; }
      }

      await pgClient.query(
        `INSERT INTO memory.coding_rules
          (id, project_id, title, description, rationale, example_good, example_bad,
           auto_fix, category, language, severity, status, source, source_ref,
           embedding, applied_count, violated_count, accepted_count, rejected_count,
           activated_at, deprecated_at, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id ?? randomUUID(), row.project_id ?? 'default',
          row.title, row.description, row.rationale,
          row.example_good, row.example_bad, row.auto_fix,
          row.category, row.language, row.severity ?? 'warning',
          row.status ?? 'candidate', row.source ?? 'manual', sourceRef,
          embedding,
          row.applied_count ?? 0, row.violated_count ?? 0,
          row.accepted_count ?? 0, row.rejected_count ?? 0,
          row.activated_at, row.deprecated_at, row.created_by,
          row.created_at ?? new Date().toISOString(),
          row.updated_at ?? new Date().toISOString(),
        ],
      );
      rulesMigrated++;
    } catch (err) {
      console.log(`  ⚠️ 跳过规则 ${row.id}: ${err.message}`);
    }
  }
  console.log(`  ✅ 迁移 ${rulesMigrated} 条规则`);

  // 迁移投票
  const votes = db.prepare('SELECT * FROM rule_votes').all();
  let votesMigrated = 0;
  for (const v of votes) {
    try {
      await pgClient.query(
        `INSERT INTO memory.rule_votes (id, rule_id, user_id, role, vote, comment, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [v.id ?? randomUUID(), v.rule_id, v.user_id, v.role ?? 'developer', v.vote, v.comment, v.created_at],
      );
      votesMigrated++;
    } catch { /* skip */ }
  }
  console.log(`  ✅ 迁移 ${votesMigrated} 条投票`);

  // 迁移事件
  const events = db.prepare('SELECT * FROM rule_events').all();
  let eventsMigrated = 0;
  for (const e of events) {
    try {
      let metadata = '{}';
      if (e.metadata) {
        try { metadata = typeof e.metadata === 'string' ? e.metadata : JSON.stringify(e.metadata); }
        catch { metadata = '{}'; }
      }

      await pgClient.query(
        `INSERT INTO memory.rule_events (id, rule_id, event_type, file_path, code_snippet, user_id, metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [e.id ?? randomUUID(), e.rule_id, e.event_type, e.file_path, e.code_snippet, e.user_id, metadata, e.created_at],
      );
      eventsMigrated++;
    } catch { /* skip */ }
  }
  console.log(`  ✅ 迁移 ${eventsMigrated} 条事件\n`);

  db.close();
}

main().catch(err => {
  console.error('迁移失败:', err);
  process.exit(1);
});
