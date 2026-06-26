// Created by dev on 2026/04/05
// Copyright © 2026
// 拓扑自动同步：发现注册表文件 → 监控变化 → 自动导入记忆

import { watch, readdir, readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { getLogger, getIdeConfig } from '@memforgeai/shared';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';
import type { ToolContext } from '../tools/types.js';

const logger = getLogger('auto:topology-sync');
const DEBOUNCE_MS = 2000;

interface RegistryInfo {
  filePath: string;
  productLine: string;
  serviceCount: number;
  edgeCount: number;
  lastImportedHash: string;
}

interface TopologySyncState {
  active: boolean;
  controller: AbortController;
  registries: Map<string, RegistryInfo>;
  importCount: number;
}

let syncState: TopologySyncState | null = null;

/**
 * 启动拓扑自动同步
 * C1 增强: 支持 Skills 目录扫描 + 变更事件回调
 */
export async function startTopologyAutoSync(ctx: ToolContext): Promise<void> {
  const ideConfig = getIdeConfig();
  const configDir = ideConfig.configDir;

  const autoTopology = process.env.MEMFORGE_AUTO_TOPOLOGY;
  if (autoTopology === 'false') {
    logger.info('拓扑自动同步已禁用 (MEMFORGE_AUTO_TOPOLOGY=false)');
    return;
  }

  try {
    await stat(configDir);
  } catch {
    logger.info({ configDir }, `${configDir} 目录不存在，跳过拓扑自动同步`);
    return;
  }

  const controller = new AbortController();
  syncState = {
    active: true,
    controller,
    registries: new Map(),
    importCount: 0,
  };

  // 1. 初始发现并导入
  const registries = await discoverRegistryFiles(configDir);

  if (registries.length === 0) {
    logger.info('未发现拓扑注册表文件，仅启动目录监控');
  } else {
    logger.info({ count: registries.length }, '发现拓扑注册表，开始初始导入');

    for (const reg of registries) {
      const hash = simpleHash(JSON.stringify(reg.data));
      syncState.registries.set(reg.filePath, {
        filePath: reg.filePath,
        productLine: reg.productLine,
        serviceCount: reg.serviceCount,
        edgeCount: reg.edgeCount,
        lastImportedHash: hash,
      });

      await importRegistryToMemory(ctx, reg);
      syncState.importCount++;
    }

    logger.info({ imported: syncState.importCount }, '拓扑初始导入完成');
  }

  // 2. 启动后台监控（注册表 + topology-custom.json 变更自动触发）
  startRegistryWatcher(configDir, ctx).catch((err: Error) => {
    logger.error({ err: err.message }, '拓扑注册表监控异常退出');
  });

  // C1 增强: 同时监控 topology-custom.json，变更时自动触发 apply-custom + 重新导入
  startCustomTopologyWatcher(configDir, ctx).catch((err: Error) => {
    logger.warn({ err: err.message }, 'topology-custom 监控启动失败（不影响主服务）');
  });
}

/**
 * 停止拓扑自动同步
 */
export function stopTopologyAutoSync(): void {
  if (syncState?.active) {
    syncState.controller.abort();
    syncState.active = false;
    logger.info('拓扑自动同步已停止');
  }
}

/**
 * 获取当前同步状态
 */
export function getTopologySyncStatus(): {
  active: boolean;
  registries: number;
  importCount: number;
} {
  return {
    active: syncState?.active ?? false,
    registries: syncState?.registries.size ?? 0,
    importCount: syncState?.importCount ?? 0,
  };
}

async function discoverRegistryFiles(configDir: string): Promise<Array<{
  filePath: string;
  productLine: string;
  serviceCount: number;
  edgeCount: number;
  data: Record<string, unknown>;
}>> {
  const results: Array<{
    filePath: string;
    productLine: string;
    serviceCount: number;
    edgeCount: number;
    data: Record<string, unknown>;
  }> = [];

  try {
    const entries = await readdir(configDir);
    for (const entry of entries) {
      if (!entry.endsWith('-registry.json')) continue;

      const filePath = join(configDir, entry);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const data = JSON.parse(raw);
        if (data.repos && data.productLine) {
          results.push({
            filePath,
            productLine: data.productLine,
            serviceCount: Object.keys(data.repos).length,
            edgeCount: data.edges?.length ?? 0,
            data,
          });
        }
      } catch {
        logger.warn({ file: entry }, '注册表文件解析失败');
      }
    }
  } catch {
    logger.debug({ configDir }, '读取拓扑注册表目录失败，跳过');
  }

  return results;
}

async function startRegistryWatcher(configDir: string, ctx: ToolContext): Promise<void> {
  if (!syncState) return;

  const watcher = watch(configDir, { signal: syncState.controller.signal });
  const pendingFiles = new Map<string, NodeJS.Timeout>();

  for await (const event of watcher) {
    if (!syncState?.active) break;

    const filename = event.filename;
    if (!filename || !filename.endsWith('-registry.json')) continue;

    const existing = pendingFiles.get(filename);
    if (existing) clearTimeout(existing);

    pendingFiles.set(filename, setTimeout(() => {
      pendingFiles.delete(filename);
      handleRegistryChange(join(configDir, filename), ctx).catch((err: Error) => {
        logger.warn({ file: filename, err: err.message }, '处理注册表变化时出错');
      });
    }, DEBOUNCE_MS));
  }
}

async function handleRegistryChange(filePath: string, ctx: ToolContext): Promise<void> {
  if (!syncState) return;

  let fileExists = true;
  try {
    await stat(filePath);
  } catch {
    fileExists = false;
  }

  if (!fileExists) {
    const info = syncState.registries.get(filePath);
    if (info) {
      logger.info({ file: basename(filePath), productLine: info.productLine }, '注册表文件已删除');
      syncState.registries.delete(filePath);
    }
    return;
  }

  try {
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.repos || !data.productLine) return;

    const newHash = simpleHash(raw);
    const existing = syncState.registries.get(filePath);

    if (existing && existing.lastImportedHash === newHash) {
      return;
    }

    logger.info({
      file: basename(filePath),
      productLine: data.productLine,
      services: Object.keys(data.repos).length,
    }, '检测到注册表更新，开始重新导入');

    // 归档旧的拓扑记忆
    const plTag = `pl:${(data.productLine as string).toLowerCase()}`;
    await ctx.storage.archiveByTag(plTag, `拓扑注册表已更新 (${basename(filePath)})`);

    await importRegistryToMemory(ctx, {
      filePath,
      productLine: data.productLine,
      serviceCount: Object.keys(data.repos).length,
      edgeCount: data.edges?.length ?? 0,
      data,
    });

    syncState.registries.set(filePath, {
      filePath,
      productLine: data.productLine,
      serviceCount: Object.keys(data.repos).length,
      edgeCount: data.edges?.length ?? 0,
      lastImportedHash: newHash,
    });

    syncState.importCount++;
    logger.info({ file: basename(filePath), productLine: data.productLine }, '拓扑注册表重新导入完成');
  } catch (err) {
    logger.warn({ file: basename(filePath), err: (err as Error).message }, '注册表变化处理失败');
  }
}

async function importRegistryToMemory(
  ctx: ToolContext,
  reg: {
    filePath: string;
    productLine: string;
    serviceCount: number;
    edgeCount: number;
    data: Record<string, unknown>;
  },
): Promise<void> {
  const projectId = reg.productLine.toLowerCase();
  const branchId = null;
  const data = reg.data as {
    repos: Record<string, { desc?: string; lang: string; layer: number; group: string }>;
    edges?: Array<{ from: string; to: string; label: string }>;
    groups?: Record<string, { label: string; layer: number }>;
    generatedAt?: string;
    rootDir?: string;
  };

  // 全景概览
  const langStats = new Map<string, number>();
  for (const repo of Object.values(data.repos)) {
    langStats.set(repo.lang, (langStats.get(repo.lang) ?? 0) + 1);
  }
  const langSummary = [...langStats.entries()].sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}:${c}`).join(' ');

  const overviewContent = [
    `产品线: ${reg.productLine}`,
    `服务总数: ${reg.serviceCount}`,
    `调用关系: ${reg.edgeCount} 条`,
    `技术栈: ${langSummary}`,
    `生成时间: ${data.generatedAt ?? 'unknown'}`,
  ].join('\n');

  await storeEntry(ctx, projectId, branchId, {
    title: `[拓扑] ${reg.productLine} 全景 (${reg.serviceCount} 服务)`,
    content: overviewContent,
    tags: ['topology', 'overview', `pl:${projectId}`],
  });

  // 按层导入
  const layers = new Map<number, string[]>();
  for (const [repoId, repo] of Object.entries(data.repos)) {
    if (!layers.has(repo.layer)) layers.set(repo.layer, []);
    layers.get(repo.layer)!.push(`${repo.desc ?? repoId} [${repo.lang}]`);
  }

  for (const [layer, services] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    const groupLabel = findGroupLabel(layer, data.groups ?? {});
    await storeEntry(ctx, projectId, branchId, {
      title: `[拓扑·L${layer}] ${reg.productLine} ${groupLabel} (${services.length})`,
      content: `层级: L${layer} - ${groupLabel}\n\n${services.join('\n')}`,
      tags: ['topology', `layer:${layer}`, `pl:${projectId}`],
    });
  }

  // 按协议导入调用链
  if (data.edges && data.edges.length > 0) {
    const byProto = new Map<string, string[]>();
    for (const edge of data.edges) {
      const key = edge.label || 'unknown';
      if (!byProto.has(key)) byProto.set(key, []);
      const fromDesc = data.repos[edge.from]?.desc ?? edge.from;
      const toDesc = data.repos[edge.to]?.desc ?? edge.to;
      byProto.get(key)!.push(`${fromDesc} → ${toDesc}`);
    }

    for (const [protocol, lines] of byProto) {
      await storeEntry(ctx, projectId, branchId, {
        title: `[拓扑·调用] ${reg.productLine} ${protocol} (${lines.length} 条)`,
        content: `协议: ${protocol}\n\n${lines.join('\n')}`,
        tags: ['topology', 'call-graph', `pl:${projectId}`, `protocol:${protocol.toLowerCase().replace(/\s+/g, '-')}`],
      });
    }
  }
}

async function storeEntry(
  ctx: ToolContext,
  projectId: string,
  branchId: string | null,
  entry: { title: string; content: string; tags: string[] },
): Promise<void> {
  const scanResult = ctx.scanner.scan(entry.content);
  if (scanResult.blocked) return;

  const finalContent = scanResult.sanitizedContent ?? entry.content;
  const embedding = await ctx.embedding.embedPassage(`${entry.title} ${finalContent}`);

  const dup = await ctx.storage.checkDuplicate(embedding, 0.90);
  if (dup) return;

  await ctx.storage.store({
    projectId,
    branchId,
    title: entry.title,
    content: finalContent,
    scope: 'architecture' as MemoryScope,
    source: 'ai_suggestion' as MemorySource,
    tags: entry.tags,
    embedding,
    metadata: {
      importedFrom: 'topology-auto-sync',
      importedAt: new Date().toISOString(),
    },
    isArchived: false,
    archivedReason: null,
    createdBy: ctx.userId,
    expiresAt: null,
  });
}

function findGroupLabel(layer: number, groups: Record<string, { label: string; layer: number }>): string {
  const labels: string[] = [];
  for (const g of Object.values(groups)) {
    if (g.layer === layer && !labels.includes(g.label)) labels.push(g.label);
  }
  return labels.length > 0 ? labels.join(' / ') : `Layer ${layer}`;
}

/**
 * C1 增强: 监控 topology-custom.json 变更
 * 当 apply-custom.sh 脚本更新注册表后，自动触发重新导入
 */
async function startCustomTopologyWatcher(configDir: string, ctx: ToolContext): Promise<void> {
  if (!syncState) return;

  const customFile = join(configDir, 'topology-custom.json');
  try {
    await stat(customFile);
  } catch {
    return;
  }

  const watcher = watch(configDir, { signal: syncState.controller.signal });
  let pendingTimeout: NodeJS.Timeout | null = null;

  for await (const event of watcher) {
    if (!syncState?.active) break;
    if (event.filename !== 'topology-custom.json') continue;

    if (pendingTimeout) clearTimeout(pendingTimeout);
    pendingTimeout = setTimeout(async () => {
      pendingTimeout = null;
      logger.info('检测到 topology-custom.json 变更，等待注册表更新后重新导入');
      // 给 apply-custom.sh 足够的执行时间
      await new Promise(resolve => setTimeout(resolve, 5000));

      const freshRegistries = await discoverRegistryFiles(configDir);
      for (const reg of freshRegistries) {
        const newHash = simpleHash(JSON.stringify(reg.data));
        const existing = syncState?.registries.get(reg.filePath);
        if (existing && existing.lastImportedHash === newHash) continue;

        logger.info({ productLine: reg.productLine }, '自定义拓扑变更触发重新导入');
        await importRegistryToMemory(ctx, reg);

        syncState?.registries.set(reg.filePath, {
          filePath: reg.filePath,
          productLine: reg.productLine,
          serviceCount: reg.serviceCount,
          edgeCount: reg.edgeCount,
          lastImportedHash: newHash,
        });
        if (syncState) syncState.importCount++;
      }
    }, DEBOUNCE_MS);
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}
