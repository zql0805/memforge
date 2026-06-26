// Created by dev on 2026/04/05
// Copyright © 2026

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger, getPool, getIdeConfig } from '@memforgeai/shared';
import type { ToolContext } from '../tools/types.js';
import { installIdeRules } from './rules-installer.js';
import { installGitHooks } from './git-hooks-installer.js';

const logger = getLogger('auto-init');

type InitType = 'doc_index' | 'topology_import' | 'prdocs_watch' | 'docs_watch' | 'doc_sync';

interface InitState {
  init_type: string;
  last_status: string;
  last_run_at: string | null;
  run_count: number;
}

const AUTO_MODE = process.env.MEMFORGE_AUTO_MODE ?? 'smart';
const SYNC_INTERVAL_HOURS = parseInt(process.env.MEMFORGE_SYNC_INTERVAL_HOURS ?? '24', 10);
const AUTO_INDEX_BATCH_SIZE = 5;

/**
 * Smart Semi-Auto 初始化 Hook
 * 在 MCP Server 启动后根据项目状态自动执行初始化任务
 */
export async function runAutoInitHook(ctx: ToolContext): Promise<void> {
  if (AUTO_MODE === 'silent') {
    logger.info('自动化模式: silent，跳过所有自动初始化');
    return;
  }

  const projectId = ctx.gitContext?.projectName ?? 'unknown';
  const projectRoot = ctx.gitContext?.projectPath ?? process.cwd();
  const ideConfig = getIdeConfig();

  logger.info({ projectId, mode: AUTO_MODE }, '开始自动初始化检查');

  // 0a. 自动安装 IDE Rules
  try {
    const rulesResult = await installIdeRules(projectRoot);
    if (rulesResult.installed.length > 0 || rulesResult.updated.length > 0) {
      logger.info(
        { scope: rulesResult.scope, dir: rulesResult.rulesDir, installed: rulesResult.installed, updated: rulesResult.updated },
        'IDE Rules 已自动部署',
      );
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'IDE Rules 自动安装失败（不影响主服务）');
  }

  // 0b. 自动安装 Git Hooks（post-commit / post-merge，token 绑定产品线）
  try {
    const hooksResult = await installGitHooks(projectRoot, ctx.userId);
    if (hooksResult.installed.length > 0 || hooksResult.updated.length > 0) {
      logger.info(
        { installed: hooksResult.installed, updated: hooksResult.updated, preserved: hooksResult.userHookPreserved },
        'Git Hooks 已自动部署',
      );
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Git Hooks 自动安装失败（不影响主服务）');
  }

  const states = await getInitStates(projectId);
  const stateMap = new Map(states.map(s => [s.init_type, s]));

  // 1. 文档目录自动索引
  const docDirs = ['docs'].filter(d =>
    existsSync(join(projectRoot, d)),
  );
  if (docDirs.length > 0) {
    const docState = stateMap.get('doc_index');
    if (shouldRunInit(docState)) {
      // 原子抢占：条件 UPDATE 避免多实例 TOCTOU 重复调度
      const claimed = await tryClaimInitRun(projectId, 'doc_index');
      if (claimed) {
        setImmediate(() => {
          void (async () => {
            await runWithState(projectId, 'doc_index', async () => {
              logger.info({ dirs: docDirs }, '自动索引文档目录');
              for (const dir of docDirs) {
                await autoIndexDirectory(ctx, join(projectRoot, dir));
              }
            });
          })().catch(err => {
            logger.warn({ err: (err as Error).message, projectId }, '后台文档索引任务失败');
          });
        });
      }
    } else if (shouldRunSync(docState)) {
      await runWithState(projectId, 'doc_sync', async () => {
        // TODO: 接入 sync_documents 增量同步逻辑（当前仅记录状态）
        logger.info('自动增量同步文档（尚未实现）');
      });
    }
  }

  // 2. 拓扑注册表自动导入（已由 topology-sync.ts 处理，此处仅记录状态）
  const configDir = ideConfig.configDir;
  if (existsSync(configDir)) {
    const registries = readdirSync(configDir).filter(f => f.endsWith('-registry.json'));
    if (registries.length > 0) {
      const topoState = stateMap.get('topology_import');
      if (!topoState || topoState.last_status === 'pending') {
        await updateState(projectId, 'topology_import', 'success', {
          note: '由 topology-sync 自动模块处理',
          registries: registries.length,
        });
      }
    }
  }

  // 3. 文档目录监控（记录状态，实际监控由 watch_docs 工具提供）
  const docsDir = join(projectRoot, 'docs');
  if (existsSync(docsDir)) {
    const watchState = stateMap.get('docs_watch');
    if (!watchState || watchState.last_status === 'pending') {
      await updateState(projectId, 'docs_watch', 'success', {
        note: '文档目录已就绪，可通过 watch_docs 工具启动实时监控',
        directory: docsDir,
      });
    }
  }

  logger.info({ projectId }, '自动初始化检查完成');
}

function shouldRunInit(state: InitState | undefined): boolean {
  if (!state) return true;
  return state.last_status === 'pending' || state.last_status === 'failed';
}

function shouldRunSync(state: InitState | undefined): boolean {
  if (!state || !state.last_run_at) return false;
  if (state.last_status !== 'success') return false;
  const lastRun = new Date(state.last_run_at).getTime();
  const hoursSince = (Date.now() - lastRun) / (1000 * 60 * 60);
  return hoursSince >= SYNC_INTERVAL_HOURS;
}

async function autoIndexDirectory(ctx: ToolContext, directory: string): Promise<void> {
  const { IgnoreParser } = await import('./ignore-parser.js');
  const ignoreParser = new IgnoreParser(ctx.gitContext?.projectPath ?? process.cwd());

  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join: pathJoin, extname } = await import('node:path');

  const supportedExts = new Set(['.md', '.txt', '.rst', '.adoc']);
  const files: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = pathJoin(dir, entry.name);
      if (ignoreParser.isIgnored(fullPath)) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (supportedExts.has(extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }

  walk(directory);

  async function indexOneFile(file: string): Promise<void> {
    try {
      const fileStat = statSync(file);
      const fileMtime = String(fileStat.mtimeMs);

      const pool = getPool();
      const { rows } = await pool.query<{ file_mtime: string | null }>(
        `SELECT metadata->>'fileMtime' AS file_mtime
         FROM memory.entries
         WHERE metadata->>'filePath' = $1
           AND is_archived = FALSE
           AND tags @> $2::text[]
         LIMIT 1`,
        [file, ['auto-indexed']],
      );
      if (rows[0]?.file_mtime === fileMtime) {
        return;
      }

      const content = readFileSync(file, 'utf-8');
      if (content.trim().length < 20) return;

      const scanResult = ctx.scanner.scan(content);
      if (scanResult.blocked) {
        logger.warn({ file }, '自动索引跳过：检测到敏感信息');
        return;
      }

      const finalContent = scanResult.sanitizedContent ?? content;
      const title = finalContent.split('\n')[0]?.replace(/^#+\s*/, '').trim() || file;
      const embedding = await ctx.embedding.embed(finalContent.slice(0, 2000));

      await ctx.storage.store({
        projectId: ctx.gitContext?.projectName ?? 'unknown',
        branchId: ctx.gitContext?.branchName ?? null,
        title: title.slice(0, 200),
        content: finalContent.slice(0, 5000),
        scope: 'domain_knowledge',
        source: 'manual',
        tags: ['auto-indexed', 'document'],
        embedding,
        metadata: { filePath: file, fileMtime, autoInit: true },
        isArchived: false,
        archivedReason: null,
        createdBy: ctx.userId,
        expiresAt: null,
      });
    } catch (err) {
      logger.warn({ file, err: (err as Error).message }, '自动索引文件失败');
    }
  }

  for (let i = 0; i < files.length; i += AUTO_INDEX_BATCH_SIZE) {
    const batch = files.slice(i, i + AUTO_INDEX_BATCH_SIZE);
    await Promise.allSettled(batch.map((file) => indexOneFile(file)));
  }

  logger.info({ directory, fileCount: files.length }, '自动索引完成');
}

async function tryClaimInitRun(projectId: string, initType: InitType): Promise<boolean> {
  const pool = getPool();
  const updateResult = await pool.query(
    `UPDATE memory.auto_init_state
     SET last_status = 'running', last_run_at = NOW(), updated_at = NOW()
     WHERE project_id = $1 AND init_type = $2 AND last_status IN ('pending', 'failed')
     RETURNING *`,
    [projectId, initType],
  );
  if ((updateResult.rowCount ?? 0) > 0) return true;

  // 首次运行无记录时，INSERT 抢占（冲突则说明已被其他实例抢占）
  const insertResult = await pool.query(
    `INSERT INTO memory.auto_init_state (project_id, init_type, last_run_at, last_status, last_result, run_count)
     VALUES ($1, $2, NOW(), 'running', '{}', 1)
     ON CONFLICT (project_id, init_type) DO NOTHING
     RETURNING *`,
    [projectId, initType],
  );
  return (insertResult.rowCount ?? 0) > 0;
}

async function getInitStates(projectId: string): Promise<InitState[]> {
  const pool = getPool();
  const { rows } = await pool.query<InitState>(
    'SELECT init_type, last_status, last_run_at, run_count FROM memory.auto_init_state WHERE project_id = $1',
    [projectId],
  );
  return rows;
}

async function updateState(
  projectId: string,
  initType: InitType,
  status: string,
  result: Record<string, unknown>,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO memory.auto_init_state (project_id, init_type, last_run_at, last_status, last_result, run_count)
     VALUES ($1, $2, NOW(), $3, $4, 1)
     ON CONFLICT (project_id, init_type)
     DO UPDATE SET last_run_at = NOW(), last_status = $3, last_result = $4,
                   run_count = memory.auto_init_state.run_count + 1, updated_at = NOW()`,
    [projectId, initType, status, JSON.stringify(result)],
  );
}

async function runWithState(
  projectId: string,
  initType: InitType,
  fn: () => Promise<void>,
): Promise<void> {
  await updateState(projectId, initType, 'running', {});
  try {
    await fn();
    await updateState(projectId, initType, 'success', { completedAt: new Date().toISOString() });
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ initType, err: msg }, '自动初始化任务失败');
    await updateState(projectId, initType, 'failed', { error: msg });
  }
}
