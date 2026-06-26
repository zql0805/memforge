// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: sync_documents — 基于 git diff 检测文档变更并同步到记忆库

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, extname, basename } from 'node:path';
import { getLogger, validateScanPath } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';

const logger = getLogger('tool:sync-documents');

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);

export function registerSyncDocuments(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'sync_documents',
    '检测自上次同步以来发生变更的文档文件（基于 git diff），自动更新记忆库中对应的记忆。支持新增、修改、删除的文档。',
    {
      since: z.string().optional().describe('起始 commit/分支（默认 HEAD~5）'),
      directory: z.string().optional().describe('仅检测指定目录的变更'),
      project_root: z.string().optional().describe('Git 仓库根目录绝对路径。不传则使用 MCP 服务的工作目录。Web UI 必须传此参数'),
      dry_run: z.boolean().default(false).describe('试运行：只报告变更，不实际更新'),
    },
    async ({ since, directory, project_root, dry_run }) => {
      const cwd = project_root ?? process.cwd();
      try {
        validateScanPath(cwd);
        if (directory) {
          validateScanPath(resolve(cwd, directory));
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `路径校验失败: ${(err as Error).message}`,
          }],
        };
      }

      const ref = since ?? 'HEAD~5';

      let diffOutput: string;
      try {
        const gitArgs = ['diff', '--name-status', ref, 'HEAD', '--'];
        if (directory) {
          gitArgs.push(directory);
        } else {
          gitArgs.push('docs/');
        }
        diffOutput = execFileSync('git', gitArgs, { cwd, encoding: 'utf-8', timeout: 10000 }).trim();
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Git diff 失败: ${(err as Error).message}。请确保在 git 仓库中运行。`,
          }],
        };
      }

      if (!diffOutput) {
        return {
          content: [{
            type: 'text' as const,
            text: `自 ${ref} 以来没有检测到文档变更。`,
          }],
        };
      }

      const changes = parseDiff(diffOutput);
      const docChanges = changes.filter((c) => DOC_EXTENSIONS.has(extname(c.file)));

      if (docChanges.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `自 ${ref} 以来有 ${changes.length} 个文件变更，但无文档文件变更。`,
          }],
        };
      }

      const projectId = ctx.gitContext?.projectName ?? 'default';
      const results: SyncResult[] = [];

      for (const change of docChanges) {
        const result: SyncResult = {
          file: change.file,
          status: change.status,
          action: '跳过',
          memoriesAffected: 0,
        };

        if (change.status === 'D') {
          if (!dry_run) {
            const archived = await ctx.storage.archiveByTag(`file:${change.file}`, '文档已删除');
            result.memoriesAffected = archived;
          }
          result.action = '归档关联记忆';
        } else if (change.status === 'A' || change.status === 'M') {
          const filePath = resolve(cwd, change.file);
          let content: string;
          try {
            content = await readFile(filePath, 'utf-8');
          } catch {
            result.action = '文件读取失败';
            results.push(result);
            continue;
          }

          if (change.status === 'M' && !dry_run) {
            await ctx.storage.archiveByTag(`file:${change.file}`, '文档已更新，重新索引');
          }

          if (!dry_run) {
            const chunks = splitByHeadings(content, change.file);
            for (const chunk of chunks) {
              const scanResult = ctx.scanner.scan(chunk.content);
              if (scanResult.blocked) continue;

              const embedding = await ctx.embedding.embedPassage(
                `${chunk.title} ${scanResult.sanitizedContent ?? chunk.content}`,
              );

              const duplicate = await ctx.storage.checkDuplicate(embedding, 0.92);
              if (duplicate) continue;

              await ctx.storage.store({
                projectId,
                branchId: ctx.gitContext?.branchName ?? null,
                title: chunk.title,
                content: scanResult.sanitizedContent ?? chunk.content,
                scope: 'domain_knowledge' as MemoryScope,
                source: 'ai_suggestion' as MemorySource,
                tags: ['synced', `file:${change.file}`],
                embedding,
                metadata: {
                  sourceFile: change.file,
                  syncedAt: new Date().toISOString(),
                  gitRef: ref,
                },
                isArchived: false,
                archivedReason: null,
                createdBy: ctx.userId,
                expiresAt: null,
                orgId: ctx.orgId || null,
                teamId: null,
                visibility: 'personal',
              });

              result.memoriesAffected++;
            }
          }
          result.action = change.status === 'A' ? '新增索引' : '更新索引';
        }

        results.push(result);
      }

      const summary = {
        ref,
        mode: dry_run ? '试运行' : '已同步',
        documentChanges: docChanges.length,
        results,
      };

      logger.info({
        ref,
        changes: docChanges.length,
        dryRun: dry_run,
      }, '文档同步完成');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(summary, null, 2),
        }],
      };
    },
  );
}

interface DiffEntry {
  status: string;
  file: string;
}

interface SyncResult {
  file: string;
  status: string;
  action: string;
  memoriesAffected: number;
}

function parseDiff(output: string): DiffEntry[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...fileParts] = line.split('\t');
      return { status: status.charAt(0), file: fileParts.join('\t') };
    });
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
      if (text.length > 50) {
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
    if (text.length > 50) {
      sections.push({ title: currentTitle, content: text });
    }
  }

  return sections;
}
