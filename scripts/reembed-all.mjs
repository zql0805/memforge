#!/usr/bin/env node
// Created by dev on 2026/04/05
// Copyright © 2026
// 重新向量化所有记忆和规则（模型升级后使用）
// 直接使用 ONNX EmbeddingService 而非 MCP 接口

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const MODEL_TIER = process.env.EMBEDDING_MODEL_TIER ?? 'L3';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://memforge:memforge_dev@localhost:5432/memforge';
const BATCH_SIZE = 10;

// L3 = bge-m3, 1024 维, maxSeq 8192（实际截断到 512）
const MODEL_SPECS = {
  L1: { dir: 'paraphrase-multilingual-MiniLM-L12-v2', dimensions: 384, maxSeqLength: 128, queryPrefix: '', passagePrefix: '' },
  L2: { dir: 'multilingual-e5-base', dimensions: 768, maxSeqLength: 512, queryPrefix: 'query: ', passagePrefix: 'passage: ' },
  L3: { dir: 'bge-m3', dimensions: 1024, maxSeqLength: 8192, queryPrefix: '', passagePrefix: '' },
};

async function main() {
  const spec = MODEL_SPECS[MODEL_TIER];
  if (!spec) throw new Error(`未知模型层级: ${MODEL_TIER}`);

  const modelDir = resolve(rootDir, 'models', spec.dir);
  console.log(`\n🔄 重新向量化（模型: ${MODEL_TIER} / ${spec.dir}）`);
  console.log(`  维度: ${spec.dimensions}, 最大序列: ${spec.maxSeqLength}`);
  console.log(`  模型: ${modelDir}`);
  console.log(`  数据库: ${DATABASE_URL.replace(/\/\/.*:.*@/, '//<hidden>@')}\n`);

  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  // 查询需要重新向量化的记录
  const { rows: entries } = await pool.query(
    `SELECT id, title, content, is_archived FROM memory.entries WHERE embedding IS NULL`
  );
  const { rows: rules } = await pool.query(
    `SELECT id, title, description FROM memory.coding_rules WHERE embedding IS NULL`
  );
  const { rows: skills } = await pool.query(
    `SELECT id, name, description FROM memory.skill_definitions WHERE embedding IS NULL`
  );

  const total = entries.length + rules.length + skills.length;
  console.log(`需要重新向量化:`);
  console.log(`  记忆: ${entries.length}`);
  console.log(`  规则: ${rules.length}`);
  console.log(`  技能: ${skills.length}`);
  console.log(`  总计: ${total}\n`);

  if (total === 0) {
    console.log('✅ 所有记录已有向量，无需操作。');
    await pool.end();
    return;
  }

  // 动态加载编译后的 EmbeddingService
  const embeddingMod = await import(
    resolve(rootDir, 'packages/memory-service/dist/services/embedding.js')
  );
  const { EmbeddingService } = embeddingMod;

  console.log('正在初始化 ONNX Embedding 模型...');
  const embedding = new EmbeddingService({
    modelDir,
    dimensions: spec.dimensions,
    maxSeqLength: spec.maxSeqLength,
    queryPrefix: spec.queryPrefix,
    passagePrefix: spec.passagePrefix,
  });
  await embedding.initialize();
  console.log(`✅ 模型已加载\n`);

  let processed = 0;
  const startTime = Date.now();

  // 辅助函数：向量化并写入
  async function embedAndUpdate(table, id, title, content) {
    const text = `${title} ${content}`.slice(0, 2000);
    const vec = await embedding.embedPassage(text);
    const vecStr = `[${vec.join(',')}]`;
    await pool.query(
      `UPDATE memory.${table} SET embedding = $1 WHERE id = $2`,
      [vecStr, id],
    );
    processed++;
  }

  function logProgress() {
    const pct = ((processed / total) * 100).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = processed > 0 ? (processed / ((Date.now() - startTime) / 1000)).toFixed(1) : '0';
    console.log(`  [${pct}%] ${processed}/${total} (${elapsed}s, ${rate}/s)`);
  }

  // 重新向量化记忆
  if (entries.length > 0) {
    console.log('📝 重新向量化记忆...');
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      for (const e of batch) {
        await embedAndUpdate('entries', e.id, e.title, e.content);
      }
      logProgress();
    }
  }

  // 重新向量化规则
  if (rules.length > 0) {
    console.log('📏 重新向量化规则...');
    for (const r of rules) {
      await embedAndUpdate('coding_rules', r.id, r.title, r.description);
    }
    logProgress();
  }

  // 重新向量化技能
  if (skills.length > 0) {
    console.log('🧠 重新向量化技能...');
    for (const s of skills) {
      await embedAndUpdate('skill_definitions', s.id, s.name, s.description || '');
    }
    logProgress();
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ 重新向量化完成！${processed}/${total} 条记录，耗时 ${elapsed}s`);

  // 验证
  const { rows: check1 } = await pool.query(
    `SELECT count(*) as total, count(embedding) as embedded FROM memory.entries`
  );
  const { rows: check2 } = await pool.query(
    `SELECT count(*) as total, count(embedding) as embedded FROM memory.coding_rules`
  );
  const { rows: check3 } = await pool.query(
    `SELECT count(*) as total, count(embedding) as embedded FROM memory.skill_definitions`
  );
  console.log(`\n验证:`);
  console.log(`  记忆: ${check1[0].embedded}/${check1[0].total}`);
  console.log(`  规则: ${check2[0].embedded}/${check2[0].total}`);
  console.log(`  技能: ${check3[0].embedded}/${check3[0].total}`);

  const cacheStats = embedding.getCacheStats();
  console.log(`\n缓存统计: hits=${cacheStats.hits}, misses=${cacheStats.misses}`);

  await pool.end();
}

main().catch(err => {
  console.error('❌ 重新向量化失败:', err);
  process.exit(1);
});
