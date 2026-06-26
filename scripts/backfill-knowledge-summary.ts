#!/usr/bin/env npx tsx
/**
 * 为已有的 deep_index 知识条目补全 summary 字段。
 * summary 用于 BM25/ILIKE 精确匹配和 embedding 向量化，是搜索命中率的关键。
 *
 * 流程:
 *   1. 查询 summary IS NULL 的 deep_index 条目
 *   2. 从 content 中提取 summary（最多 500 字符）
 *   3. PUT /api/knowledge/:id 更新 summary（fts_vector 自动刷新）
 *   4. 清空 embedding 让 EmbedQueue 用含 summary 的文本重新向量化
 *
 * 用法:
 *   npx tsx scripts/backfill-knowledge-summary.ts [--dry-run] [--limit 100] [--batch-size 10]
 */

import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

function loadEnv(): void {
  for (const name of ['.env.production', '.env.local', '.env']) {
    const envPath = resolve(process.cwd(), name);
    if (!existsSync(envPath)) continue;
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
    break;
  }
}
loadEnv();

const KNOWLEDGE_SERVICE_URL = process.env.KNOWLEDGE_SERVICE_URL || 'http://127.0.0.1:3003';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://memforge:memforge@127.0.0.1:5432/memforge';

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].replace(/^--/, '');
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = 'true';
      }
    }
  }
  return result;
}

function extractSummaryFromContent(title: string, content: string): string {
  const MAX = 500;
  const parts: string[] = [];

  // 1. 从 title 提取关键信息
  const titleClean = title.replace(/^\[.*?\]\s*/, '').trim();
  if (titleClean) parts.push(titleClean);

  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

  // 2. 匹配 Markdown blockquote (通常是项目/模块描述)
  for (const line of lines) {
    if (line.startsWith('> ') && line.length > 5) {
      parts.push(line.slice(2).trim());
      break;
    }
  }

  // 3. 匹配 "说明:" 行（类级别文档的关键描述）
  for (const line of lines) {
    if (line.startsWith('说明:') || line.startsWith('说明：')) {
      parts.push(line.slice(3).trim());
    }
  }

  // 4. 匹配统计行
  for (const line of lines) {
    if (/^\d+\s*文件/.test(line) || /统计:\s*\d+/.test(line)) {
      parts.push(line);
      break;
    }
  }

  // 5. 提取核心类名列表（从 "## 核心类/接口" 段落）
  const coreIdx = lines.findIndex(l => l.includes('核心类') || l.includes('核心接口'));
  if (coreIdx >= 0) {
    const classNames: string[] = [];
    for (let i = coreIdx + 1; i < Math.min(coreIdx + 20, lines.length); i++) {
      const match = lines[i].match(/^###\s+(\S+)\s+\(/);
      if (match) classNames.push(match[1]);
      if (classNames.length >= 5) break;
    }
    if (classNames.length > 0) parts.push(`核心类: ${classNames.join(', ')}`);
  }

  // 6. 提取基础设施
  const infraIdx = lines.findIndex(l => l.includes('## 基础设施'));
  if (infraIdx >= 0) {
    const infraParts: string[] = [];
    for (let i = infraIdx + 1; i < Math.min(infraIdx + 10, lines.length); i++) {
      if (lines[i].startsWith('## ')) break;
      if (lines[i].startsWith('- **')) {
        infraParts.push(lines[i].replace(/^-\s*\*\*/, '').replace(/\*\*:\s*/, ': '));
      }
    }
    if (infraParts.length > 0) parts.push(infraParts.join('; '));
  }

  if (parts.length === 0) {
    return content.replace(/[#*\n]+/g, ' ').trim().slice(0, MAX);
  }

  return parts.join('。').slice(0, MAX);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === 'true';
  const limit = parseInt(args['limit'] || '1000', 10);
  const batchSize = parseInt(args['batch-size'] || '10', 10);

  console.log(`[backfill-summary] 开始, dryRun=${dryRun}, limit=${limit}`);

  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    const { rows: items } = await pool.query<{ id: string; title: string; content: string }>(
      `SELECT id, title, content FROM memory.knowledge_items
       WHERE summary IS NULL AND source_ref LIKE 'deep_index:%'
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );

    console.log(`[backfill-summary] 待补全 ${items.length} 条`);
    if (items.length === 0) {
      console.log('[backfill-summary] 无需补全，退出');
      return;
    }

    let success = 0;
    let failed = 0;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      await Promise.all(batch.map(async (item) => {
        const summary = extractSummaryFromContent(item.title, item.content);

        if (dryRun) {
          console.log(`  [dry-run] ${item.title} → summary(${summary.length}字): ${summary.slice(0, 80)}...`);
          success++;
          return;
        }

        try {
          const resp = await fetch(`${KNOWLEDGE_SERVICE_URL}/api/knowledge/${item.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ summary }),
            signal: AbortSignal.timeout(10_000),
          });

          if (!resp.ok) {
            console.error(`  [失败] ${item.title}: HTTP ${resp.status}`);
            failed++;
            return;
          }

          // 清空 embedding 触发 EmbedQueue 重新向量化
          await pool.query(
            `UPDATE memory.knowledge_items SET embedding = NULL WHERE id = $1`,
            [item.id],
          );

          success++;
        } catch (err) {
          console.error(`  [异常] ${item.title}: ${(err as Error).message}`);
          failed++;
        }
      }));

      if (!dryRun) {
        console.log(`  进度: ${Math.min(i + batchSize, items.length)}/${items.length} (成功=${success}, 失败=${failed})`);
      }
    }

    console.log(`[backfill-summary] 完成: 总计=${items.length}, 成功=${success}, 失败=${failed}`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('[backfill-summary] 致命错误:', err);
  process.exit(1);
});
