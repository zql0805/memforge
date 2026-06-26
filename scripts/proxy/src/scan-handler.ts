// Created by dev on 2026/06/11
// Copyright © 2026
// 扫描请求处理 — 调用 scanner.ts 统一引擎，上传结果到 Gateway

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { scanTopology } from '../../../packages/memory-service/src/tools/topology/scanner.js';
import type { RegistryData, ScanResult } from '../../../packages/memory-service/src/tools/topology/types.js';
import { GATEWAY_URL, API_KEY, getIdeRegistryDir, log } from './config.js';

type WsSend = (msg: Record<string, unknown>) => void;

interface ScanArgs {
  product_line?: string;
  scan_roots?: string[];
  git_patterns?: string[];
  skip_scan?: boolean;
  force?: boolean;
  domain_aliases?: Record<string, string>;
  single_repo?: boolean;
}

/**
 * 加载本地已有注册表（如不存在返回 null）
 */
function loadExistingRegistry(productLine: string): RegistryData | null {
  const registryPath = join(getIdeRegistryDir(), `${productLine}-registry.json`);
  if (!existsSync(registryPath)) return null;
  try {
    return JSON.parse(readFileSync(registryPath, 'utf-8')) as RegistryData;
  } catch {
    return null;
  }
}

/**
 * 将单仓库扫描结果 merge 到已有注册表
 * - repos: 更新/新增当前仓库的条目
 * - edges: 替换当前仓库相关的边，保留其他
 * - interfaces: 替换当前仓库的 fromRepoId 接口，保留其他
 * - moaRegistry: 替换当前仓库的 provider 条目，保留其他
 */
function mergeIntoRegistry(existing: RegistryData, singleResult: ScanResult): RegistryData {
  const scannedRepoIds = new Set(Object.keys(singleResult.registry.repos));

  // 合并 repos
  Object.assign(existing.repos, singleResult.registry.repos);

  // 合并 edges：移除旧的 from/to 涉及本次扫描仓库的边，加入新的
  existing.edges = existing.edges.filter(
    e => !scannedRepoIds.has(e.from),
  );
  existing.edges.push(...singleResult.registry.edges);

  // 合并 interfaces
  if (singleResult.registry.interfaces) {
    existing.interfaces = (existing.interfaces ?? []).filter(
      i => !scannedRepoIds.has(i.fromRepoId),
    );
    existing.interfaces.push(...singleResult.registry.interfaces);
  }

  // 合并 moaRegistry
  if (singleResult.registry.moaRegistry) {
    existing.moaRegistry = (existing.moaRegistry ?? []).filter(
      m => !scannedRepoIds.has(m.repoId),
    );
    existing.moaRegistry.push(...singleResult.registry.moaRegistry);
  }

  // 合并 groups
  Object.assign(existing.groups, singleResult.registry.groups);

  existing.generatedAt = new Date().toISOString();
  return existing;
}

export async function execScanTopology(
  args: ScanArgs,
  taskId: string | null,
  wsSend: WsSend,
): Promise<Record<string, unknown>> {
  const reportProgress = (phase: string, detail: string, percent: number) => {
    if (taskId) wsSend({ type: 'scan_progress', taskId, progress: { phase, detail, percent } });
  };

  const productLine = args.product_line;
  if (!productLine) return { success: false, error: '缺少 product_line 参数' };

  if (args.skip_scan) {
    return await importExistingRegistry(productLine);
  }

  const scanRoots = (args.scan_roots ?? []).map(r =>
    r.startsWith('~') ? join(homedir(), r.slice(1)) : r,
  );
  if (scanRoots.length === 0) {
    return { success: false, error: '缺少 scan_roots 参数（代码扫描根目录列表）' };
  }

  const isSingleRepo = !!args.single_repo;
  let existingRegistry: RegistryData | null = null;

  if (isSingleRepo) {
    existingRegistry = loadExistingRegistry(productLine);
    if (existingRegistry) {
      log(`[单仓库] 已加载现有注册表: ${Object.keys(existingRegistry.repos).length} 个仓库, ${existingRegistry.moaRegistry?.length ?? 0} 条 MOA 注册`);
    } else {
      log(`[单仓库] 未找到现有注册表，provider 信息不可用`);
    }
  }

  log(`开始本地扫描: product_line=${productLine}, roots=${scanRoots.join(', ')}${isSingleRepo ? ' (单仓库模式)' : ''}`);

  try {
    const t0 = Date.now();
    const result = await scanTopology({
      productLine,
      scanRoots,
      gitPatterns: args.git_patterns,
      domainAliases: args.domain_aliases,
      outputPath: getIdeRegistryDir(),
      onProgress: reportProgress,
      singleRepo: isSingleRepo,
      existingRegistry: existingRegistry ?? undefined,
    });
    const scanMs = Date.now() - t0;
    log(`[TIMING] 本地扫描完成: ${scanMs}ms`);

    // 单仓库模式：merge 到已有注册表
    let registryToUpload = result.registry;
    if (isSingleRepo && existingRegistry) {
      registryToUpload = mergeIntoRegistry(existingRegistry, result);
      const outputDir = getIdeRegistryDir();
      if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
      const mergedPath = join(outputDir, `${productLine}-registry.json`);
      writeFileSync(mergedPath, JSON.stringify(registryToUpload, null, 2), 'utf-8');
      log(`[单仓库] 合并后注册表已保存: ${Object.keys(registryToUpload.repos).length} 个仓库`);
    }

    reportProgress('上传结果', '上传拓扑数据到服务器', 96);
    const tUpload = Date.now();
    const importResult = await postRegistryToServer(registryToUpload, productLine);
    const uploadMs = Date.now() - tUpload;
    log(`[TIMING] 上传到服务器: ${uploadMs}ms`);

    reportProgress('完成', `扫描完成: ${result.repoCount} 个仓库, ${result.edgeCount} 条边`, 100);
    const totalMs = Date.now() - t0;
    log(`[TIMING] 总计: ${totalMs}ms (扫描=${scanMs}ms, 上传=${uploadMs}ms)`);

    return {
      success: true,
      product_line: productLine,
      repos_found: result.repoCount,
      edges_found: result.edgeCount,
      registry_path: result.filePath,
      import_result: importResult,
      single_repo: isSingleRepo,
      timing: { scan_ms: scanMs, upload_ms: uploadMs, total_ms: totalMs },
    };
  } catch (err: any) {
    log(`扫描失败: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function postRegistryToServer(
  registry: RegistryData,
  productLine: string,
): Promise<Record<string, unknown>> {
  try {
    const resp = await fetch(`${GATEWAY_URL.replace(/\/$/, '')}/api/topology/${productLine}/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        repos: registry.repos,
        edges: registry.edges,
        groups: registry.groups,
        interfaces: registry.interfaces,
        moaRegistry: registry.moaRegistry,
        force: true,
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return { success: false, error: `HTTP ${resp.status}: ${txt}` };
    }
    return await resp.json() as Record<string, unknown>;
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function importExistingRegistry(productLine: string): Promise<Record<string, unknown>> {
  const registryPath = join(getIdeRegistryDir(), `${productLine}-registry.json`);
  if (!existsSync(registryPath)) {
    return { success: false, error: `注册表文件不存在: ${registryPath}` };
  }
  try {
    const data = JSON.parse(readFileSync(registryPath, 'utf-8'));

    const resp = await fetch(`${GATEWAY_URL.replace(/\/$/, '')}/api/topology/${productLine}/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ repos: data.repos ?? {}, edges: data.edges ?? [], force: false }),
    });
    if (!resp.ok) {
      return { success: false, error: `导入失败 HTTP ${resp.status}` };
    }
    return { success: true, ...(await resp.json() as Record<string, unknown>) };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
