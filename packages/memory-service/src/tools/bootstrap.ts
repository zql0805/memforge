// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: bootstrap — 一键冷启动：批量导入 Rules、Skills、拓扑、文档到记忆库

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { getLogger, getIdeConfig, getPool, validateScanPath } from '@memforgeai/shared';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:bootstrap');

interface BootstrapResult {
  rules: { scanned: number; stored: number; duplicates: number };
  skills: { scanned: number; stored: number; duplicates: number };
  topology: { registries: number; services: number; edges: number };
  docs: { files: number; chunks: number; stored: number };
  elapsed: number;
}

export function registerBootstrap(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'bootstrap',
    '一键冷启动：批量导入现有 IDE Rules、Skills、拓扑注册表和项目文档到记忆库。首次使用 Memforge 时运行此工具，将已有知识资产全部灌入。',
    {
      ide_dir: z.string().optional().describe('IDE 配置根目录（自动检测，可手动覆盖）'),
      cursor_dir: z.string().optional().describe('[已弃用] 请使用 ide_dir'),
      import_rules: z.boolean().default(true).describe('是否导入 IDE rules 目录下的规则文件'),
      import_skills: z.boolean().default(true).describe('是否导入 IDE skills 目录下的 SKILL.md'),
      import_topology: z.boolean().default(true).describe('是否导入 *-registry.json 拓扑数据'),
      import_docs: z.boolean().default(true).describe('是否导入项目 docs/ 目录下的文档'),
      dry_run: z.boolean().default(false).describe('试运行：只统计不写入'),
    },
    async ({ ide_dir, cursor_dir, import_rules, import_skills, import_topology, import_docs, dry_run }) => {
      const startTime = Date.now();
      const home = process.env.HOME ?? '';
      const ideConfig = getIdeConfig();
      const resolvedDir = ide_dir || cursor_dir;
      const ideDirRoot = resolvedDir
        ? resolve(resolvedDir.replace(/^~/, home))
        : ideConfig.configDir;

      if (resolvedDir) {
        try {
          validateScanPath(ideDirRoot);
        } catch (err) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: (err as Error).message }),
            }],
          };
        }
      }

      const projectRoot = ctx.gitContext?.projectPath ?? process.cwd();
      const projectId = ctx.gitContext?.projectName ?? 'default';

      const result: BootstrapResult = {
        rules: { scanned: 0, stored: 0, duplicates: 0 },
        skills: { scanned: 0, stored: 0, duplicates: 0 },
        topology: { registries: 0, services: 0, edges: 0 },
        docs: { files: 0, chunks: 0, stored: 0 },
        elapsed: 0,
      };

      // 1. 导入 IDE Rules
      if (import_rules) {
        const rulesDir = resolvedDir ? join(ideDirRoot, 'rules') : ideConfig.rulesDir;
        if (await pathExists(rulesDir)) {
          const mdcFiles = (await readdir(rulesDir)).filter(f => f.endsWith(ideConfig.ruleExtension));
          result.rules.scanned = mdcFiles.length;

          const existingRuleTitles = await getExistingRuleTitles();

          for (const file of mdcFiles) {
            if (file.startsWith('memforge-')) {
              result.rules.duplicates++;
              continue;
            }

            const content = await readFile(join(rulesDir, file), 'utf-8');
            if (content.trim().length < 20) continue;

            const title = extractMdcTitle(content, file);
            const bareTitle = title.replace(/^\[Rule\]\s*/, '');
            if (existingRuleTitles.has(bareTitle.toLowerCase())) {
              logger.debug({ file, title: bareTitle }, 'memory.rules 已有同名规则，跳过导入 entries');
              result.rules.duplicates++;
              continue;
            }

            const stored = await storeIfNew(ctx, {
              projectId, title,
              content: content.slice(0, 5000),
              scope: 'coding_standard',
              source: 'manual',
              tags: ['bootstrap', 'cursor-rule', `file:${file}`],
              metadata: { sourceFile: join(rulesDir, file), bootstrapAt: new Date().toISOString() },
            }, dry_run);
            if (stored) result.rules.stored++;
            else result.rules.duplicates++;
          }
        }
      }

      // 2. 导入 Skills (SKILL.md 文件)
      if (import_skills) {
        const skillsDir = resolvedDir ? join(ideDirRoot, 'skills') : ideConfig.skillsDir;
        if (await pathExists(skillsDir)) {
          const skillDirs = await readdir(skillsDir);
          for (const dir of skillDirs) {
            const skillPath = join(skillsDir, dir, 'SKILL.md');
            if (!(await pathExists(skillPath))) continue;

            result.skills.scanned++;
            const content = await readFile(skillPath, 'utf-8');
            if (content.trim().length < 20) continue;

            const title = `[Skill] ${dir}`;
            const stored = await storeIfNew(ctx, {
              projectId, title,
              content: content.slice(0, 5000),
              scope: 'tool_usage',
              source: 'manual',
              tags: ['bootstrap', 'skill', `skill:${dir}`],
              metadata: { skillName: dir, sourceFile: skillPath, bootstrapAt: new Date().toISOString() },
            }, dry_run);
            if (stored) result.skills.stored++;
            else result.skills.duplicates++;
          }
        }
      }

      // 3. 导入拓扑注册表
      if (import_topology) {
        if (await pathExists(ideDirRoot)) {
          const files = (await readdir(ideDirRoot)).filter(f => f.endsWith('-registry.json'));
          result.topology.registries = files.length;

          for (const file of files) {
            try {
              const raw = await readFile(join(ideDirRoot, file), 'utf-8');
              const data = JSON.parse(raw);
              if (!data.repos || !data.productLine) continue;

              const serviceCount = Object.keys(data.repos).length;
              const edgeCount = data.edges?.length ?? 0;
              result.topology.services += serviceCount;
              result.topology.edges += edgeCount;

              const overview = [
                `产品线: ${data.productLine}`,
                `服务: ${serviceCount} 个`,
                `调用关系: ${edgeCount} 条`,
                `生成时间: ${data.generatedAt ?? 'unknown'}`,
              ].join('\n');

              await storeIfNew(ctx, {
                projectId: data.productLine.toLowerCase(), title: `[拓扑] ${data.productLine} 全景`,
                content: overview,
                scope: 'architecture',
                source: 'ai_suggestion',
                tags: ['bootstrap', 'topology', `pl:${data.productLine.toLowerCase()}`],
                metadata: { sourceFile: file, bootstrapAt: new Date().toISOString() },
              }, dry_run);
            } catch {
              logger.warn({ file }, '解析注册表失败');
            }
          }
        }
      }

      // 4. 导入项目文档
      if (import_docs) {
        const docDirs = [
          join(projectRoot, 'docs'),
        ].filter(d => pathExistsSync(d));

        for (const dir of docDirs) {
          const files = await collectDocFiles(dir);
          result.docs.files += files.length;

          for (const file of files) {
            const content = await readFile(file, 'utf-8');
            if (content.trim().length < 50) continue;

            const chunks = splitDocument(content, file);
            result.docs.chunks += chunks.length;

            for (const chunk of chunks) {
              const stored = await storeIfNew(ctx, {
                projectId, title: chunk.title,
                content: chunk.content,
                scope: 'domain_knowledge',
                source: 'manual',
                tags: ['bootstrap', 'document', `file:${basename(file)}`],
                metadata: { sourceFile: file, section: chunk.section, bootstrapAt: new Date().toISOString() },
              }, dry_run);
              if (stored) result.docs.stored++;
            }
          }
        }
      }

      result.elapsed = Date.now() - startTime;

      logger.info({
        rules: result.rules.stored,
        skills: result.skills.stored,
        topology: result.topology.services,
        docs: result.docs.stored,
        dryRun: dry_run,
        elapsed: result.elapsed,
      }, '冷启动导入完成');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            mode: dry_run ? '试运行' : '已导入',
            ...result,
            message: dry_run
              ? `试运行完成。预计导入：${result.rules.stored} 条规则、${result.skills.stored} 个技能、${result.topology.services} 个服务节点、${result.docs.stored} 个文档块。`
              : `冷启动完成！已导入 ${result.rules.stored} 条规则、${result.skills.stored} 个技能、${result.topology.services} 个服务节点、${result.docs.stored} 个文档块。耗时 ${result.elapsed}ms。`,
          }, null, 2),
        }],
      };
    },
  );
}

interface StoreParams {
  projectId: string;
  title: string;
  content: string;
  scope: string;
  source: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

async function storeIfNew(ctx: ToolContext, params: StoreParams, dryRun: boolean): Promise<boolean> {
  if (dryRun) return true;

  const scanResult = ctx.scanner.scan(params.content);
  if (scanResult.blocked) return false;

  const finalContent = scanResult.sanitizedContent ?? params.content;
  const embedding = await ctx.embedding.embedPassage(`${params.title} ${finalContent}`);

  const dup = await ctx.storage.checkDuplicate(embedding, 0.90);
  if (dup) return false;

  await ctx.storage.store({
    projectId: params.projectId,
    branchId: null,
    title: params.title,
    content: finalContent,
    scope: params.scope as MemoryScope,
    source: params.source as MemorySource,
    tags: params.tags,
    embedding,
    metadata: params.metadata,
    isArchived: false,
    archivedReason: null,
    createdBy: ctx.userId,
    expiresAt: null,
    orgId: ctx.orgId || null,
    teamId: null,
    visibility: 'personal',
  });

  return true;
}

async function getExistingRuleTitles(): Promise<Set<string>> {
  try {
    const pool = getPool();
    const res = await pool.query(
      `SELECT LOWER(title) as title FROM memory.rules WHERE status IN ('active', 'candidate', 'voting')`,
    );
    return new Set(res.rows.map((r: { title: string }) => r.title));
  } catch (err) {
    logger.warn({ err }, '查询 memory.rules 失败，跳过去重检查');
    return new Set();
  }
}

function extractMdcTitle(content: string, filename: string): string {
  const titleMatch = content.match(/^#\s+(.+)/m);
  if (titleMatch) return `[Rule] ${titleMatch[1].trim()}`;
  const descMatch = content.match(/description:\s*"?([^"\n]+)"?/);
  if (descMatch) return `[Rule] ${descMatch[1].trim()}`;
  return `[Rule] ${basename(filename, getIdeConfig().ruleExtension)}`;
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

function pathExistsSync(p: string): boolean {
  return existsSync(p);
}

async function collectDocFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  const supportedExts = new Set(['.md', '.mdx', '.txt', '.rst']);

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      files.push(...await collectDocFiles(fullPath));
    } else if (entry.isFile() && supportedExts.has(extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

interface DocChunk { title: string; content: string; section: string; }

function splitDocument(content: string, filePath: string): DocChunk[] {
  const fileName = basename(filePath, extname(filePath));
  const lines = content.split('\n');
  const chunks: DocChunk[] = [];
  let currentSection = fileName;
  let buffer: string[] = [];
  const MAX_CHUNK = 2000;
  const MIN_CHUNK = 50;

  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.+)/);
    if (heading && buffer.length > 0) {
      const text = buffer.join('\n').trim();
      if (text.length >= MIN_CHUNK) {
        chunks.push({ title: currentSection, content: text.slice(0, MAX_CHUNK), section: currentSection });
      }
      buffer = [];
    }
    if (heading) currentSection = heading[2].trim();
    buffer.push(line);
  }

  if (buffer.length > 0) {
    const text = buffer.join('\n').trim();
    if (text.length >= MIN_CHUNK) {
      chunks.push({ title: currentSection, content: text.slice(0, MAX_CHUNK), section: currentSection });
    }
  }

  return chunks;
}
