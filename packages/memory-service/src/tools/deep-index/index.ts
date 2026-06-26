// Created by dev on 2026/06/02
// deep-index 模块入口 — 组合 AST + Infra 提取器，提供仓库级分析 API

import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative, extname, join, basename, sep } from 'node:path';
import { getLogger } from '@memforgeai/shared';
import { extractSymbolsFromFile } from './ast-extractor.js';
import { extractInfraRefs, extractFromMapperXml, extractSpringRoutesFromAST, extractLaravelRoutesEnhanced } from './infra-extractor.js';
import type {
  SupportedLang, FileAnalysis, ModuleInfo, RepoAnalysis, InfraRef,
} from './types.js';

export type { SupportedLang, FileAnalysis, ModuleInfo, RepoAnalysis, SymbolInfo, InfraRef, CallEdge, ParamInfo } from './types.js';
export { DeepIndexAnalyzer } from './llm-analyzer.js';
export type { KnowledgeItem, KnowledgeLevel } from './llm-analyzer.js';
export { writeKnowledgeItems } from './knowledge-writer.js';
export type { WriteOptions, WriteResult } from './knowledge-writer.js';

const logger = getLogger('deep-index');

const MAX_FILE_SIZE = 200 * 1024; // 200KB
const MAX_FILES = 500;

const LANG_EXTENSIONS: Record<SupportedLang, Set<string>> = {
  java: new Set(['.java']),
  php: new Set(['.php']),
  typescript: new Set(['.ts', '.tsx', '.js', '.jsx', '.vue']),
  kotlin: new Set(['.kt', '.kts']),
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', 'target', '.gradle',
  '__pycache__', '.idea', '.vscode', 'test', 'tests', '__tests__',
  '.next', '.nuxt', 'coverage',
]);

export interface AnalyzeRepoOptions {
  repoPath: string;
  repoId: string;
  lang: SupportedLang;
  /** 仅分析指定文件（增量模式） */
  onlyFiles?: string[];
  /** 跳过 test 目录 */
  skipTests?: boolean;
  /** 单文件最大字节数 */
  maxFileSize?: number;
}

/**
 * 分析整个仓库：tree-sitter AST 提取 + 基础设施依赖提取。
 * 返回完整的结构化分析结果，供后续 LLM 分析和知识存储使用。
 */
export async function analyzeRepo(opts: AnalyzeRepoOptions): Promise<RepoAnalysis> {
  const startTime = Date.now();
  const { repoPath, repoId, lang, onlyFiles, skipTests = true, maxFileSize = MAX_FILE_SIZE } = opts;

  const result: RepoAnalysis = {
    repoId,
    lang,
    repoPath,
    files: [],
    modules: [],
    infraRefs: [],
    callEdges: [],
    stats: { filesScanned: 0, totalSymbols: 0, totalInfraRefs: 0, totalCallEdges: 0, parseErrors: 0, elapsedMs: 0 },
  };

  // 1. 收集源码文件
  const extensions = LANG_EXTENSIONS[lang];
  let sourceFiles: string[];

  if (onlyFiles) {
    sourceFiles = onlyFiles.map(f => resolve(repoPath, f)).filter(f => {
      const ext = extname(f);
      return extensions.has(ext);
    });
  } else {
    sourceFiles = await collectSourceFiles(repoPath, extensions, skipTests, MAX_FILES);
  }

  logger.info(`[${repoId}] 收集到 ${sourceFiles.length} 个 ${lang} 源文件`);

  // 2. 对每个文件执行 AST + Infra 提取
  for (const filePath of sourceFiles) {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > maxFileSize) continue;

      const code = await readFile(filePath, 'utf-8');
      const relPath = relative(repoPath, filePath);

      // AST 符号提取
      const fileAnalysis = await extractSymbolsFromFile(filePath, lang, code);
      fileAnalysis.filePath = relPath;
      for (const sym of fileAnalysis.symbols) {
        sym.filePath = relPath;
      }

      // Infra 引用提取
      const infraRefs = extractInfraRefs(code, relPath, lang);

      // AST 级框架路由增强
      if (lang === 'java') {
        infraRefs.push(...extractSpringRoutesFromAST(fileAnalysis.symbols));
      } else if (lang === 'php') {
        infraRefs.push(...extractLaravelRoutesEnhanced(code, relPath));
      }

      fileAnalysis.infraRefs = infraRefs;

      result.files.push(fileAnalysis);
      result.stats.filesScanned++;
      result.stats.totalSymbols += fileAnalysis.symbols.length;
      result.stats.totalInfraRefs += infraRefs.length;
      result.stats.totalCallEdges += fileAnalysis.callEdges.length;
    } catch (err: unknown) {
      result.stats.parseErrors++;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[${repoId}] 解析失败: ${relative(repoPath, filePath)} — ${message}`);
    }
  }

  // 3. 收集 Mapper XML（Java 项目）
  if (lang === 'java') {
    const mapperRefs = await collectMapperXmlRefs(repoPath);
    result.infraRefs.push(...mapperRefs);
    result.stats.totalInfraRefs += mapperRefs.length;
  }

  // 4. 合并所有 infraRefs + callEdges
  for (const file of result.files) {
    result.infraRefs.push(...file.infraRefs);
    result.callEdges.push(...file.callEdges);
  }
  result.infraRefs = dedupInfraRefs(result.infraRefs);

  // 5. 按模块/包分组
  result.modules = groupIntoModules(result.files, lang);

  result.stats.elapsedMs = Date.now() - startTime;
  logger.info(`[${repoId}] 分析完成: ${result.stats.filesScanned} 文件, ${result.stats.totalSymbols} 符号, ${result.stats.totalCallEdges} 调用边, ${result.stats.totalInfraRefs} 基础设施引用, ${result.stats.parseErrors} 错误, 耗时 ${result.stats.elapsedMs}ms`);

  return result;
}

// ─── 文件收集 ────────────────────────────────────────────────

async function collectSourceFiles(
  dir: string,
  extensions: Set<string>,
  skipTests: boolean,
  maxFiles: number,
): Promise<string[]> {
  const files: string[] = [];
  await walkDir(dir, extensions, skipTests, maxFiles, files);
  return files;
}

async function walkDir(
  dir: string,
  extensions: Set<string>,
  skipTests: boolean,
  maxFiles: number,
  results: string[],
): Promise<void> {
  if (results.length >= maxFiles) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxFiles) return;

    if (entry.isDirectory()) {
      const name = entry.name;
      if (SKIP_DIRS.has(name)) continue;
      if (name.startsWith('.')) continue;
      if (skipTests && (name === 'test' || name === 'tests' || name === '__tests__')) continue;
      await walkDir(join(dir, name), extensions, skipTests, maxFiles, results);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (extensions.has(ext)) {
        results.push(join(dir, entry.name));
      }
    }
  }
}

// ─── Mapper XML 收集 ─────────────────────────────────────────

async function collectMapperXmlRefs(repoPath: string): Promise<InfraRef[]> {
  const refs: InfraRef[] = [];
  const xmlFiles: string[] = [];

  async function findXml(dir: string, depth: number): Promise<void> {
    if (depth > 8 || xmlFiles.length > 100) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await findXml(join(dir, entry.name), depth + 1);
      } else if (entry.name.endsWith('.xml') && (
        dir.includes('mapper') || dir.includes('Mapper') || dir.includes('mybatis')
      )) {
        xmlFiles.push(join(dir, entry.name));
      }
    }
  }

  await findXml(repoPath, 0);

  for (const xmlFile of xmlFiles) {
    try {
      const content = await readFile(xmlFile, 'utf-8');
      if (!content.includes('<!DOCTYPE mapper') && !content.includes('<mapper')) continue;
      const relPath = relative(repoPath, xmlFile);
      refs.push(...extractFromMapperXml(content, relPath));
    } catch { /* skip */ }
  }

  return refs;
}

// ─── 模块分组 ────────────────────────────────────────────────

function groupIntoModules(files: FileAnalysis[], lang: SupportedLang): ModuleInfo[] {
  const moduleMap = new Map<string, FileAnalysis[]>();

  for (const file of files) {
    const modulePath = inferModulePath(file, lang);
    const existing = moduleMap.get(modulePath);
    if (existing) {
      existing.push(file);
    } else {
      moduleMap.set(modulePath, [file]);
    }
  }

  const modules: ModuleInfo[] = [];
  for (const [path, moduleFiles] of moduleMap) {
    const stats = { classes: 0, interfaces: 0, methods: 0, functions: 0 };
    for (const f of moduleFiles) {
      for (const s of f.symbols) {
        switch (s.kind) {
          case 'class': stats.classes++; break;
          case 'interface': stats.interfaces++; break;
          case 'method': stats.methods++; break;
          case 'function': stats.functions++; break;
        }
      }
    }
    modules.push({ path, files: moduleFiles, stats });
  }

  return modules.sort((a, b) => a.path.localeCompare(b.path));
}

function inferModulePath(file: FileAnalysis, lang: SupportedLang): string {
  // 优先用 namespace/package
  if (file.namespace) {
    // Java/Kotlin: 取前 3 级 package（如 com.example.user）
    if (lang === 'java' || lang === 'kotlin') {
      const parts = file.namespace.split('.');
      return parts.slice(0, Math.min(parts.length, 4)).join('.');
    }
    // PHP: 取前 2 级 namespace（如 App\Http）
    if (lang === 'php') {
      const parts = file.namespace.split('\\');
      return parts.slice(0, Math.min(parts.length, 3)).join('\\');
    }
  }

  // 回退：用目录路径的前 2 级
  const parts = file.filePath.split(sep);
  // 跳过 src/main/java 等固定前缀
  const srcIdx = parts.findIndex(p => p === 'src');
  const start = srcIdx >= 0 ? srcIdx + 1 : 0;
  const relevant = parts.slice(start, -1); // 去掉文件名
  return relevant.slice(0, 2).join('/') || '(root)';
}

// ─── 去重 ────────────────────────────────────────────────────

function dedupInfraRefs(refs: InfraRef[]): InfraRef[] {
  const seen = new Set<string>();
  return refs.filter(r => {
    const key = `${r.type}:${r.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
