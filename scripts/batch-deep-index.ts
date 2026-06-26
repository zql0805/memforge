#!/usr/bin/env npx tsx
/**
 * 基于拓扑注册表批量深度索引仓库代码到 knowledge_items。
 * 三步流水线：tree-sitter AST → LLM 语义分析 → knowledge_items 写入。
 *
 * 用法:
 *   npx tsx scripts/batch-deep-index.ts [--product-line your-product] [--layer 4-6] [--dry-run] [--budget 200]
 *
 * 参数:
 *   --product-line <name>  指定产品线（读取 ~/.cursor/<name>-registry.json）
 *   --layer <range>        仅索引指定层级范围（如 4-6）
 *   --repo <id>            仅索引指定 repoId
 *   --dry-run              仅列出将索引的仓库，不实际执行
 *   --budget <n>           LLM 调用总预算（默认 200）
 *   --no-llm               跳过 LLM 分析，仅生成结构化摘要
 *   --clean                写入前清理旧 deep_index 条目
 *   --enable-l2            启用 L2 类级索引生成
 *   --enable-business      启用 Business 业务知识提取
 *   --visibility <level>   知识条目可见性（默认 product_line）
 *   --force                强制全量重建（忽略增量哈希）
 *
 * 环境变量:
 *   LLM_BASE_URL / OPENAI_BASE_URL   LLM Chat API 地址
 *   LLM_API_KEY / OPENAI_API_KEY     LLM API Key
 *   LLM_MODEL                        LLM 模型名（默认从 config 读取）
 *   KNOWLEDGE_SERVICE_URL             知识服务地址（默认 http://127.0.0.1:3003）
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
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

type DeepLang = 'java' | 'php' | 'typescript' | 'kotlin';

const LANG_EXTS: Record<DeepLang, string[]> = {
  java: ['.java'],
  php: ['.php'],
  typescript: ['.ts', '.tsx', '.js', '.jsx', '.vue'],
  kotlin: ['.kt', '.kts'],
};

const DEFAULT_BRANCHES = new Set(['master', 'main', 'develop']);

function getCurrentBranch(repoPath: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath, encoding: 'utf-8', timeout: 5000,
    }).trim();
  } catch { return null; }
}

/** 检测远端 HEAD 指向的默认分支名（如 origin/feat-add-tunnel） */
function detectRemoteDefaultBranch(repoPath: string): string | null {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: repoPath, encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
    }).trim();
    return ref.replace('refs/remotes/origin/', '');
  } catch { return null; }
}

function isDefaultBranch(repoPath: string): boolean {
  const branch = getCurrentBranch(repoPath);
  if (!branch) return true;
  if (DEFAULT_BRANCHES.has(branch)) return true;
  const remoteDefault = detectRemoteDefaultBranch(repoPath);
  return remoteDefault !== null && branch === remoteDefault;
}

/** 确保仓库在默认分支上；若不在则尝试自动切换。返回 [是否成功, 切换前分支, 切换后分支] */
function ensureDefaultBranch(repoPath: string): [ok: boolean, from?: string, to?: string] {
  const branch = getCurrentBranch(repoPath);
  if (branch && DEFAULT_BRANCHES.has(branch)) return [true];

  // 尝试远端默认分支（如 feat-add-tunnel）
  const remoteDefault = detectRemoteDefaultBranch(repoPath);
  if (remoteDefault && branch === remoteDefault) return [true];

  // 依次尝试远端默认分支、master、main、develop
  const targets = remoteDefault
    ? [remoteDefault, ...['master', 'main', 'develop'].filter(b => b !== remoteDefault)]
    : ['master', 'main', 'develop'];

  for (const target of targets) {
    try {
      execSync(`git checkout ${target}`, {
        cwd: repoPath, encoding: 'utf-8', timeout: 10000, stdio: 'pipe',
      });
      return [true, branch ?? undefined, target];
    } catch { /* 分支不存在，尝试下一个 */ }
  }
  return [false, branch ?? undefined];
}

/** 检测仓库是否有源代码文件（递归扫描至 maxDepth 层，覆盖 Java 多模块 module/src/main/java/com/company/app/... 结构） */
function hasSourceFiles(repoPath: string, lang: DeepLang): boolean {
  const exts = new Set(LANG_EXTS[lang]);
  const SKIP = new Set(['.git', 'node_modules', 'target', 'build', '.gradle', '.idea', 'vendor', '.svn', 'dist', '.mvn', '.settings']);
  // Java 多模块最浅 .java 文件在 depth 9 (module/src/main/java/com/company/app/package/File.java)
  const MAX_DEPTH = 15;

  function scan(dir: string, depth: number): boolean {
    if (depth > MAX_DEPTH) return false;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && exts.has(extname(e.name))) return true;
        if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) {
          if (scan(join(dir, e.name), depth + 1)) return true;
        }
      }
    } catch { /* skip */ }
    return false;
  }

  return scan(repoPath, 0);
}

function detectLangFromRepo(repoPath: string): string | null {
  // Gradle/Maven 项目：检查 src/ 下有 .kt 还是 .java 来区分 Kotlin 和 Java
  if (existsSync(join(repoPath, 'build.gradle.kts')) || existsSync(join(repoPath, 'build.gradle')) || existsSync(join(repoPath, 'pom.xml'))) {
    if (hasSourceFiles(repoPath, 'kotlin')) return 'Kotlin';
    return 'Java';
  }
  if (existsSync(join(repoPath, 'composer.json'))) return 'PHP';
  if (existsSync(join(repoPath, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf-8'));
      if (pkg.dependencies?.vue || pkg.devDependencies?.vue) return 'Vue';
      return 'Node';
    } catch { return 'Node'; }
  }
  return null;
}

function mapLangToDeep(lang: string | undefined | null): DeepLang | null {
  if (!lang) return null;
  const lower = lang.toLowerCase();
  if (lower === 'java') return 'java';
  if (lower === 'kotlin') return 'kotlin';
  if (lower === 'php') return 'php';
  if (['typescript', 'javascript', 'node', 'vue'].includes(lower)) return 'typescript';
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const productLine = args['product-line'] || 'default';
  const dryRun = args['dry-run'] === 'true';
  const budget = parseInt(args['budget'] || '200', 10);
  const noLlm = args['no-llm'] === 'true';
  const clean = args['clean'] === 'true';
  const forceFullRebuild = args['force'] === 'true';
  const enableL2 = args['enable-l2'] === 'true';
  const enableBusiness = args['enable-business'] === 'true';
  const visibility = args['visibility'] || 'product_line';
  const targetRepo = args['repo'];

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
    process.exit(1);
  }

  const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  const allRepos: Record<string, RegistryRepo> = registry.repos;
  console.log(`📦 产品线: ${productLine}, 总仓库: ${Object.keys(allRepos).length}`);

  const candidates = Object.entries(allRepos).filter(([repoId, repo]) => {
    if (targetRepo && repoId !== targetRepo) return false;
    const layer = repo.layer ?? 0;
    if (layer < layerMin || layer > layerMax) return false;
    if (!repo.localPath || !existsSync(repo.localPath)) return false;
    if (!repo.lang) repo.lang = detectLangFromRepo(repo.localPath) ?? undefined;
    if (!mapLangToDeep(repo.lang)) return false;
    return true;
  });

  candidates.sort(([, a], [, b]) => (b.layer ?? 0) - (a.layer ?? 0));

  console.log(`🎯 符合条件: ${candidates.length} 个仓库\n`);
  console.log('┌──────────────────────────────────────┬──────────┬────────┐');
  console.log('│ Repo ID                              │ Lang     │ Layer  │');
  console.log('├──────────────────────────────────────┼──────────┼────────┤');
  for (const [repoId, repo] of candidates) {
    console.log(
      `│ ${repoId.slice(0, 36).padEnd(36)} │ ${(mapLangToDeep(repo.lang) ?? '-').padEnd(8)} │ ${String(repo.layer ?? '-').padEnd(6)} │`,
    );
  }
  console.log('└──────────────────────────────────────┴──────────┴────────┘');

  if (dryRun || candidates.length === 0) {
    if (dryRun) console.log('\n🏃 --dry-run 模式，不实际索引。');
    process.exit(0);
  }

  // 加载 .env
  for (const envFile of ['.env.local', '.env.production']) {
    const p = join(process.cwd(), envFile);
    if (existsSync(p)) {
      const { config } = await import('dotenv');
      config({ path: p });
    }
  }

  console.log('\n⏳ 初始化 deep-index 引擎...');
  const { analyzeRepo } = await import('../packages/memory-service/src/tools/deep-index/index.js');
  const { DeepIndexAnalyzer } = await import('../packages/memory-service/src/tools/deep-index/llm-analyzer.js');
  const { writeKnowledgeItems } = await import('../packages/memory-service/src/tools/deep-index/knowledge-writer.js');

  const analyzer = noLlm ? new DeepIndexAnalyzer(0) : new DeepIndexAnalyzer(budget);
  console.log(`✅ 引擎已初始化 (LLM: ${noLlm ? '禁用' : `启用, 预算=${budget}`}, 增量: ${forceFullRebuild ? '关闭(force)' : '开启'})\n`);

  // 增量哈希缓存 — 上次索引的文件哈希
  const hashCachePath = join(homedir(), '.cursor', `${productLine}-deep-index-hashes.json`);
  let hashCache: Record<string, Record<string, string>> = {};
  if (!forceFullRebuild && existsSync(hashCachePath)) {
    try {
      hashCache = JSON.parse(readFileSync(hashCachePath, 'utf-8'));
    } catch { hashCache = {}; }
  }

  type ResultItem = {
    repoId: string;
    files: number;
    symbols: number;
    infraRefs: number;
    knowledgeItems: number;
    writeSuccess: number;
    writeFailed: number;
    elapsedMs: number;
    error?: string;
  };
  const results: ResultItem[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const [repoId, repo] = candidates[i];
    const tag = `[${i + 1}/${candidates.length}]`;
    const lang = mapLangToDeep(repo.lang)!;

    try {
      const [branchOk, branchFrom, branchTo] = ensureDefaultBranch(repo.localPath);
      if (!branchOk) {
        const remoteDefault = detectRemoteDefaultBranch(repo.localPath);
        console.log(`${tag} ⏩ ${repoId}: 当前分支 ${branchFrom}，无法切换到默认分支${remoteDefault ? ` (远端默认: ${remoteDefault})` : ''}，跳过`);
        results.push({
          repoId, files: 0, symbols: 0, infraRefs: 0,
          knowledgeItems: 0, writeSuccess: 0, writeFailed: 0,
          elapsedMs: 0,
        });
        continue;
      }
      if (branchTo) {
        console.log(`${tag} 🔀 ${repoId}: 分支 ${branchFrom} → ${branchTo}`);
      }

      // 空仓库快速检测
      if (!hasSourceFiles(repo.localPath, lang)) {
        console.log(`${tag} 📭 ${repoId}: 无源代码文件（空仓库），跳过`);
        results.push({
          repoId, files: 0, symbols: 0, infraRefs: 0,
          knowledgeItems: 0, writeSuccess: 0, writeFailed: 0,
          elapsedMs: 0,
        });
        continue;
      }

      // 内存监控
      if (i > 0 && i % 3 === 0) {
        const mem = process.memoryUsage();
        const rssMB = Math.round(mem.rss / 1024 / 1024);
        const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
        console.log(`  [内存] RSS=${rssMB}MB, heap=${heapMB}MB`);
        if (rssMB > 512) console.warn('  ⚠️ RSS 超过 512MB，WASM 可能需要更频繁回收');
      }

      console.log(`${tag} 分析 ${repoId} (${lang}) ...`);
      const startMs = Date.now();

      // 增量检测：仅处理变化文件
      let changedFiles: string[] | undefined;
      if (!forceFullRebuild) {
        changedFiles = getChangedFiles(repo.localPath, repoId, lang, hashCache);
        if (changedFiles.length === 0) {
          console.log(`${tag} ⏩ ${repoId}: 无文件变化，跳过`);
          results.push({
            repoId, files: 0, symbols: 0, infraRefs: 0,
            knowledgeItems: 0, writeSuccess: 0, writeFailed: 0,
            elapsedMs: 0,
          });
          continue;
        }
        console.log(`${tag} 增量: ${changedFiles.length} 个文件变化`);
      }

      // Step 1: AST + Infra 提取
      const analysis = await analyzeRepo({
        repoPath: repo.localPath,
        repoId,
        lang,
        onlyFiles: changedFiles,
      });
      console.log(`  AST: ${analysis.stats.filesScanned} 文件, ${analysis.stats.totalSymbols} 符号, ${analysis.stats.totalCallEdges} 调用边, ${analysis.stats.totalInfraRefs} 基础设施引用`);

      // Step 2: 分层知识提取
      const knowledgeItems = await analyzer.analyzeAll(analysis, repoId, { enableL2, enableBusiness });
      const overviews = knowledgeItems.filter(i => i.tags.includes('type:overview') || i.tags.includes('type:full'));
      const modules = knowledgeItems.filter(i => i.tags.includes('type:module'));
      const l2Items = knowledgeItems.filter(i => i.tags.includes('type:class'));
      const bizItems = knowledgeItems.filter(i => i.tags.includes('business-feature'));
      console.log(`  知识条目: ${knowledgeItems.length} 条 (${overviews.length} 概览 + ${modules.length} 模块 + ${l2Items.length} L2 + ${bizItems.length} 业务), LLM=${analyzer.usedCalls}/${budget}`);

      // Step 3: 写入 knowledge_items
      const writeResult = await writeKnowledgeItems(knowledgeItems, {
        projectId: repoId,
        productLine,
        visibility,
        cleanBefore: clean,
      });

      const elapsed = Date.now() - startMs;

      // 更新哈希缓存
      if (!forceFullRebuild) {
        updateHashCache(repo.localPath, repoId, lang, hashCache);
      }

      results.push({
        repoId, files: analysis.stats.filesScanned,
        symbols: analysis.stats.totalSymbols, infraRefs: analysis.stats.totalInfraRefs,
        knowledgeItems: knowledgeItems.length,
        writeSuccess: writeResult.success, writeFailed: writeResult.failed,
        elapsedMs: elapsed,
      });
      console.log(`${tag} ✅ ${repoId}: ${writeResult.success}条写入成功, ${writeResult.failed}条失败, 耗时 ${elapsed}ms`);
    } catch (err) {
      const msg = (err as Error).message;
      results.push({
        repoId, files: 0, symbols: 0, infraRefs: 0,
        knowledgeItems: 0, writeSuccess: 0, writeFailed: 0,
        elapsedMs: 0, error: msg,
      });
      console.error(`${tag} ❌ ${repoId}: ${msg}`);
    }
  }

  // 持久化哈希缓存
  if (!forceFullRebuild) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(hashCachePath, JSON.stringify(hashCache, null, 2));
    console.log(`\n💾 增量哈希缓存已保存: ${hashCachePath}`);
  }

  // 汇总
  const totalItems = results.reduce((s, r) => s + r.knowledgeItems, 0);
  const totalWritten = results.reduce((s, r) => s + r.writeSuccess, 0);
  const errors = results.filter(r => r.error);

  console.log('\n════════════════════════════════════════');
  console.log('  深度代码索引完成');
  console.log('════════════════════════════════════════');
  console.log(`  仓库: ${candidates.length} | 成功: ${candidates.length - errors.length} | 失败: ${errors.length}`);
  console.log(`  知识条目: ${totalItems} 条 | 写入成功: ${totalWritten} 条`);
  console.log(`  LLM 调用: ${analyzer.usedCalls}/${budget}`);
  if (errors.length > 0) {
    console.log('\n  失败列表:');
    for (const e of errors) console.log(`    - ${e.repoId}: ${e.error}`);
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

// ─── 增量同步辅助函数 ─────────────────────────────────────────

function hashFile(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/** 获取变化文件列表（相对路径） */
function getChangedFiles(
  repoPath: string,
  repoId: string,
  lang: DeepLang,
  cache: Record<string, Record<string, string>>,
): string[] {
  const oldHashes = cache[repoId] ?? {};
  const exts = new Set(LANG_EXTS[lang]);
  const changed: string[] = [];

  // 优先用 git diff 缩小范围
  let gitChanged: Set<string> | null = null;
  try {
    const output = execSync('git diff --name-only HEAD~10 HEAD 2>/dev/null || git diff --name-only HEAD 2>/dev/null', {
      cwd: repoPath, encoding: 'utf-8', timeout: 5000,
    });
    gitChanged = new Set(output.trim().split('\n').filter(Boolean));
  } catch { /* git 不可用，回退到全量哈希对比 */ }

  // 收集当前所有源文件
  const currentFiles = collectFilesForHash(repoPath, exts, repoPath);

  for (const relPath of currentFiles) {
    // 如果 git 可用且文件不在 diff 中，直接跳过
    if (gitChanged && !gitChanged.has(relPath) && oldHashes[relPath]) continue;

    const absPath = join(repoPath, relPath);
    try {
      const hash = hashFile(absPath);
      if (oldHashes[relPath] !== hash) {
        changed.push(relPath);
      }
    } catch { /* 文件读取失败，跳过 */ }
  }

  return changed;
}

/** 更新哈希缓存 */
function updateHashCache(
  repoPath: string,
  repoId: string,
  lang: DeepLang,
  cache: Record<string, Record<string, string>>,
): void {
  const exts = new Set(LANG_EXTS[lang]);
  const hashes: Record<string, string> = {};
  const files = collectFilesForHash(repoPath, exts, repoPath);

  for (const relPath of files) {
    try {
      hashes[relPath] = hashFile(join(repoPath, relPath));
    } catch { /* skip */ }
  }

  cache[repoId] = hashes;
}

const SKIP_DIRS_HASH = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', 'target', '.gradle',
  'test', 'tests', '__tests__', '.idea', '.vscode', 'coverage',
]);

function collectFilesForHash(dir: string, exts: Set<string>, rootDir: string): string[] {
  const results: string[] = [];
  function walk(d: string): void {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS_HASH.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(join(d, entry.name));
      } else if (entry.isFile() && exts.has(extname(entry.name))) {
        const abs = join(d, entry.name);
        try {
          if (statSync(abs).size <= 200 * 1024) {
            results.push(abs.slice(rootDir.length + 1));
          }
        } catch { /* skip */ }
      }
    }
  }
  walk(dir);
  return results;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});
