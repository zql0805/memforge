// Created by dev on 2026/04/05
// Updated by dev on 2026/04/09
// Copyright © 2026
// MCP 工具: watch_docs — 监控文档目录变化并自动同步到记忆库

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { watch, readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative, extname, basename, join } from 'node:path';
import { assertPathWithin, getLogger, validateScanPath } from '@memforgeai/shared';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:watch-prdocs');

const SUPPORTED_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);
const MIN_CONTENT_LENGTH = 50;
const DEBOUNCE_MS = 500;

interface WatchState {
  active: boolean;
  controller: AbortController | null;
  directory: string;
  projectRoot: string;
  filesProcessed: number;
  lastEvent: string | null;
}

const watchStates = new Map<string, WatchState>();

export function registerWatchDocs(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'watch_docs',
    '启动或停止对文档目录的文件变化监控。检测到新增/修改文档时自动索引到记忆库。默认监控 docs/ 目录。',
    {
      action: z.enum(['start', 'stop', 'status']).describe('start=启动监控, stop=停止监控, status=查看监控状态'),
      directory: z.string().default('docs').describe('要监控的目录路径（相对项目根目录），如 docs'),
      project_root: z.string().optional().describe('项目根目录绝对路径。不传则使用 MCP 服务的工作目录。Web UI 必须传此参数'),
    },
    async ({ action, directory, project_root }) => {
      const root = project_root ?? process.cwd();
      let absDir: string;
      try {
        validateScanPath(root);
        absDir = validateScanPath(resolve(root, directory));
      } catch (err) {
        return text(`路径校验失败: ${(err as Error).message}`);
      }
      const watchKey = absDir;

      if (action === 'status') {
        const state = watchStates.get(watchKey);
        if (!state || !state.active) {
          return text(`目录 ${directory} 未在监控中。`);
        }
        return text(JSON.stringify({
          directory: state.directory,
          active: state.active,
          filesProcessed: state.filesProcessed,
          lastEvent: state.lastEvent,
        }, null, 2));
      }

      if (action === 'stop') {
        const state = watchStates.get(watchKey);
        if (!state || !state.active) {
          return text(`目录 ${directory} 未在监控中，无需停止。`);
        }

        state.controller?.abort();
        state.active = false;
        logger.info({ dir: directory }, '文档监控已停止');
        return text(`已停止监控 ${directory}。共处理 ${state.filesProcessed} 个文件事件。`);
      }

      const existing = watchStates.get(watchKey);
      if (existing?.active) {
        return text(`目录 ${directory} 已在监控中。已处理 ${existing.filesProcessed} 个文件事件。`);
      }

      try {
        assertPathWithin([root], absDir);
      } catch (err) {
        return text(`安全限制：${(err as Error).message}`);
      }

      try {
        await stat(absDir);
      } catch {
        return text(`目录 ${absDir} 不存在。请先创建该目录或指定其他路径。`);
      }

      const scanResult = await initialScan(absDir, root, ctx);

      const controller = new AbortController();
      const state: WatchState = {
        active: true,
        controller,
        directory,
        projectRoot: root,
        filesProcessed: scanResult.filesProcessed,
        lastEvent: scanResult.filesProcessed > 0 ? '初始扫描' : null,
      };
      watchStates.set(watchKey, state);

      startWatcher(absDir, state, ctx).catch((err: Error) => {
        logger.error({ err: err.message }, '文档监控异常退出');
        state.active = false;
      });

      logger.info({ dir: directory, initialFiles: scanResult.filesProcessed }, '文档监控已启动');

      return text(JSON.stringify({
        action: '已启动监控',
        directory,
        initialScan: {
          filesFound: scanResult.filesFound,
          filesProcessed: scanResult.filesProcessed,
          duplicatesSkipped: scanResult.duplicatesSkipped,
        },
        hint: '监控将在后台持续运行，检测到文件变化时自动更新记忆。使用 action=stop 停止监控。',
      }, null, 2));
    },
  );
}

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

async function initialScan(
  dir: string,
  projectRoot: string,
  ctx: ToolContext,
): Promise<{ filesFound: number; filesProcessed: number; duplicatesSkipped: number }> {
  const files = await collectDocFiles(dir);
  const projectId = ctx.gitContext?.projectName ?? 'default';
  const branchId = null;
  let processed = 0;
  let duplicates = 0;

  for (const filePath of files) {
    const relPath = relative(projectRoot, filePath);
    const content = await readFile(filePath, 'utf-8');
    if (content.trim().length < MIN_CONTENT_LENGTH) continue;

    const chunks = splitByHeadings(content, filePath);
    for (const chunk of chunks) {
      const scanResult = ctx.scanner.scan(chunk.content);
      if (scanResult.blocked) continue;

      const textToEmbed = `${chunk.title} ${scanResult.sanitizedContent ?? chunk.content}`;
      const embedding = await ctx.embedding.embedPassage(textToEmbed);

      const dup = await ctx.storage.checkDuplicate(embedding, 0.92);
      if (dup) {
        duplicates++;
        continue;
      }

      await ctx.storage.store({
        projectId,
        branchId,
        title: chunk.title,
        content: scanResult.sanitizedContent ?? chunk.content,
        scope: 'domain_knowledge' as MemoryScope,
        source: 'ai_suggestion' as MemorySource,
        tags: ['docs', 'auto-watch', `file:${relPath}`],
        embedding,
        metadata: {
          sourceFile: relPath,
          watchedAt: new Date().toISOString(),
          trigger: 'initial-scan',
        },
        isArchived: false,
        archivedReason: null,
        createdBy: ctx.userId,
        expiresAt: null,
        orgId: ctx.orgId || null,
        teamId: null,
        visibility: 'personal',
      });
    }

    processed++;
  }

  return { filesFound: files.length, filesProcessed: processed, duplicatesSkipped: duplicates };
}

// NOTE: fs.watch recursive 在 Linux 上不支持，仅 macOS/Windows 有效。
// Linux 部署时建议使用 chokidar 或 inotifywait 替代。
async function startWatcher(dir: string, state: WatchState, ctx: ToolContext): Promise<void> {
  const watcher = watch(dir, { recursive: true, signal: state.controller!.signal });
  const pendingFiles = new Map<string, NodeJS.Timeout>();

  for await (const event of watcher) {
    if (!state.active) break;

    const filename = event.filename;
    if (!filename) continue;

    const ext = extname(filename).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

    const existing = pendingFiles.get(filename);
    if (existing) clearTimeout(existing);

    pendingFiles.set(filename, setTimeout(() => {
      pendingFiles.delete(filename);
      processFileChange(dir, filename, state, ctx).catch((err: Error) => {
        logger.warn({ file: filename, err: err.message }, '处理文件变更时出错');
      });
    }, DEBOUNCE_MS));
  }
}

async function processFileChange(dir: string, filename: string, state: WatchState, ctx: ToolContext): Promise<void> {
  const filePath = join(dir, filename);

    let fileExists = true;
    try {
      await stat(filePath);
    } catch {
      fileExists = false;
    }

    if (!fileExists) {
      const relPath = relative(state.projectRoot, filePath);
      await ctx.storage.archiveByTag(`file:${relPath}`, '文档已删除（自动监控）');
      state.filesProcessed++;
      state.lastEvent = `删除: ${filename} @ ${new Date().toISOString()}`;
      logger.info({ file: filename }, '检测到文档删除，已归档关联记忆');
      return;
    }

    try {
      const content = await readFile(filePath, 'utf-8');
      if (content.trim().length < MIN_CONTENT_LENGTH) return;

      const relPath = relative(state.projectRoot, filePath);

      await ctx.storage.archiveByTag(`file:${relPath}`, '文档已更新（自动监控重新索引）');

      const projectId = ctx.gitContext?.projectName ?? 'default';
      const branchId = null;
      const chunks = splitByHeadings(content, filePath);

      for (const chunk of chunks) {
        const scanResult = ctx.scanner.scan(chunk.content);
        if (scanResult.blocked) continue;

        const embedding = await ctx.embedding.embedPassage(
          `${chunk.title} ${scanResult.sanitizedContent ?? chunk.content}`,
        );

        const dup = await ctx.storage.checkDuplicate(embedding, 0.92);
        if (dup) continue;

        await ctx.storage.store({
          projectId,
          branchId,
          title: chunk.title,
          content: scanResult.sanitizedContent ?? chunk.content,
          scope: 'domain_knowledge' as MemoryScope,
          source: 'ai_suggestion' as MemorySource,
          tags: ['docs', 'auto-watch', `file:${relPath}`],
          embedding,
          metadata: {
            sourceFile: relPath,
            watchedAt: new Date().toISOString(),
            trigger: 'file-change',
          },
          isArchived: false,
          archivedReason: null,
          createdBy: ctx.userId,
          expiresAt: null,
          orgId: ctx.orgId || null,
          teamId: null,
          visibility: 'personal',
        });
      }

      state.filesProcessed++;
      state.lastEvent = `更新: ${filename} @ ${new Date().toISOString()}`;
      logger.info({ file: filename }, '检测到文档变更，已重新索引');
    } catch (err) {
      logger.warn({ file: filename, err: (err as Error).message }, '处理文件变更时出错');
    }
}

async function collectDocFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      files.push(...(await collectDocFiles(fullPath)));
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
}

function splitByHeadings(content: string, filePath: string): Array<{ title: string; content: string }> {
  const fileName = basename(filePath, extname(filePath));
  const sections: Array<{ title: string; content: string }> = [];
  const lines = content.split('\n');
  let currentTitle = fileName;
  let currentLines: string[] = [];

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)/);
    if (heading && currentLines.length > 0) {
      const text = currentLines.join('\n').trim();
      if (text.length > MIN_CONTENT_LENGTH) {
        sections.push({ title: currentTitle, content: text });
      }
      currentLines = [];
    }
    if (heading) {
      currentTitle = heading[1].trim();
    }
    currentLines.push(line);
  }

  if (currentLines.length > 0) {
    const text = currentLines.join('\n').trim();
    if (text.length > MIN_CONTENT_LENGTH) {
      sections.push({ title: currentTitle, content: text });
    }
  }

  return sections;
}
