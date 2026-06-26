#!/usr/bin/env npx tsx
/**
 * Phase 5.1: 基于拓扑注册表批量索引所有仓库的 API 文档到知识库。
 * 必须从项目根目录运行：npx tsx scripts/batch-index-api.ts [options]
 *
 * 用法:
 *   npx tsx scripts/batch-index-api.ts [--product-line your-product] [--layer 4-6] [--dry-run] [--concurrency 2]
 *
 * 参数:
 *   --product-line <name>  指定产品线（读取 ~/.cursor/<name>-registry.json）
 *   --layer <range>        仅索引指定层级范围（如 4-6 表示 layer 4~6，6 表示仅 layer 6）
 *   --group <name>         仅索引指定 group（如 microservice, framework）
 *   --repo <id>            仅索引指定 repoId（如 group/common）
 *   --dry-run              仅列出将索引的仓库，不实际执行
 *   --concurrency <n>      并发数（默认 1，避免 embedding API 压力过大）
 *
 * 环境变量:
 *   DATABASE_URL           PostgreSQL 连接串（必须）
 *   OPENAI_BASE_URL        Embedding API 地址
 *   OPENAI_API_KEY         Embedding API Key
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

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

function detectLangFromRepo(repoPath: string): string | null {
  if (existsSync(join(repoPath, 'pom.xml')) || existsSync(join(repoPath, 'build.gradle'))) return 'Java';
  if (existsSync(join(repoPath, 'composer.json'))) return 'PHP';
  if (existsSync(join(repoPath, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf-8'));
      if (pkg.dependencies?.vue || pkg.devDependencies?.vue) return 'Vue';
      return 'Node';
    } catch { return 'Node'; }
  }
  if (existsSync(join(repoPath, 'go.mod'))) return 'Go';
  if (existsSync(join(repoPath, 'Cargo.toml'))) return 'Rust';
  if (existsSync(join(repoPath, 'pubspec.yaml'))) return 'Flutter';
  return null;
}

const DEFAULT_BRANCHES = new Set(['master', 'main', 'develop']);

function getCurrentBranch(repoPath: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath, encoding: 'utf-8', timeout: 5000,
    }).trim();
  } catch { return null; }
}

function isDefaultBranch(repoPath: string): boolean {
  const branch = getCurrentBranch(repoPath);
  if (!branch) return true;
  return DEFAULT_BRANCHES.has(branch);
}

/** 确保仓库在默认分支上；若不在则尝试自动切换 */
function ensureDefaultBranch(repoPath: string): [ok: boolean, from?: string, to?: string] {
  const branch = getCurrentBranch(repoPath);
  if (branch && DEFAULT_BRANCHES.has(branch)) return [true];
  for (const target of ['master', 'main', 'develop']) {
    try {
      execSync(`git checkout ${target}`, {
        cwd: repoPath, encoding: 'utf-8', timeout: 10000, stdio: 'pipe',
      });
      return [true, branch ?? undefined, target];
    } catch { /* 分支不存在，尝试下一个 */ }
  }
  return [false, branch ?? undefined];
}

function mapLangToStack(lang: string | undefined | null): 'java' | 'php' | 'typescript' | 'unknown' {
  if (!lang) return 'unknown';
  const lower = lang.toLowerCase();
  if (lower === 'java' || lower === 'kotlin') return 'java';
  if (lower === 'php') return 'php';
  if (['typescript', 'javascript', 'node', 'vue'].includes(lower)) return 'typescript';
  return 'unknown';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const productLine = args['product-line'] || 'default';
  const dryRun = args['dry-run'] === 'true';
  const concurrency = parseInt(args['concurrency'] || '1', 10);
  const targetRepo = args['repo'];
  const targetGroup = args['group'];

  let layerMin = 0;
  let layerMax = 999;
  if (args['layer']) {
    const parts = args['layer'].split('-').map(Number);
    layerMin = parts[0] ?? 0;
    layerMax = parts[1] ?? parts[0];
  }

  const registryPath = join(homedir(), '.cursor', `${productLine}-registry.json`);
  if (!existsSync(registryPath)) {
    console.error(`❌ 注册表不存在: ${registryPath}`);
    console.error(`   请先运行 scan_topology({ product_line: "${productLine}" }) 生成注册表`);
    process.exit(1);
  }

  const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  const allRepos: Record<string, RegistryRepo> = registry.repos;
  console.log(`📦 产品线: ${productLine}, 总仓库: ${Object.keys(allRepos).length}`);

  const candidates = Object.entries(allRepos).filter(([repoId, repo]) => {
    if (targetRepo && repoId !== targetRepo) return false;
    if (targetGroup && repo.group && repo.group !== targetGroup) return false;
    const layer = repo.layer ?? 0;
    if (layer < layerMin || layer > layerMax) return false;
    if (!repo.localPath || !existsSync(repo.localPath)) return false;
    if (!repo.lang) repo.lang = detectLangFromRepo(repo.localPath) ?? undefined;
    if (mapLangToStack(repo.lang) === 'unknown') return false;
    return true;
  });

  candidates.sort(([, a], [, b]) => (b.layer ?? 0) - (a.layer ?? 0));

  console.log(`🎯 符合条件: ${candidates.length} 个仓库\n`);
  console.log('┌──────────────────────────────────────┬──────────┬────────┬───────────────┐');
  console.log('│ Repo ID                              │ Stack    │ Layer  │ Group         │');
  console.log('├──────────────────────────────────────┼──────────┼────────┼───────────────┤');
  for (const [repoId, repo] of candidates) {
    console.log(
      `│ ${repoId.slice(0, 36).padEnd(36)} │ ${mapLangToStack(repo.lang).padEnd(8)} │ ${String(repo.layer ?? '-').padEnd(6)} │ ${(repo.group ?? '-').slice(0, 13).padEnd(13)} │`,
    );
  }
  console.log('└──────────────────────────────────────┴──────────┴────────┴───────────────┘');

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
  const { indexApiDocsForRepo } = await import('../packages/memory-service/src/tools/index-api-docs.js');

  const config = loadConfig();
  const embedding = new ApiEmbeddingService({
    baseUrl: config.openaiBaseUrl,
    apiKey: config.openaiApiKey,
    model: config.openaiEmbeddingModel,
    dimensions: config.embeddingDimensions,
  });
  const storage = new PostgresStorage();
  const scanner = new SensitiveDataScanner();
  const ctx = { storage, embedding, scanner, config, gitContext: null, userId: null, orgId: null, teamId: null, userRole: null, deviceId: null, isSuperAdmin: false } as Parameters<typeof indexApiDocsForRepo>[0];

  console.log('✅ 运行时已初始化\n');

  // 批量索引
  type ResultItem = { repoId: string; stored: number; duplicates: number; files: number; error?: string };
  const results: ResultItem[] = [];
  let processed = 0;
  let active = 0;

  async function indexOne(repoId: string, repo: RegistryRepo): Promise<void> {
    while (active >= concurrency) await new Promise(r => setTimeout(r, 200));
    active++;
    processed++;
    const tag = `[${processed}/${candidates.length}]`;

    try {
      const [branchOk, branchFrom, branchTo] = ensureDefaultBranch(repo.localPath);
      if (!branchOk) {
        console.log(`${tag} ⏩ ${repoId}: 当前分支 ${branchFrom}，无法切换到 master/main/develop，跳过`);
        results.push({ repoId, stored: 0, duplicates: 0, files: 0 });
        active--;
        return;
      }
      if (branchTo) {
        console.log(`${tag} 🔀 ${repoId}: 分支 ${branchFrom} → ${branchTo}`);
      }
      console.log(`${tag} 索引 ${repoId} (${mapLangToStack(repo.lang)}) ...`);
      const r = await indexApiDocsForRepo(ctx, {
        repoPath: repo.localPath,
        repoId,
        techStack: mapLangToStack(repo.lang),
        productLine,
        framework: repoId.split('/').pop(),
      });
      results.push({ repoId, stored: r.stored, duplicates: r.duplicates, files: r.filesScanned });
      console.log(`${tag} ✅ ${repoId}: stored=${r.stored} dup=${r.duplicates} files=${r.filesScanned}`);
    } catch (err) {
      const msg = (err as Error).message;
      results.push({ repoId, stored: 0, duplicates: 0, files: 0, error: msg });
      console.error(`${tag} ❌ ${repoId}: ${msg}`);
    } finally {
      active--;
    }
  }

  await Promise.all(candidates.map(([id, repo]) => indexOne(id, repo)));

  // 汇总
  const totalStored = results.reduce((s, r) => s + r.stored, 0);
  const totalDups = results.reduce((s, r) => s + r.duplicates, 0);
  const errors = results.filter(r => r.error);

  console.log('\n════════════════════════════════════════');
  console.log('  批量 API 索引完成');
  console.log('════════════════════════════════════════');
  console.log(`  仓库: ${candidates.length} | 成功: ${candidates.length - errors.length} | 失败: ${errors.length}`);
  console.log(`  存储: ${totalStored} 条 | 重复跳过: ${totalDups} 条`);
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
