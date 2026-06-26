// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: import_topology — 从产品线拓扑注册表导入架构知识到记忆库

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { assertPathWithin, getLogger } from '@memforgeai/shared';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:import-topology');

interface TopologyRegistry {
  schemaVersion: string;
  generatedAt: string;
  productLine: string;
  rootDir: string;
  gitHost: string;
  repos: Record<string, RepoInfo>;
  edges: EdgeInfo[];
  groups: Record<string, GroupInfo>;
  summary: {
    totalScanned: number;
    classified: number;
    autoEdges: number;
  };
}

interface RepoInfo {
  localPath: string;
  lang: string;
  remote: string;
  group: string;
  layer: number;
  desc: string;
  isKnown: boolean;
  isCloned: boolean;
}

interface EdgeInfo {
  from: string;
  to: string;
  label: string;
  confidence: number;
  autoDetected: boolean;
}

interface GroupInfo {
  label: string;
  color: string;
  layer: number;
}

export function registerImportTopology(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'import_topology',
    '从产品线拓扑注册表（如 myapp-registry.json）导入服务架构知识到记忆库。将服务节点、调用关系、分层结构转化为架构记忆，使 AI 助手理解系统全貌。',
    {
      registry_path: z.string().describe('拓扑注册表文件路径（IDE 配置目录下的注册表文件）'),
      include_edges: z.boolean().default(true).describe('是否导入服务调用关系'),
      include_layers: z.boolean().default(true).describe('是否导入分层架构概览'),
      force: z.boolean().default(false).describe('强制导入：跳过重复检测，删除同标题旧数据后重新写入'),
      dry_run: z.boolean().default(false).describe('试运行：只分析不存储'),
    },
    async ({ registry_path, include_edges, include_layers, force, dry_run }) => {
      let filePath: string;
      try {
        filePath = assertPathWithin(
          [process.env.HOME ?? '/tmp', process.cwd()],
          registry_path.replace(/^~/, process.env.HOME ?? ''),
        );
      } catch (err) {
        return text((err as Error).message);
      }

      let raw: string;
      try {
        raw = await readFile(filePath, 'utf-8');
      } catch (err) {
        return text(`无法读取注册表文件 ${filePath}: ${(err as Error).message}`);
      }

      let registry: TopologyRegistry;
      try {
        registry = JSON.parse(raw);
      } catch {
        return text(`注册表文件 JSON 解析失败。`);
      }

      if (!registry.repos || !registry.productLine) {
        return text('注册表格式不正确：缺少 repos 或 productLine 字段。');
      }

      const projectId = ctx.gitContext?.projectName ?? registry.productLine.toLowerCase();
      const branchId = null;
      const plTag = `pl:${registry.productLine.toLowerCase()}`;
      const results: ImportResult = {
        services: { total: 0, stored: 0, duplicates: 0 },
        edges: { total: 0, stored: 0, duplicates: 0 },
        layers: { stored: 0 },
      };

      // 1. 导入服务节点
      const repoEntries = Object.entries(registry.repos);
      results.services.total = repoEntries.length;

      for (const [repoId, repo] of repoEntries) {
        const groupLabel = registry.groups[repo.group]?.label ?? repo.group;
        const title = `[架构·服务] ${repo.desc || repoId}`;
        const content = buildServiceContent(repoId, repo, groupLabel, registry);

        if (!dry_run) {
          const stored = await storeIfNew(ctx, {
            projectId, branchId, title, content,
            scope: 'architecture' as MemoryScope,
            source: 'ai_suggestion' as MemorySource,
            tags: ['topology', 'service', plTag, `lang:${repo.lang}`, `layer:${repo.layer}`, `group:${repo.group}`],
            metadata: {
              repoId,
              lang: repo.lang,
              layer: repo.layer,
              group: repo.group,
              importedFrom: 'topology-registry',
              importedAt: new Date().toISOString(),
            },
          }, force);
          if (stored) results.services.stored++;
          else results.services.duplicates++;
        }
      }

      // 2. 导入调用关系
      if (include_edges && registry.edges) {
        results.edges.total = registry.edges.length;

        const edgesByProtocol = groupEdgesByProtocol(registry.edges);

        for (const [protocol, edges] of Object.entries(edgesByProtocol)) {
          const title = `[架构·调用链] ${registry.productLine} ${protocol} 调用关系 (${edges.length} 条)`;
          const content = buildEdgesContent(edges, registry, protocol);

          if (!dry_run) {
            const stored = await storeIfNew(ctx, {
              projectId, branchId, title, content,
              scope: 'architecture' as MemoryScope,
              source: 'ai_suggestion' as MemorySource,
              tags: ['topology', 'call-graph', plTag, `protocol:${protocol.toLowerCase().replace(/\s+/g, '-')}`],
              metadata: {
                protocol,
                edgeCount: edges.length,
                importedFrom: 'topology-registry',
                importedAt: new Date().toISOString(),
              },
            }, force);
            if (stored) results.edges.stored += edges.length;
            else results.edges.duplicates += edges.length;
          }
        }
      }

      // 3. 导入分层架构概览
      if (include_layers) {
        const layerContent = buildLayerOverview(registry);
        const title = `[架构·分层] ${registry.productLine} 服务分层全景 (${repoEntries.length} 服务)`;

        if (!dry_run) {
          const stored = await storeIfNew(ctx, {
            projectId, branchId, title,
            content: layerContent,
            scope: 'architecture' as MemoryScope,
            source: 'ai_suggestion' as MemorySource,
            tags: ['topology', 'architecture-overview', 'layers', plTag],
            metadata: {
              totalServices: repoEntries.length,
              totalEdges: registry.edges?.length ?? 0,
              importedFrom: 'topology-registry',
              importedAt: new Date().toISOString(),
            },
          }, force);
          if (stored) results.layers.stored = 1;
        }
      }

      const summary = {
        productLine: registry.productLine,
        mode: dry_run ? '试运行' : '已导入',
        generatedAt: registry.generatedAt,
        results,
      };

      logger.info({
        productLine: registry.productLine,
        services: results.services.stored,
        edges: results.edges.stored,
        dryRun: dry_run,
      }, '拓扑数据导入完成');

      return text(JSON.stringify(summary, null, 2));
    },
  );
}

interface ImportResult {
  services: { total: number; stored: number; duplicates: number };
  edges: { total: number; stored: number; duplicates: number };
  layers: { stored: number };
}

interface StoreParams {
  projectId: string;
  branchId: string | null;
  title: string;
  content: string;
  scope: MemoryScope;
  source: MemorySource;
  tags: string[];
  metadata: Record<string, unknown>;
}

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

async function storeIfNew(ctx: ToolContext, params: StoreParams, force = false): Promise<boolean> {
  const scanResult = ctx.scanner.scan(params.content);
  if (scanResult.blocked) return false;

  const finalContent = scanResult.sanitizedContent ?? params.content;
  const embedding = await ctx.embedding.embedPassage(`${params.title} ${finalContent}`);

  if (!force) {
    const duplicate = await ctx.storage.checkDuplicate(embedding, 0.90);
    if (duplicate) return false;
  } else {
    // force 模式：删除同标题旧数据
    await ctx.storage.deleteByTitle(params.title, params.projectId);
  }

  await ctx.storage.store({
    ...params,
    content: finalContent,
    embedding,
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

function buildServiceContent(repoId: string, repo: RepoInfo, groupLabel: string, registry: TopologyRegistry): string {
  const parts: string[] = [
    `服务: ${repo.desc || repoId}`,
    `仓库ID: ${repoId}`,
    `技术栈: ${repo.lang}`,
    `分组: ${groupLabel}`,
    `架构层级: L${repo.layer}`,
  ];

  if (repo.localPath) {
    parts.push(`本地路径: ${repo.localPath}`);
  }

  const upstream = (registry.edges ?? [])
    .filter((e) => e.to === repoId)
    .map((e) => `${e.from} (${e.label})`);
  const downstream = (registry.edges ?? [])
    .filter((e) => e.from === repoId)
    .map((e) => `${e.to} (${e.label})`);

  if (upstream.length > 0) {
    parts.push(`\n上游调用方 (${upstream.length}): ${upstream.join(', ')}`);
  }
  if (downstream.length > 0) {
    parts.push(`下游依赖 (${downstream.length}): ${downstream.join(', ')}`);
  }

  return parts.join('\n');
}

function groupEdgesByProtocol(edges: EdgeInfo[]): Record<string, EdgeInfo[]> {
  const groups: Record<string, EdgeInfo[]> = {};
  for (const edge of edges) {
    const key = edge.label || 'unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(edge);
  }
  return groups;
}

function buildEdgesContent(edges: EdgeInfo[], registry: TopologyRegistry, protocol: string): string {
  const parts: string[] = [
    `协议: ${protocol}`,
    `调用关系数: ${edges.length}`,
    '',
  ];

  for (const edge of edges) {
    const fromDesc = registry.repos[edge.from]?.desc ?? edge.from;
    const toDesc = registry.repos[edge.to]?.desc ?? edge.to;
    parts.push(`${fromDesc} (${edge.from}) → ${toDesc} (${edge.to})`);
  }

  return parts.join('\n');
}

function buildLayerOverview(registry: TopologyRegistry): string {
  const layers = new Map<number, Array<{ repoId: string; desc: string; lang: string; group: string }>>();

  for (const [repoId, repo] of Object.entries(registry.repos)) {
    if (!layers.has(repo.layer)) layers.set(repo.layer, []);
    layers.get(repo.layer)!.push({
      repoId,
      desc: repo.desc || repoId,
      lang: repo.lang,
      group: repo.group,
    });
  }

  const sortedLayers = [...layers.entries()].sort((a, b) => a[0] - b[0]);
  const parts: string[] = [
    `产品线: ${registry.productLine}`,
    `服务总数: ${Object.keys(registry.repos).length}`,
    `调用关系: ${registry.edges?.length ?? 0} 条`,
    `生成时间: ${registry.generatedAt}`,
    '',
  ];

  for (const [layerNum, services] of sortedLayers) {
    const groupLabel = findGroupLabelForLayer(layerNum, registry.groups);
    parts.push(`--- 第 ${layerNum} 层: ${groupLabel} (${services.length} 服务) ---`);

    for (const svc of services) {
      parts.push(`  ${svc.desc} [${svc.lang}] (${svc.repoId})`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

function findGroupLabelForLayer(layer: number, groups: Record<string, GroupInfo>): string {
  const labels: string[] = [];
  for (const group of Object.values(groups)) {
    if (group.layer === layer && !labels.includes(group.label)) {
      labels.push(group.label);
    }
  }
  return labels.length > 0 ? labels.join(' / ') : `Layer ${layer}`;
}
