// Created by dev on 2026/04/08
// Copyright © 2026
// MCP 工具: index_api_docs — 扫描内部框架/公共库源码，提取 API 用法存入记忆库
// 支持 Java (Maven)、PHP (Composer)、Node (npm) 项目

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative, extname, basename, join } from 'node:path';
import { assertPathWithin, getLogger, validateScanPath } from '@memforgeai/shared';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { storeWithRouting } from '../storage/storage-router.js';

const logger = getLogger('tool:index-api-docs');

const JAVA_EXTENSIONS = new Set(['.java']);
const PHP_EXTENSIONS = new Set(['.php']);
const TS_EXTENSIONS = new Set(['.ts', '.tsx']);
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);

const MAX_FILE_SIZE = 100 * 1024; // 100KB
const MAX_CHUNK_LENGTH = 2000;
const MIN_CHUNK_LENGTH = 80;
const MAX_FILES_PER_SCAN = 200;

type TechStack = 'java' | 'php' | 'typescript' | 'unknown';

interface ApiChunk {
  title: string;
  content: string;
  metadata: Record<string, unknown>;
}

// ─── 公开 API：供 scan_topology 集成调用 ────────────────────

export interface IndexApiDocsOptions {
  repoPath: string;
  repoId: string;
  techStack: TechStack;
  productLine?: string;
  framework?: string;
  tags?: string[];
}

export interface IndexApiDocsResult {
  repoId: string;
  filesScanned: number;
  chunksExtracted: number;
  stored: number;
  duplicates: number;
}

/**
 * 纯逻辑函数：扫描指定仓库目录，提取 API 文档并存入记忆库。
 * 被 MCP 工具和 scan_topology 共同调用。
 */
export async function indexApiDocsForRepo(
  ctx: ToolContext,
  opts: IndexApiDocsOptions,
): Promise<IndexApiDocsResult> {
  const { repoPath, repoId, techStack, productLine, framework, tags: extraTags } = opts;
  const projectId = productLine ?? ctx.gitContext?.projectName ?? 'default';
  const branchId = null;
  const plTag = productLine ? `pl:${productLine.toLowerCase()}` : undefined;

  const result: IndexApiDocsResult = {
    repoId,
    filesScanned: 0,
    chunksExtracted: 0,
    stored: 0,
    duplicates: 0,
  };

  // 1. 收集 README / docs 文档
  const docChunks = await extractDocChunks(repoPath, repoId, framework);

  // 2. 收集源码中的公开 API 签名
  const codeChunks = await extractCodeApiChunks(repoPath, repoId, techStack, framework);
  result.filesScanned = codeChunks.filesScanned;

  const allChunks = [...docChunks, ...codeChunks.chunks];
  result.chunksExtracted = allChunks.length;

  // 3. 向量化并存储
  for (const chunk of allChunks) {
    const scanResult = ctx.scanner.scan(chunk.content);
    if (scanResult.blocked) continue;

    const finalContent = scanResult.sanitizedContent ?? chunk.content;
    const embedding = await ctx.embedding.embedPassage(`${chunk.title} ${finalContent}`);

    const dup = await ctx.storage.checkDuplicate(embedding, 0.92);
    if (dup) {
      result.duplicates++;
      continue;
    }

    await storeWithRouting({
      ctx,
      scope: 'api_reference',
      projectId,
      productLine: plTag?.replace('pl:', '') ?? undefined,
      branchId,
      title: chunk.title,
      content: finalContent,
      source: 'ai_suggestion',
      tags: [
        'api_reference',
        `repo:${repoId}`,
        ...(plTag ? [plTag] : []),
        ...(framework ? [`framework:${framework}`] : []),
        ...(extraTags ?? []),
      ],
      embedding,
      metadata: {
        ...chunk.metadata,
        repoId,
        framework: framework ?? repoId.split('/').pop(),
        indexedAt: new Date().toISOString(),
        indexedBy: 'index_api_docs',
      },
      sourceRef: `api:${repoId}:${chunk.title.slice(0, 80)}`,
      visibility: 'personal',
    });

    result.stored++;
  }

  logger.info({
    repoId,
    files: result.filesScanned,
    chunks: result.chunksExtracted,
    stored: result.stored,
    dups: result.duplicates,
  }, 'API 文档索引完成');

  return result;
}

// ─── MCP 工具注册 ──────────────────────────────────────────

export function registerIndexApiDocs(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'index_api_docs',
    '扫描内部框架或公共库的源码，提取公开 API 签名和用法文档，存入记忆库（scope=api_reference）。'
    + '支持 Java/PHP/TypeScript 项目。AI 在生成调用框架 API 的代码时会自动检索这些记忆。',
    {
      repo_path: z.string().describe('仓库根目录的绝对路径'),
      repo_id: z.string().optional().describe('仓库标识（如 "group/team/service-name"），不传则从路径推断'),
      tech_stack: z.enum(['java', 'php', 'typescript', 'unknown']).optional().describe('技术栈，不传则自动检测'),
      framework: z.string().optional().describe('框架/库名称（如 "momoboot"、"common"），用于标记来源'),
      product_line: z.string().optional().describe('产品线标识，设置后记忆在该产品线内共享'),
      tags: z.array(z.string()).optional().describe('额外标签'),
      dry_run: z.boolean().default(false).describe('试运行：只报告将索引的内容，不实际存储'),
    },
    async ({ repo_path, repo_id, tech_stack, framework, product_line, tags, dry_run }) => {
      try {
        validateScanPath(repo_path);
        const repoPath = assertPathWithin([process.env.HOME ?? '/tmp', process.cwd()], repo_path);
        const detectedStack = tech_stack ?? await detectTechStack(repoPath);
        const repoId = repo_id ?? inferRepoId(repoPath);

        if (dry_run) {
          const docChunks = await extractDocChunks(repoPath, repoId, framework);
          const codeChunks = await extractCodeApiChunks(repoPath, repoId, detectedStack, framework);
          return text(JSON.stringify({
            mode: '试运行（未实际存储）',
            repoId,
            techStack: detectedStack,
            framework: framework ?? repoId.split('/').pop(),
            filesScanned: codeChunks.filesScanned,
            docChunks: docChunks.length,
            codeChunks: codeChunks.chunks.length,
            totalChunks: docChunks.length + codeChunks.chunks.length,
            sampleTitles: [...docChunks, ...codeChunks.chunks].slice(0, 10).map(c => c.title),
          }, null, 2));
        }

        const result = await indexApiDocsForRepo(ctx, {
          repoPath, repoId, techStack: detectedStack, productLine: product_line, framework, tags,
        });

        return text(JSON.stringify({
          success: true,
          ...result,
          framework: framework ?? repoId.split('/').pop(),
        }, null, 2));
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'index_api_docs 执行失败');
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }], isError: true };
      }
    },
  );
}

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

// ─── 技术栈检测 ────────────────────────────────────────────

async function detectTechStack(repoPath: string): Promise<TechStack> {
  const checks: Array<[string, TechStack]> = [
    ['pom.xml', 'java'],
    ['build.gradle', 'java'],
    ['composer.json', 'php'],
    ['package.json', 'typescript'],
    ['tsconfig.json', 'typescript'],
  ];

  for (const [file, stack] of checks) {
    try {
      await stat(join(repoPath, file));
      return stack;
    } catch { /* 不存在 */ }
  }
  return 'unknown';
}

function inferRepoId(repoPath: string): string {
  const parts = repoPath.split('/');
  return parts.slice(-2).join('/');
}

// ─── 文档提取（README / docs/） ───────────────────────────

async function extractDocChunks(
  repoPath: string,
  repoId: string,
  framework?: string,
): Promise<ApiChunk[]> {
  const chunks: ApiChunk[] = [];
  const frameworkName = framework ?? repoId.split('/').pop() ?? 'unknown';

  // README
  for (const name of ['README.md', 'readme.md', 'README.rst', 'README.txt']) {
    try {
      const content = await readFile(join(repoPath, name), 'utf-8');
      if (content.length > MIN_CHUNK_LENGTH) {
        chunks.push(...splitDocToChunks(content, `[API·文档] ${frameworkName} README`, {
          type: 'readme',
          framework: frameworkName,
        }));
      }
      break;
    } catch { /* 不存在 */ }
  }

  // docs/ 目录
  for (const docsDir of ['docs', 'doc', 'DOC']) {
    try {
      const docsPath = join(repoPath, docsDir);
      await stat(docsPath);
      const files = await collectDocFiles(docsPath, true, 3);
      for (const filePath of files.slice(0, 50)) {
        const content = await readFile(filePath, 'utf-8');
        if (content.length < MIN_CHUNK_LENGTH) continue;
        const relPath = relative(repoPath, filePath);
        chunks.push(...splitDocToChunks(content, `[API·文档] ${frameworkName}/${relPath}`, {
          type: 'documentation',
          framework: frameworkName,
          sourceFile: relPath,
        }));
      }
      break;
    } catch { /* 不存在 */ }
  }

  return chunks;
}

function splitDocToChunks(
  content: string,
  baseTitle: string,
  baseMeta: Record<string, unknown>,
): ApiChunk[] {
  const chunks: ApiChunk[] = [];
  const sections = content.split(/(?=^#{1,3}\s)/m);

  for (const section of sections) {
    const trimmed = section.trim();
    if (trimmed.length < MIN_CHUNK_LENGTH) continue;

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)/);
    const heading = headingMatch ? headingMatch[2].trim() : '';
    const title = heading ? `${baseTitle} — ${heading}` : baseTitle;

    if (trimmed.length <= MAX_CHUNK_LENGTH) {
      chunks.push({ title, content: trimmed, metadata: { ...baseMeta, section: heading } });
    } else {
      const subChunks = splitByParagraph(trimmed, title, baseMeta, heading);
      chunks.push(...subChunks);
    }
  }

  return chunks;
}

function splitByParagraph(
  text: string,
  baseTitle: string,
  baseMeta: Record<string, unknown>,
  section: string,
): ApiChunk[] {
  const chunks: ApiChunk[] = [];
  const paragraphs = text.split(/\n\n+/);
  let buffer = '';
  let part = 1;

  for (const para of paragraphs) {
    if (buffer.length + para.length > MAX_CHUNK_LENGTH && buffer.length > 0) {
      chunks.push({
        title: `${baseTitle} (${part})`,
        content: buffer.trim(),
        metadata: { ...baseMeta, section, part },
      });
      buffer = '';
      part++;
    }
    buffer += (buffer ? '\n\n' : '') + para;
  }

  if (buffer.trim().length >= MIN_CHUNK_LENGTH) {
    chunks.push({
      title: part > 1 ? `${baseTitle} (${part})` : baseTitle,
      content: buffer.trim(),
      metadata: { ...baseMeta, section, part: part > 1 ? part : undefined },
    });
  }

  return chunks;
}

// ─── 源码 API 提取 ────────────────────────────────────────

interface CodeExtractResult {
  filesScanned: number;
  chunks: ApiChunk[];
}

async function extractCodeApiChunks(
  repoPath: string,
  repoId: string,
  techStack: TechStack,
  framework?: string,
): Promise<CodeExtractResult> {
  const frameworkName = framework ?? repoId.split('/').pop() ?? 'unknown';

  switch (techStack) {
    case 'java':
      return extractJavaApi(repoPath, frameworkName);
    case 'php':
      return extractPhpApi(repoPath, frameworkName);
    case 'typescript':
      return extractTsApi(repoPath, frameworkName);
    default:
      return { filesScanned: 0, chunks: [] };
  }
}

// ─── Java API 提取 ─────────────────────────────────────────
// 关注 api 模块中的接口定义、公共工具类、注解定义

async function extractJavaApi(repoPath: string, frameworkName: string): Promise<CodeExtractResult> {
  const chunks: ApiChunk[] = [];
  let filesScanned = 0;

  // 优先扫描 api 子模块（接口定义）
  const apiPaths = await findJavaApiPaths(repoPath);
  const allJavaFiles: string[] = [];

  for (const apiPath of apiPaths) {
    const files = await collectSourceFiles(apiPath, JAVA_EXTENSIONS, MAX_FILES_PER_SCAN);
    allJavaFiles.push(...files);
  }

  // 如果没有 api 模块，扫描整体 src/main/java 中的公开接口
  if (allJavaFiles.length === 0) {
    const srcPath = join(repoPath, 'src', 'main', 'java');
    try {
      await stat(srcPath);
      const files = await collectSourceFiles(srcPath, JAVA_EXTENSIONS, MAX_FILES_PER_SCAN);
      allJavaFiles.push(...files);
    } catch { /* 不存在 */ }
  }

  for (const filePath of allJavaFiles) {
    filesScanned++;
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_FILE_SIZE) continue;

      const content = await readFile(filePath, 'utf-8');
      const extracted = parseJavaPublicApi(content, filePath, repoPath, frameworkName);
      chunks.push(...extracted);
    } catch { /* 跳过无法读取的文件 */ }
  }

  return { filesScanned, chunks };
}

function parseJavaPublicApi(content: string, filePath: string, repoPath: string, frameworkName: string): ApiChunk[] {
  const chunks: ApiChunk[] = [];
  const relPath = relative(repoPath, filePath);
  const className = basename(filePath, '.java');

  // 跳过测试类和内部实现
  if (relPath.includes('/test/') || relPath.includes('Impl.java') || relPath.includes('Test.java')) {
    return [];
  }

  // 提取 package 声明
  const packageMatch = content.match(/^package\s+([\w.]+);/m);
  const packageName = packageMatch ? packageMatch[1] : '';

  // 提取接口/类声明及其方法签名
  const isInterface = /\binterface\s+\w+/.test(content);
  const isAbstract = /\babstract\s+class\s+\w+/.test(content);
  const isAnnotation = /@interface\s+\w+/.test(content);
  const hasPublicMethods = /public\s+(?:static\s+)?(?:abstract\s+)?[\w<>\[\],\s]+\s+\w+\s*\(/.test(content);

  // 只索引有公开 API 意义的文件
  if (!isInterface && !isAbstract && !isAnnotation && !hasPublicMethods) {
    return [];
  }

  // 提取类级 Javadoc
  const classDocMatch = content.match(/\/\*\*[\s\S]*?\*\/\s*(?:@\w+.*\n)*\s*public\s+(?:abstract\s+)?(?:class|interface|@interface)\s+(\w+)/);
  const classDoc = classDocMatch
    ? content.substring(content.indexOf(classDocMatch[0]), content.indexOf(classDocMatch[0]) + classDocMatch[0].length)
    : '';

  // 提取公开方法签名（含 Javadoc）
  const methodSignatures: string[] = [];
  const methodRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:@\w+(?:\([^)]*\))?\s*\n\s*)*public\s+(?:static\s+)?(?:abstract\s+)?(?:default\s+)?[\w<>\[\],\s]+\s+(\w+)\s*\([^)]*\)/g;
  let match;
  while ((match = methodRegex.exec(content)) !== null) {
    methodSignatures.push(match[0].trim());
  }

  if (methodSignatures.length === 0 && !classDoc) {
    return [];
  }

  // 构建 API 文档
  const typeLabel = isInterface ? '接口' : isAnnotation ? '注解' : isAbstract ? '抽象类' : '工具类';
  let apiContent = `${typeLabel}: ${packageName}.${className}\n`;
  apiContent += `包路径: ${packageName}\n`;
  apiContent += `文件: ${relPath}\n\n`;

  if (classDoc) {
    apiContent += `${classDoc}\n\n`;
  }

  if (methodSignatures.length > 0) {
    apiContent += `公开方法（${methodSignatures.length} 个）:\n\n`;
    for (const sig of methodSignatures.slice(0, 30)) {
      apiContent += `${sig}\n\n`;
    }
  }

  // 如果内容过长，分块
  if (apiContent.length <= MAX_CHUNK_LENGTH) {
    chunks.push({
      title: `[API·${frameworkName}] ${className} (${typeLabel})`,
      content: apiContent,
      metadata: {
        type: 'java_api',
        className,
        packageName,
        apiType: typeLabel,
        methodCount: methodSignatures.length,
        sourceFile: relPath,
      },
    });
  } else {
    const subChunks = splitByParagraph(apiContent, `[API·${frameworkName}] ${className}`, {
      type: 'java_api',
      className,
      packageName,
      apiType: typeLabel,
      sourceFile: relPath,
    }, className);
    chunks.push(...subChunks);
  }

  return chunks;
}

async function findJavaApiPaths(repoPath: string): Promise<string[]> {
  const paths: string[] = [];

  // Maven 多模块: 找 *-api 子模块
  try {
    const entries = await readdir(repoPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith('-api') || entry.name === 'api') {
        const srcPath = join(repoPath, entry.name, 'src', 'main', 'java');
        try {
          await stat(srcPath);
          paths.push(srcPath);
        } catch { /* 不存在 */ }
      }
    }
  } catch { /* 无法读取 */ }

  return paths;
}

// ─── PHP API 提取 ──────────────────────────────────────────

async function extractPhpApi(repoPath: string, frameworkName: string): Promise<CodeExtractResult> {
  const chunks: ApiChunk[] = [];
  let filesScanned = 0;

  // 扫描 model/ 和 component/ 目录中的公开方法
  for (const subDir of ['model', 'component', 'lib', 'src', 'app']) {
    const dirPath = join(repoPath, subDir);
    try {
      await stat(dirPath);
      const files = await collectSourceFiles(dirPath, PHP_EXTENSIONS, MAX_FILES_PER_SCAN);
      for (const filePath of files) {
        filesScanned++;
        try {
          const fileStat = await stat(filePath);
          if (fileStat.size > MAX_FILE_SIZE) continue;

          const content = await readFile(filePath, 'utf-8');
          const extracted = parsePhpPublicApi(content, filePath, repoPath, frameworkName);
          chunks.push(...extracted);
        } catch { /* 跳过 */ }
      }
    } catch { /* 不存在 */ }
  }

  return { filesScanned, chunks };
}

function parsePhpPublicApi(content: string, filePath: string, repoPath: string, frameworkName: string): ApiChunk[] {
  const relPath = relative(repoPath, filePath);
  const className = basename(filePath, '.php');

  if (relPath.includes('/test/') || relPath.includes('Test.php')) return [];

  // 提取 class 声明
  const classMatch = content.match(/(?:abstract\s+)?class\s+(\w+)/);
  if (!classMatch) return [];

  // 提取 public static 方法签名
  const methods: string[] = [];
  const methodRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?public\s+(?:static\s+)?function\s+(\w+)\s*\([^)]*\)/g;
  let match;
  while ((match = methodRegex.exec(content)) !== null) {
    if (!match[1].startsWith('_')) {
      methods.push(match[0].trim());
    }
  }

  if (methods.length === 0) return [];

  let apiContent = `PHP 类: ${className}\n`;
  apiContent += `文件: ${relPath}\n\n`;
  apiContent += `公开方法（${methods.length} 个）:\n\n`;
  for (const m of methods.slice(0, 30)) {
    apiContent += `${m}\n\n`;
  }

  return [{
    title: `[API·${frameworkName}] ${className}`,
    content: apiContent,
    metadata: {
      type: 'php_api',
      className,
      methodCount: methods.length,
      sourceFile: relPath,
    },
  }];
}

// ─── TypeScript API 提取 ──────────────────────────────────

async function extractTsApi(repoPath: string, frameworkName: string): Promise<CodeExtractResult> {
  const chunks: ApiChunk[] = [];
  let filesScanned = 0;

  const srcPath = join(repoPath, 'src');
  try {
    await stat(srcPath);
    const files = await collectSourceFiles(srcPath, TS_EXTENSIONS, MAX_FILES_PER_SCAN);
    for (const filePath of files) {
      filesScanned++;
      try {
        const fileStat = await stat(filePath);
        if (fileStat.size > MAX_FILE_SIZE) continue;

        const content = await readFile(filePath, 'utf-8');
        const extracted = parseTsPublicApi(content, filePath, repoPath, frameworkName);
        chunks.push(...extracted);
      } catch { /* 跳过 */ }
    }
  } catch { /* 不存在 */ }

  return { filesScanned, chunks };
}

function parseTsPublicApi(content: string, filePath: string, repoPath: string, frameworkName: string): ApiChunk[] {
  const relPath = relative(repoPath, filePath);
  const fileName = basename(filePath, extname(filePath));

  if (relPath.includes('.test.') || relPath.includes('.spec.') || relPath.includes('__tests__')) return [];

  // 提取 export 的函数、类、接口、类型
  const exports: string[] = [];
  const exportRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?export\s+(?:async\s+)?(?:function|class|interface|type|const|enum)\s+(\w+)[^;{]*/g;
  let match;
  while ((match = exportRegex.exec(content)) !== null) {
    exports.push(match[0].trim());
  }

  if (exports.length === 0) return [];

  let apiContent = `TypeScript 模块: ${relPath}\n\n`;
  apiContent += `导出（${exports.length} 个）:\n\n`;
  for (const exp of exports.slice(0, 30)) {
    apiContent += `${exp}\n\n`;
  }

  return [{
    title: `[API·${frameworkName}] ${fileName}`,
    content: apiContent,
    metadata: {
      type: 'typescript_api',
      modulePath: relPath,
      exportCount: exports.length,
      sourceFile: relPath,
    },
  }];
}

// ─── 文件收集工具 ──────────────────────────────────────────

async function collectSourceFiles(
  dir: string,
  extensions: Set<string>,
  maxFiles: number,
): Promise<string[]> {
  const files: string[] = [];
  await walkDir(dir, extensions, files, maxFiles);
  return files;
}

async function walkDir(
  dir: string,
  extensions: Set<string>,
  files: string[],
  maxFiles: number,
  depth = 0,
): Promise<void> {
  if (depth > 10 || files.length >= maxFiles) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= maxFiles) break;
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const skip = ['node_modules', '.git', 'target', 'build', 'dist', 'vendor', '__pycache__', '.idea'];
      if (!entry.name.startsWith('.') && !skip.includes(entry.name)) {
        await walkDir(fullPath, extensions, files, maxFiles, depth + 1);
      }
    } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
}

async function collectDocFiles(dir: string, recursive: boolean, maxDepth: number): Promise<string[]> {
  const files: string[] = [];
  await walkDir(dir, DOC_EXTENSIONS, files, 50, 10 - maxDepth);
  return files;
}
