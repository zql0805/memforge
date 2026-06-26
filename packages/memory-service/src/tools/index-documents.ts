// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: index_documents — 扫描目录下的文档并批量索引到记忆库

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative, extname, basename } from 'node:path';
import { getLogger, MemoryScope as MemoryScopeEnum, validateScanPath } from '@memforgeai/shared';
import type { MemoryScope } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { storeWithRouting } from '../storage/storage-router.js';

const logger = getLogger('tool:index-documents');

const SUPPORTED_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);
const MAX_CHUNK_LENGTH = 2000;
const MIN_CHUNK_LENGTH = 50;
const EMBED_BATCH_SIZE = 5;

export function registerIndexDocuments(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'index_documents',
    '扫描指定目录下的文档文件（Markdown/Text），自动拆分为语义段落并存入记忆库。适用于批量导入 docs/ 目录。',
    {
      directory: z.string().describe('要扫描的目录路径（绝对路径或相对于 project_root）'),
      project_root: z.string().optional().describe('项目根目录绝对路径。不传则使用 MCP 服务的工作目录。Web UI 必须传此参数'),
      scope: MemoryScopeEnum.default('domain_knowledge').describe('记忆类型: architecture/domain_knowledge/convention/context'),
      tags: z.array(z.string()).optional().describe('为所有索引的记忆添加的标签'),
      product_line: z.string().optional().describe('产品线标识（跨项目共享时指定，如 "my-product"）。设置后 projectId 使用产品线名，并自动添加 pl: 标签'),
      recursive: z.boolean().default(true).describe('是否递归扫描子目录'),
      dry_run: z.boolean().default(false).describe('试运行模式：只报告将索引的内容，不实际存储'),
    },
    async ({ directory, project_root, scope, tags, recursive, dry_run, product_line }) => {
      const root = project_root ?? process.cwd();
      const projectId = product_line ?? ctx.gitContext?.projectName ?? 'default';
      const plTag = product_line ? `pl:${product_line.toLowerCase()}` : undefined;
      const branchId = null;
      let baseDir: string;
      try {
        validateScanPath(root);
        baseDir = validateScanPath(resolve(root, directory));
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: (err as Error).message,
          }],
        };
      }

      let files: string[];
      try {
        files = await collectFiles(baseDir, recursive);
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `无法扫描目录 ${baseDir}: ${(err as Error).message}`,
          }],
        };
      }

      if (files.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `目录 ${directory} 下没有找到支持的文档文件 (${[...SUPPORTED_EXTENSIONS].join(', ')})`,
          }],
        };
      }

      const results: IndexResult[] = [];
      let totalChunks = 0;
      let totalSkipped = 0;

      for (const filePath of files) {
        const relPath = relative(root, filePath);
        const content = await readFile(filePath, 'utf-8');

        if (content.trim().length < MIN_CHUNK_LENGTH) {
          totalSkipped++;
          continue;
        }

        const chunks = splitIntoChunks(content, filePath);
        const fileResult: IndexResult = {
          file: relPath,
          chunks: chunks.length,
          stored: 0,
          duplicates: 0,
        };

        const prepared: Array<{
          chunk: DocumentChunk;
          textToEmbed: string;
          content: string;
        }> = [];

        for (const chunk of chunks) {
          if (dry_run) {
            fileResult.stored++;
            continue;
          }

          const scanResult = ctx.scanner.scan(chunk.content);
          if (scanResult.blocked) {
            continue;
          }

          prepared.push({
            chunk,
            textToEmbed: `${chunk.title} ${scanResult.sanitizedContent ?? chunk.content}`,
            content: scanResult.sanitizedContent ?? chunk.content,
          });
        }

        for (let i = 0; i < prepared.length; i += EMBED_BATCH_SIZE) {
          const batch = prepared.slice(i, i + EMBED_BATCH_SIZE);
          const embeddings = await ctx.embedding.embedPassageBatch(batch.map((item) => item.textToEmbed));

          for (let j = 0; j < batch.length; j++) {
            const { chunk, content } = batch[j];
            const embedding = embeddings[j];

            const duplicate = await ctx.storage.checkDuplicate(embedding, 0.92);
            if (duplicate) {
              fileResult.duplicates++;
              continue;
            }

            await storeWithRouting({
              ctx,
              scope,
              projectId,
              productLine: plTag?.replace('pl:', '') ?? undefined,
              branchId,
              title: chunk.title,
              content,
              source: 'ai_suggestion',
              tags: [...(tags ?? []), ...(plTag ? [plTag] : []), 'indexed', `file:${relPath}`],
              embedding,
              metadata: {
                sourceFile: relPath,
                section: chunk.section,
                indexedAt: new Date().toISOString(),
              },
              sourceRef: `doc:${relPath}:${chunk.title.slice(0, 80)}`,
              visibility: 'personal',
            });

            fileResult.stored++;
          }
        }

        totalChunks += chunks.length;
        results.push(fileResult);
      }

      const summary = {
        directory,
        mode: dry_run ? '试运行（未实际存储）' : '已索引',
        filesScanned: files.length,
        filesSkipped: totalSkipped,
        totalChunks,
        totalStored: results.reduce((s, r) => s + r.stored, 0),
        totalDuplicates: results.reduce((s, r) => s + r.duplicates, 0),
        details: results,
      };

      logger.info({
        dir: directory,
        files: files.length,
        chunks: totalChunks,
        stored: summary.totalStored,
      }, '文档索引完成');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(summary, null, 2),
        }],
      };
    },
  );
}

interface IndexResult {
  file: string;
  chunks: number;
  stored: number;
  duplicates: number;
}

interface DocumentChunk {
  title: string;
  content: string;
  section: string;
}

async function collectFiles(dir: string, recursive: boolean): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory() && recursive && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      files.push(...(await collectFiles(fullPath, true)));
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
}

function splitIntoChunks(content: string, filePath: string): DocumentChunk[] {
  const fileName = basename(filePath, extname(filePath));
  const lines = content.split('\n');
  const chunks: DocumentChunk[] = [];

  let currentSection = fileName;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);

    if (headingMatch && currentContent.length > 0) {
      const text = currentContent.join('\n').trim();
      if (text.length >= MIN_CHUNK_LENGTH) {
        chunks.push(...splitLongText(currentSection, text));
      }
      currentContent = [];
    }

    if (headingMatch) {
      currentSection = headingMatch[2].trim();
    }

    currentContent.push(line);
  }

  if (currentContent.length > 0) {
    const text = currentContent.join('\n').trim();
    if (text.length >= MIN_CHUNK_LENGTH) {
      chunks.push(...splitLongText(currentSection, text));
    }
  }

  return chunks;
}

function splitLongText(section: string, text: string): DocumentChunk[] {
  if (text.length <= MAX_CHUNK_LENGTH) {
    return [{ title: section, content: text, section }];
  }

  const chunks: DocumentChunk[] = [];
  const paragraphs = text.split(/\n\n+/);
  let buffer = '';
  let partNum = 1;

  for (const para of paragraphs) {
    if (buffer.length + para.length > MAX_CHUNK_LENGTH && buffer.length > 0) {
      chunks.push({
        title: `${section} (${partNum})`,
        content: buffer.trim(),
        section,
      });
      buffer = '';
      partNum++;
    }
    buffer += (buffer ? '\n\n' : '') + para;
  }

  if (buffer.trim().length >= MIN_CHUNK_LENGTH) {
    chunks.push({
      title: partNum > 1 ? `${section} (${partNum})` : section,
      content: buffer.trim(),
      section,
    });
  }

  return chunks;
}
