// Created by dev on 2026/04/06
// Copyright © 2026
// MCP 工具: scan_topology — 内置拓扑扫描引擎 + 自动导入记忆库
// 完全内置，不依赖外部 skill/脚本

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getLogger, getIdeConfig, createRulesAdapter, validateScanPath } from '@memforgeai/shared';
import type { RuleFile } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';
import { scanTopology as runTopologyScan } from './topology/index.js';
import type { ScanOptions, RegistryData } from './topology/index.js';
import { TopologyStore } from '../storage/topology-store.js';
import { indexApiDocsForRepo } from './index-api-docs.js';
import type { IndexApiDocsResult } from './index-api-docs.js';

const logger = getLogger('tool:scan-topology');

/**
 * 已知产品线的默认扫描配置（通过环境变量或 WebUI 管理，此处不硬编码）
 */
const KNOWN_PRODUCT_LINES: Record<string, {
  scanRoots: string[];
  gitPatterns: string[];
}> = {};

export function registerScanTopology(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'scan_topology',
    '产品线拓扑扫描：自动发现 Git 仓库、检测技术栈和依赖关系、生成架构注册表并导入记忆库。完全内置，无需外部脚本。',
    {
      product_line: z.string().optional().describe('产品线名称。必须指定。'),
      scan_roots: z.array(z.string()).optional().describe('代码扫描根目录列表。留空则使用产品线默认配置。'),
      git_patterns: z.array(z.string()).optional().describe('Git remote URL 过滤模式。留空则不过滤。'),
      domain_aliases: z.record(z.string()).optional().describe('域名→repoId 别名映射，用于域名无法自动反查仓库的场景。如 {"ticket.example.com": "group/web-interface"}'),
      skip_scan: z.boolean().default(false).describe('跳过扫描步骤，仅从已有注册表导入'),
      force: z.boolean().default(false).describe('强制重新扫描（忽略已有注册表缓存）'),
    },
    async ({ product_line, scan_roots, git_patterns, domain_aliases, skip_scan, force }) => {
      const ideConfig = getIdeConfig();
      const home = process.env.HOME ?? '';
      const userId = ctx.userId;
      const userRole = ctx.userRole;
      const deviceId = ctx.deviceId ?? undefined;

      // force 模式仅限 admin/lead
      if (force && userRole && !['admin', 'lead'].includes(userRole)) {
        return text('强制扫描（force=true）仅限 admin/lead 角色执行。请使用普通扫描（force=false）。');
      }

      // 模式 A: 跳过扫描，直接从已有注册表导入
      if (skip_scan) {
        return await importExistingRegistries(ctx, product_line);
      }

      // 模式 B: 内置扫描
      if (scan_roots) {
        for (const root of scan_roots) {
          try {
            validateScanPath(root);
          } catch (err) {
            return text((err as Error).message);
          }
        }
      }

      const scanConfigs = buildScanConfigs(product_line, scan_roots, git_patterns);
      if (scanConfigs.length === 0) {
        return text(
          '无法确定扫描配置。请提供以下参数：\n\n'
          + '- product_line: 产品线名称（必填）\n'
          + '- scan_roots: 代码扫描根目录列表（必填）\n\n'
          + '示例：scan_topology({ product_line: "myapp", scan_roots: ["~/work/myapp"] })',
        );
      }

      const allResults: Array<{
        productLine: string;
        repoCount: number;
        edgeCount: number;
        filePath: string;
        stored: number;
        userPathsUpdated: number;
        mode: 'force' | 'additive' | 'cached';
      }> = [];

      for (const config of scanConfigs) {
        // 检查是否有未过期的注册表（7 天内）
        if (!force) {
          const existing = await findExistingRegistry(config.productLine);
          if (existing && isRecent(existing.generatedAt, 7)) {
            logger.info({ productLine: config.productLine }, '注册表未过期，跳过扫描');
            const stored = await importRegistryToMemory(ctx, existing);
            let userPathsUpdated = 0;
            try {
              const topoStore = new TopologyStore();
              await topoStore.importNewRepos(existing, userId ?? undefined);
            // 写入当前用户的本地路径
            if (userId) {
              const paths = Object.entries(existing.repos)
                .filter(([, r]) => r.localPath)
                .map(([id, r]) => ({ repoId: id, localPath: r.localPath }));
              userPathsUpdated = await topoStore.upsertUserPaths(userId, config.productLine, paths, deviceId);
              const validRepoIds = paths.map(p => p.repoId);
              await topoStore.cleanupStaleUserPaths(userId, config.productLine, validRepoIds, deviceId);
            }
          } catch (dbErr) {
            logger.error({ err: dbErr, productLine: config.productLine }, '缓存注册表结构化表导入失败');
          }
            allResults.push({
              productLine: config.productLine,
              repoCount: Object.keys(existing.repos).length,
              edgeCount: existing.edges?.length ?? 0,
              filePath: join(ideConfig.registryDir, `${config.productLine}-registry.json`),
              stored,
              userPathsUpdated,
              mode: 'cached',
            });
            continue;
          }
        }

        try {
          logger.info({ productLine: config.productLine, roots: config.scanRoots, force }, '开始内置拓扑扫描');

          const result = await runTopologyScan({
            productLine: config.productLine,
            scanRoots: config.scanRoots,
            gitPatterns: config.gitPatterns,
            domainAliases: domain_aliases,
          });

          logger.info({
            productLine: config.productLine,
            repos: result.repoCount,
            edges: result.edgeCount,
          }, '拓扑扫描完成');

          const stored = await importRegistryToMemory(ctx, result.registry);
          let userPathsUpdated = 0;

          try {
            const topoStore = new TopologyStore();
            if (force) {
              await topoStore.importFromRegistry(result.registry, userId ?? undefined);
              await topoStore.cleanupOrphanedByUser(config.productLine, userId, Object.keys(result.registry.repos));
            } else {
              await topoStore.importNewRepos(result.registry, userId ?? undefined);
            }
            // 写入当前用户的本地路径
            if (userId) {
              const paths = Object.entries(result.registry.repos)
                .filter(([, r]) => r.localPath)
                .map(([id, r]) => ({ repoId: id, localPath: r.localPath }));
              userPathsUpdated = await topoStore.upsertUserPaths(userId, config.productLine, paths, deviceId);
              // 清理本次扫描中不再出现的旧路径（如删除的目录）
              const validRepoIds = paths.map(p => p.repoId);
              await topoStore.cleanupStaleUserPaths(userId, config.productLine, validRepoIds, deviceId);
            }
          } catch (dbErr) {
            logger.warn({ err: (dbErr as Error).message }, '拓扑结构化表导入失败（不影响主流程）');
          }

          allResults.push({
            productLine: config.productLine,
            repoCount: result.repoCount,
            edgeCount: result.edgeCount,
            filePath: result.filePath,
            stored,
            userPathsUpdated,
            mode: force ? 'force' : 'additive',
          });
        } catch (err) {
          logger.error({ err: (err as Error).message, productLine: config.productLine }, '拓扑扫描失败');
          allResults.push({
            productLine: config.productLine,
            repoCount: 0,
            edgeCount: 0,
            filePath: '',
            stored: 0,
            userPathsUpdated: 0,
            mode: force ? 'force' : 'additive',
          });
        }
      }

      // 生成 .mdc 规则文件（每个已扫描产品线）
      const mdcFiles: string[] = [];
      for (const r of allResults) {
        if (r.repoCount > 0) {
          const mdcPath = await generateLocalPathsRule(r.productLine, userId, deviceId);
          if (mdcPath) mdcFiles.push(mdcPath);
        }
      }

      // 自动索引公共库/基础设施层的 API 文档
      const apiIndexResults = await autoIndexFrameworkApis(ctx, scanConfigs, allResults);

      // 自动触发 Git 历史导入（对新发现且未做过 bootstrap 的仓库）
      const bootstrapTriggered = await autoTriggerBootstrap(ctx, scanConfigs, allResults);

      const summary = {
        engine: 'memforge-builtin',
        scanned: allResults.length,
        results: allResults,
        totalRepos: allResults.reduce((s, r) => s + r.repoCount, 0),
        totalEdges: allResults.reduce((s, r) => s + r.edgeCount, 0),
        totalStored: allResults.reduce((s, r) => s + r.stored, 0),
        totalUserPaths: allResults.reduce((s, r) => s + r.userPathsUpdated, 0),
        mdcRulesGenerated: mdcFiles,
        apiIndex: apiIndexResults.length > 0 ? {
          indexed: apiIndexResults.length,
          totalStored: apiIndexResults.reduce((s, r) => s + r.stored, 0),
          details: apiIndexResults,
        } : undefined,
        bootstrap: bootstrapTriggered > 0 ? {
          triggered: bootstrapTriggered,
          message: `已为 ${bootstrapTriggered} 个仓库启动后台 Git 历史导入`,
        } : undefined,
      };

      return text(JSON.stringify(summary, null, 2));
    },
  );
}

// ─── 辅助函数 ─────────────────────────────────────────────

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

interface ScanConfig {
  productLine: string;
  scanRoots: string[];
  gitPatterns: string[];
}

function buildScanConfigs(
  productLine?: string,
  scanRoots?: string[],
  gitPatterns?: string[],
): ScanConfig[] {
  // 指定了 product_line
  if (productLine) {
    const known = KNOWN_PRODUCT_LINES[productLine.toLowerCase()];
    return [{
      productLine: productLine.toLowerCase(),
      scanRoots: scanRoots ?? known?.scanRoots ?? [],
      gitPatterns: gitPatterns ?? known?.gitPatterns ?? [],
    }];
  }

  // 未指定 product_line 但给了 scan_roots → 需要一个名字
  if (scanRoots && scanRoots.length > 0) {
    return []; // 需要 product_line 才能生成注册表文件名
  }

  // 全都没给 → 扫描所有已知产品线
  return Object.entries(KNOWN_PRODUCT_LINES).map(([pl, config]) => ({
    productLine: pl,
    ...config,
  }));
}

async function findExistingRegistry(productLine: string): Promise<RegistryData | null> {
  const ideConfig = getIdeConfig();
  const filePath = join(ideConfig.registryDir, `${productLine}-registry.json`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as RegistryData;
  } catch {
    return null;
  }
}

function isRecent(isoDate: string, days: number): boolean {
  try {
    const d = new Date(isoDate);
    const now = new Date();
    return (now.getTime() - d.getTime()) < days * 86400000;
  } catch {
    return false;
  }
}

// ─── 导入注册表到记忆库 ──────────────────────────────────

async function importRegistryToMemory(ctx: ToolContext, registry: RegistryData): Promise<number> {
  const projectId = ctx.gitContext?.projectName ?? 'default';
  const branchId = null;
  let stored = 0;

  const serviceCount = Object.keys(registry.repos).length;
  const edgeCount = registry.edges?.length ?? 0;

  // 导入全景概要
  const overviewContent = buildOverview(registry, serviceCount, edgeCount);
  if (await storeIfNew(ctx, projectId, branchId, {
    title: `[拓扑·全景] ${registry.productLine} 服务架构 (${serviceCount} 服务, ${edgeCount} 调用)`,
    content: overviewContent,
    tags: ['topology', 'overview', `pl:${registry.productLine.toLowerCase()}`],
  })) stored++;

  // 按协议导入调用关系
  if (registry.edges && registry.edges.length > 0) {
    const byProtocol = new Map<string, Array<{ from: string; to: string }>>();
    for (const edge of registry.edges) {
      const key = edge.label || 'unknown';
      if (!byProtocol.has(key)) byProtocol.set(key, []);
      byProtocol.get(key)!.push(edge);
    }

    for (const [protocol, edges] of byProtocol) {
      const lines = edges.map(e => {
        const fromName = safeRepoName(e.from, registry);
        const toName = safeRepoName(e.to, registry);
        return `${fromName} (${e.from}) → ${toName} (${e.to})`;
      });
      const content = `产品线: ${registry.productLine}\n协议: ${protocol}\n调用数: ${edges.length}\n\n${lines.join('\n')}`;
      if (await storeIfNew(ctx, projectId, branchId, {
        title: `[拓扑·调用链] ${registry.productLine} ${protocol} (${edges.length} 条)`,
        content,
        tags: ['topology', 'call-graph', `pl:${registry.productLine.toLowerCase()}`, `protocol:${protocol.toLowerCase().replace(/\s+/g, '-')}`],
      })) stored++;
    }
  }

  // 按层导入服务列表
  const layers = new Map<number, string[]>();
  for (const [repoId, repo] of Object.entries(registry.repos)) {
    if (!layers.has(repo.layer)) layers.set(repo.layer, []);
    const name = safeRepoName(repoId, registry);
    layers.get(repo.layer)!.push(`${name} [${repo.lang}] (${repoId})`);
  }

  for (const [layer, services] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    const groupLabel = findGroupLabel(layer, registry.groups ?? {});
    // 与 Web UI parseLayers 格式 1 对齐：「--- 第 n 层: 名 (N 服务) ---」+ 缩进服务行，避免仅「层级:」正文导致分层图为空
    const layerNo = Number(layer) + 1;
    const header = `--- 第 ${layerNo} 层: ${groupLabel} (${services.length} 服务) ---`;
    const body = services.map((line) => `  ${line}`).join('\n');
    const content = `产品线: ${registry.productLine}\n层级: L${layer} - ${groupLabel}\n服务数: ${services.length}\n\n${header}\n\n${body}`;
    if (await storeIfNew(ctx, projectId, branchId, {
      title: `[拓扑·L${layer}] ${registry.productLine} ${groupLabel} (${services.length} 服务)`,
      content,
      tags: ['topology', `layer:${layer}`, `pl:${registry.productLine.toLowerCase()}`],
    })) stored++;
  }

  return stored;
}

async function importExistingRegistries(
  ctx: ToolContext,
  productLine?: string,
): Promise<ReturnType<typeof text>> {
  const ideConfig = getIdeConfig();
  const configDir = ideConfig.configDir;
  const results: Array<{ productLine: string; stored: number; userPathsUpdated: number }> = [];
  const userId = ctx.userId;
  const deviceId = ctx.deviceId ?? undefined;

  try {
    const entries = await readdir(configDir);
    for (const entry of entries) {
      if (!entry.endsWith('-registry.json')) continue;
      const filePath = join(configDir, entry);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const data = JSON.parse(raw) as RegistryData;
        if (!data.repos || !data.productLine) continue;
        if (productLine && data.productLine.toLowerCase() !== productLine.toLowerCase()) continue;

        const stored = await importRegistryToMemory(ctx, data);
        let userPathsUpdated = 0;
        try {
          const topoStore = new TopologyStore();
          await topoStore.importNewRepos(data, userId ?? undefined);
          if (userId) {
            const paths = Object.entries(data.repos)
              .filter(([, r]) => r.localPath)
              .map(([id, r]) => ({ repoId: id, localPath: r.localPath }));
            userPathsUpdated = await topoStore.upsertUserPaths(userId, data.productLine, paths, deviceId);
            const validRepoIds = paths.map(p => p.repoId);
            await topoStore.cleanupStaleUserPaths(userId, data.productLine, validRepoIds, deviceId);
          }
        } catch (dbErr) {
          logger.error({ err: dbErr, productLine: data.productLine, filePath }, '注册表结构化表导入失败');
        }
        results.push({ productLine: data.productLine, stored, userPathsUpdated });
      } catch {
        logger.warn({ file: filePath }, '注册表解析失败');
      }
    }
  } catch (err) {
    logger.error({ err, configDir }, '读取 IDE 配置目录失败');
  }

  if (results.length === 0) {
    return text('未找到任何注册表文件。请先执行 scan_topology 进行扫描。');
  }

  // 重新生成 .mdc 规则文件（确保与 DB 数据一致）
  const mdcFiles: string[] = [];
  for (const r of results) {
    const mdcPath = await generateLocalPathsRule(r.productLine, userId, deviceId);
    if (mdcPath) mdcFiles.push(mdcPath);
  }

  return text(JSON.stringify({
    mode: 'import-only',
    results,
    totalStored: results.reduce((s, r) => s + r.stored, 0),
    totalUserPaths: results.reduce((s, r) => s + r.userPathsUpdated, 0),
    mdcRulesGenerated: mdcFiles,
  }, null, 2));
}

// ─── scan → bootstrap 联动 ──────────────────────────────────

/**
 * 扫描完成后，对新发现且未做过 bootstrap 的仓库自动触发历史导入（异步、限并发）
 */
async function autoTriggerBootstrap(
  ctx: ToolContext,
  scanConfigs: ScanConfig[],
  allResults: Array<{ productLine: string; repoCount: number; mode: string }>,
): Promise<number> {
  const MAX_CONCURRENT_BOOTSTRAP = 3;
  const productLines = allResults
    .filter(r => r.repoCount > 0 && r.mode !== 'cached')
    .map(r => r.productLine);
  if (productLines.length === 0) return 0;

  try {
    const { getPool } = await import('@memforgeai/shared');
    const pool = getPool();

    const { rows: candidates } = await pool.query<{
      repo_id: string;
      product_line: string;
      local_path: string;
    }>(
      `SELECT tn.repo_id, tn.product_line, COALESCE(tup.local_path, tn.local_path) AS local_path
       FROM memory.topology_nodes tn
       LEFT JOIN memory.topology_user_paths tup
         ON tup.product_line = tn.product_line
         AND tup.repo_id = tn.repo_id
         AND tup.user_id = $1
       WHERE tn.product_line = ANY($2)
         AND tn.is_hidden = false
         AND COALESCE(tup.local_path, tn.local_path) IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM memory.auto_init_state ais
           WHERE ais.project_id = tn.repo_id
             AND ais.init_type = 'project_bootstrap'
             AND ais.last_status IN ('success', 'running')
         )`,
      [ctx.userId, productLines],
    );

    if (candidates.length === 0) return 0;

    const { existsSync } = await import('node:fs');
    const home = process.env.HOME ?? '';
    const validRepos = candidates.filter(c => {
      const resolved = c.local_path.replace(/^~/, home);
      return existsSync(resolved);
    });

    if (validRepos.length === 0) return 0;

    const toBootstrap = validRepos.slice(0, MAX_CONCURRENT_BOOTSTRAP);
    const { runBootstrapFromApi } = await import('../tools/bootstrap-project-history.js');

    for (const repo of toBootstrap) {
      const projectRoot = repo.local_path.replace(/^~/, home);
      runBootstrapFromApi(ctx, {
        projectRoot,
        productLine: repo.product_line,
        repoId: repo.repo_id,
        depth: '6months',
        batchSize: 50,
        resume: true,
      }).catch(err => {
        logger.warn({ repo: repo.repo_id, err: (err as Error).message }, 'Auto-bootstrap 后台任务失败');
      });
    }

    logger.info({
      triggered: toBootstrap.length,
      total_candidates: validRepos.length,
    }, '扫描后自动触发 Git 历史导入');

    return toBootstrap.length;
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'Auto-bootstrap 检查失败');
    return 0;
  }
}

// ─── .mdc 规则文件生成 ──────────────────────────────────────

/**
 * 生成 <productLine>-local-paths 规则文件（格式由当前 IDE 决定）
 * 从 DB 读取共享拓扑 + 当前用户本地路径，输出到 IDE rules 目录
 */
async function generateLocalPathsRule(
  productLine: string,
  userId: string | null,
  deviceId?: string,
): Promise<string | null> {
  try {
    const store = new TopologyStore();
    const data = await store.getFullTopologyWithUserPaths(productLine, userId, deviceId);
    if (data.nodes.length === 0) return null;

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const pl = productLine.toLowerCase();

    const lines: string[] = [
      `# ${pl} 产品线本地仓库路径映射`,
      '',
      `> 自动生成时间：${dateStr}`,
      `> 注册表文件：\`${getIdeConfig().registryDir}/${pl}-registry.json\``,
      '> 本规则由 Memforge 拓扑引擎自动维护，请勿手动修改。',
      '',
      '## 使用规则',
      '',
      '当用户提问涉及以下场景时，**必须**读取对应仓库的本地代码：',
      '',
      '1. **"帮我检查 XX 服务的代码"** → 从下表找到本地路径，用 Read 工具读取',
      '2. **"全链路分析这个需求"** → 从「调用关系」表找到上下游服务，依次读取代码',
      '3. **"后台实现在哪"** → 找到管理后台相关仓库路径，读取对应 Controller',
      '4. **"这个接口下游调了什么"** → 查调用关系表，找到被调用服务的本地路径',
      '',
      '## 本地路径表',
      '',
      '| repoId（唯一标识） | 本地路径 | 技术栈 | 描述 |',
      '|---|---|---|---|',
    ];

    const home = process.env.HOME ?? '';
    for (const node of data.nodes.sort((a, b) => a.layerIndex - b.layerIndex || a.repoId.localeCompare(b.repoId))) {
      const shortPath = node.localPath
        ? node.localPath.replace(home, '~')
        : '_(未 clone)_';
      lines.push(`| \`${node.repoId}\` | \`${shortPath}\` | ${node.techStack ?? 'unknown'} | ${node.description || node.displayName} |`);
    }

    // 调用关系表
    if (data.edges.length > 0) {
      lines.push('', '## 调用关系表', '', '| 调用方 | 被调用方 | 协议 |', '|---|---|---|');
      for (const edge of data.edges.sort((a, b) => a.protocol.localeCompare(b.protocol) || a.fromRepoId.localeCompare(b.fromRepoId))) {
        lines.push(`| \`${edge.fromRepoId}\` | \`${edge.toRepoId}\` | ${edge.protocol} |`);
      }
    }

    // 按层次分组
    lines.push('', '## 按层次分组', '');
    const layerMap = new Map<number, { name: string; nodes: typeof data.nodes }>();
    for (const layer of data.layers) {
      const nodesInLayer = data.nodes.filter(n => n.layerIndex === layer.layerIndex);
      if (nodesInLayer.length > 0) {
        layerMap.set(layer.layerIndex, { name: layer.name, nodes: nodesInLayer });
      }
    }
    for (const [idx, info] of [...layerMap.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(``, `### 第 ${idx} 层：${info.name}`);
      for (const n of info.nodes) {
        const sp = n.localPath ? n.localPath.replace(home, '~') : '_(未 clone)_';
        lines.push(`- \`${sp}\` — ${n.description || n.displayName} (${n.techStack ?? '?'})`);
      }
    }

    const ideConfig = getIdeConfig();
    const rulesDir = ideConfig.rulesDir;
    const filename = `${pl}-local-paths${ideConfig.ruleExtension}`;
    const adapter = createRulesAdapter(ideConfig.ruleFormat);

    const ruleFile: RuleFile = {
      filename,
      title: `${pl} 产品线本地仓库路径映射`,
      description: `${pl} 产品线本地路径映射（Memforge 自动生成，勿手动编辑）`,
      content: '',
      body: lines.join('\n'),
      frontmatter: {
        description: `${pl} 产品线本地路径映射（Memforge 自动生成，勿手动编辑）。当 IDE 需要进行跨仓库分析、读取其他服务代码、全链路追踪时，必须优先查阅本规则获取本地路径，然后用 Read 工具直接读取。`,
        alwaysApply: true,
      },
      alwaysApply: true,
    };

    await adapter.writeRule(rulesDir, ruleFile);
    const filePath = join(rulesDir, filename);
    logger.info({ productLine: pl, filePath, ruleFormat: ideConfig.ruleFormat }, '已生成 local-paths 规则文件');
    return filePath;
  } catch (err) {
    logger.warn({ err: (err as Error).message, productLine }, '生成 local-paths 规则文件失败');
    return null;
  }
}

// ─── 共用记忆存储 ─────────────────────────────────────────

async function storeIfNew(
  ctx: ToolContext,
  projectId: string,
  branchId: string | null,
  entry: { title: string; content: string; tags: string[] },
): Promise<boolean> {
  const scanResult = ctx.scanner.scan(entry.content);
  if (scanResult.blocked) return false;

  const finalContent = scanResult.sanitizedContent ?? entry.content;
  const embedding = await ctx.embedding.embedPassage(`${entry.title} ${finalContent}`);

  const dup = await ctx.storage.checkDuplicate(embedding, 0.90);
  if (dup) return false;

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
      importedFrom: 'topology-scan',
      importedAt: new Date().toISOString(),
    },
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

function safeRepoName(repoId: string, _registry: RegistryData): string {
  return repoId.split('/').pop() ?? repoId;
}

function buildOverview(registry: RegistryData, serviceCount: number, edgeCount: number): string {
  const langStats = new Map<string, number>();
  for (const repo of Object.values(registry.repos)) {
    langStats.set(repo.lang, (langStats.get(repo.lang) ?? 0) + 1);
  }
  const langSummary = [...langStats.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => `${lang}: ${count}`)
    .join(', ');

  const protocolStats = new Map<string, number>();
  for (const edge of registry.edges ?? []) {
    protocolStats.set(edge.label, (protocolStats.get(edge.label) ?? 0) + 1);
  }
  const protocolSummary = [...protocolStats.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([proto, count]) => `${proto}: ${count}`)
    .join(', ');

  return [
    `产品线: ${registry.productLine}`,
    `服务总数: ${serviceCount}`,
    `调用关系: ${edgeCount} 条`,
    `生成时间: ${registry.generatedAt}`,
    `代码根目录: ${registry.rootDir}`,
    '',
    `技术栈分布: ${langSummary}`,
    `调用协议: ${protocolSummary}`,
  ].join('\n');
}

// ─── 自动索引框架 API ─────────────────────────────────────

const FRAMEWORK_GROUPS = new Set(['common', 'infra']);
const FRAMEWORK_LAYER_THRESHOLD = 5; // layer >= 5 的视为基础库

async function autoIndexFrameworkApis(
  ctx: ToolContext,
  scanConfigs: ScanConfig[],
  allResults: Array<{ productLine: string; repoCount: number; mode: string }>,
): Promise<IndexApiDocsResult[]> {
  const results: IndexApiDocsResult[] = [];

  for (const config of scanConfigs) {
    const scanResult = allResults.find(r => r.productLine === config.productLine);
    if (!scanResult || scanResult.repoCount === 0) continue;

    try {
      const registry = await findExistingRegistry(config.productLine);
      if (!registry) continue;

      // 识别公共库/基础设施层的仓库
      const frameworkRepos = Object.entries(registry.repos).filter(([, repo]) => {
        const isFrameworkGroup = FRAMEWORK_GROUPS.has(repo.group);
        const isFrameworkLayer = repo.layer >= FRAMEWORK_LAYER_THRESHOLD;
        return isFrameworkGroup || isFrameworkLayer;
      });

      if (frameworkRepos.length === 0) continue;

      logger.info({
        productLine: config.productLine,
        frameworkRepos: frameworkRepos.length,
      }, '开始自动索引框架 API 文档');

      for (const [repoId, repo] of frameworkRepos) {
        if (!repo.localPath) continue;

        try {
          const techStack = mapLangToStack(repo.lang);
          const result = await indexApiDocsForRepo(ctx, {
            repoPath: repo.localPath,
            repoId,
            techStack,
            productLine: config.productLine,
            framework: repoId.split('/').pop(),
          });
          if (result.stored > 0) {
            results.push(result);
          }
        } catch (err) {
          logger.warn({ repoId, err: (err as Error).message }, '框架 API 索引失败（不影响主流程）');
        }
      }
    } catch (err) {
      logger.warn({ productLine: config.productLine, err: (err as Error).message }, '框架 API 自动索引失败');
    }
  }

  return results;
}

function mapLangToStack(lang: string): 'java' | 'php' | 'typescript' | 'unknown' {
  const lower = lang.toLowerCase();
  if (lower === 'java' || lower === 'kotlin') return 'java';
  if (lower === 'php') return 'php';
  if (['typescript', 'javascript', 'node', 'vue'].includes(lower)) return 'typescript';
  return 'unknown';
}

function findGroupLabel(layer: number, groups: Record<string, { label: string; layer: number }>): string {
  const labels: string[] = [];
  for (const g of Object.values(groups)) {
    if (g.layer === layer && !labels.includes(g.label)) labels.push(g.label);
  }
  return labels.length > 0 ? labels.join(' / ') : `Layer ${layer}`;
}
