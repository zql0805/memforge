#!/usr/bin/env npx tsx
/**
 * 基于拓扑注册表批量索引所有仓库的 README/docs 到知识库。
 *
 * 用法:
 *   npx tsx scripts/batch-index-docs.ts [options]
 *
 * 参数:
 *   --product-line <name>  指定产品线（读取 ~/.cursor/<name>-registry.json）
 *   --repo <id>            仅索引指定 repoId
 *   --dry-run              仅列出将索引的仓库，不实际执行
 *   --concurrency <n>      并发数（默认 1）
 */

import { readFileSync, existsSync, readdirSync, statSync, readFileSync as readF } from 'node:fs';
import { join, resolve, extname, relative, basename } from 'node:path';
import { homedir } from 'node:os';

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

interface RegistryRepo {
  desc?: string;
  lang?: string;
  layer?: number;
  group?: string;
  localPath: string;
  remote?: string;
}

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);

function countDocFiles(dir: string): number {
  let count = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'vendor') {
        count += countDocFiles(join(dir, entry.name));
      } else if (entry.isFile() && DOC_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        count++;
      }
    }
  } catch { /* 权限问题跳过 */ }
  return count;
}

function findDocTargets(repoPath: string): string[] {
  const targets: string[] = [];
  const docsDir = join(repoPath, 'docs');
  if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
    targets.push(docsDir);
  }
  const readme = join(repoPath, 'README.md');
  if (existsSync(readme)) {
    targets.push(repoPath);
  }
  return targets;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const productLine = args['product-line'] || 'default';
  const dryRun = args['dry-run'] === 'true';
  const concurrency = parseInt(args['concurrency'] || '1', 10);
  const targetRepo = args['repo'];

  const registryPath = join(homedir(), '.cursor', `${productLine}-registry.json`);
  if (!existsSync(registryPath)) {
    console.error(`❌ 注册表不存在: ${registryPath}`);
    process.exit(1);
  }

  const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  const allRepos: Record<string, RegistryRepo> = registry.repos;
  console.log(`📦 产品线: ${productLine}, 总仓库: ${Object.keys(allRepos).length}`);

  const candidates = Object.entries(allRepos).filter(([repoId, repo]) => {
    if (targetRepo && repoId !== targetRepo) return false;
    if (!repo.localPath || !existsSync(repo.localPath)) return false;
    const targets = findDocTargets(repo.localPath);
    return targets.length > 0;
  });

  console.log(`🎯 含文档仓库: ${candidates.length} 个\n`);
  console.log('┌──────────────────────────────────────┬────────┬───────────┐');
  console.log('│ Repo ID                              │ Layer  │ Doc Files │');
  console.log('├──────────────────────────────────────┼────────┼───────────┤');
  for (const [repoId, repo] of candidates) {
    const docCount = countDocFiles(repo.localPath);
    console.log(
      `│ ${repoId.slice(0, 36).padEnd(36)} │ ${String(repo.layer ?? '-').padEnd(6)} │ ${String(docCount).padEnd(9)} │`,
    );
  }
  console.log('└──────────────────────────────────────┴────────┴───────────┘');

  if (dryRun || candidates.length === 0) {
    if (dryRun) console.log('\n🏃 --dry-run 模式，不实际索引。');
    process.exit(0);
  }

  const dotenvPath = join(process.cwd(), '.env.local');
  if (existsSync(dotenvPath)) {
    const { config } = await import('dotenv');
    config({ path: dotenvPath });
  }
  const dotenvProd = join(process.cwd(), '.env.production');
  if (existsSync(dotenvProd)) {
    const { config } = await import('dotenv');
    config({ path: dotenvProd });
  }

  if (!process.env.DATABASE_URL) {
    console.error('❌ 缺少 DATABASE_URL 环境变量');
    process.exit(1);
  }

  console.log('\n⏳ 初始化 Memforge 运行时...');
  const { initPool, loadDbConfig, getPool, loadConfig, ApiEmbeddingService } = await import('@memforgeai/shared');
  initPool(loadDbConfig());

  const { PostgresStorage } = await import('../packages/memory-service/src/storage/postgres.js');
  const { SensitiveDataScanner } = await import('../packages/memory-service/src/services/scanner.js');
  const { storeWithRouting } = await import('../packages/memory-service/src/storage/storage-router.js');

  const config = loadConfig();
  const embeddingSvc = new ApiEmbeddingService({
    baseUrl: config.openaiBaseUrl,
    apiKey: config.openaiApiKey,
    model: config.openaiEmbeddingModel,
    dimensions: config.embeddingDimensions,
  });
  const storage = new PostgresStorage();
  const scanner = new SensitiveDataScanner();
  const ctx = { storage, embedding: embeddingSvc, scanner, config, gitContext: null, userId: null, orgId: null, teamId: null, userRole: null, deviceId: null, isSuperAdmin: false } as any;
  console.log('✅ 运行时已初始化\n');

  const SUPPORTED_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);
  const MAX_CHUNK = 2000;
  const MIN_CHUNK = 50;

  function splitIntoChunks(content: string, maxLen: number): string[] {
    const sections = content.split(/^(#{1,3}\s.+)$/m);
    const chunks: string[] = [];
    let current = '';
    for (const section of sections) {
      if ((current + section).length > maxLen && current.length >= MIN_CHUNK) {
        chunks.push(current.trim());
        current = section;
      } else {
        current += section;
      }
    }
    if (current.trim().length >= MIN_CHUNK) chunks.push(current.trim());
    return chunks;
  }

  async function scanDir(dir: string): Promise<Array<{ path: string; content: string }>> {
    const results: Array<{ path: string; content: string }> = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'vendor') {
          results.push(...(await scanDir(full)));
        } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          const text = readF(full, 'utf-8');
          if (text.trim().length >= MIN_CHUNK) results.push({ path: full, content: text });
        }
      }
    } catch { /* 权限问题跳过 */ }
    return results;
  }

  type ResultItem = { repoId: string; stored: number; files: number; error?: string };
  const results: ResultItem[] = [];
  let processed = 0;
  let active = 0;

  async function indexOne(repoId: string, repo: RegistryRepo): Promise<void> {
    while (active >= concurrency) await new Promise(r => setTimeout(r, 200));
    active++;
    processed++;
    const tag = `[${processed}/${candidates.length}]`;

    try {
      console.log(`${tag} 索引文档 ${repoId} ...`);
      const docs = await scanDir(repo.localPath);
      let stored = 0;

      for (const doc of docs) {
        const relPath = relative(repo.localPath, doc.path);
        const chunks = splitIntoChunks(doc.content, MAX_CHUNK);

        for (let i = 0; i < chunks.length; i++) {
          const title = chunks.length > 1
            ? `[${repoId}] ${basename(relPath)} (${i + 1}/${chunks.length})`
            : `[${repoId}] ${basename(relPath)}`;

          const hasSensitive = scanner.scan(chunks[i]).hasSensitive;
          if (hasSensitive) continue;

          const vec = await embeddingSvc.embed(chunks[i]);
          await storeWithRouting({
            ctx,
            scope: 'domain_knowledge',
            projectId: productLine,
            productLine,
            branchId: null,
            title,
            content: chunks[i],
            source: 'batch_index',
            tags: [`repo:${repoId}`, `doc:${relPath}`, `pl:${productLine}`],
            embedding: vec,
            metadata: {},
            visibility: 'product_line',
          });
          stored++;
        }
      }

      results.push({ repoId, stored, files: docs.length });
      console.log(`${tag} ✅ ${repoId}: stored=${stored} files=${docs.length}`);
    } catch (err) {
      const msg = (err as Error).message;
      results.push({ repoId, stored: 0, files: 0, error: msg });
      console.error(`${tag} ❌ ${repoId}: ${msg}`);
    } finally {
      active--;
    }
  }

  await Promise.all(candidates.map(([id, repo]) => indexOne(id, repo)));

  const totalStored = results.reduce((s, r) => s + r.stored, 0);
  const errors = results.filter(r => r.error);

  console.log('\n════════════════════════════════════════');
  console.log('  批量文档索引完成');
  console.log('════════════════════════════════════════');
  console.log(`  仓库: ${candidates.length} | 成功: ${candidates.length - errors.length} | 失败: ${errors.length}`);
  console.log(`  存储: ${totalStored} 条`);
  if (errors.length > 0) {
    console.log('\n  失败列表:');
    for (const e of errors) console.log(`    - ${e.repoId}: ${e.error}`);
  }

  await getPool().end();
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});
