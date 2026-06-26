// Created by dev on 2026/04/07
// Copyright © 2026
// MCP 工具: 拓扑只读查询（4 个工具）
// query_topology / get_topology_release_order / get_topology_change_impact / resolve_service_path

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { TopologyStore } from '../storage/topology-store.js';

const logger = getLogger('tool:query-topology');

let _store: TopologyStore | null = null;
function getStore(): TopologyStore {
  if (!_store) _store = new TopologyStore();
  return _store;
}

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

/**
 * repoId 模糊解析：精确匹配失败时自动尝试变体
 * 解决 3段式（live/product/xxx）与 2段式（product/xxx）不一致问题
 */
async function resolveRepoId(
  store: TopologyStore,
  productLine: string,
  inputRepoId: string,
): Promise<{ repoId: string; fuzzy: boolean } | null> {
  // Pass 1: 精确匹配
  const exact = await store.getNodeWithRelations(productLine, inputRepoId);
  if (exact.node) return { repoId: inputRepoId, fuzzy: false };

  const parts = inputRepoId.split('/');

  // Pass 2: 3段→2段（去掉首段前缀，如 live/product/xxx → product/xxx）
  if (parts.length >= 3) {
    const shortened = parts.slice(1).join('/');
    const rel = await store.getNodeWithRelations(productLine, shortened);
    if (rel.node) {
      logger.info({ input: inputRepoId, resolved: shortened }, 'repoId 模糊解析：去掉首段前缀');
      return { repoId: shortened, fuzzy: true };
    }
  }

  // Pass 3: 2段→搜索末段（如 product/xxx → 搜索所有 */xxx 或 */*/xxx）
  if (parts.length >= 1) {
    const lastPart = parts[parts.length - 1];
    const candidates = await store.searchNodes(lastPart, productLine);
    const match = candidates.find(n => n.repoId.endsWith(`/${lastPart}`));
    if (match) {
      logger.info({ input: inputRepoId, resolved: match.repoId }, 'repoId 模糊解析：末段匹配');
      return { repoId: match.repoId, fuzzy: true };
    }
  }

  return null;
}

// ─── 1. query_topology ─────────────────────────────────────────

export function registerQueryTopology(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'query_topology',
    '查询产品线拓扑数据。可聚焦某个服务查看上下游关系和基础设施依赖，也可获取全量概览。',
    {
      product_line: z.string().describe('产品线名称'),
      repo_id: z.string().optional().describe('聚焦某个服务的 repoId（如 group/my-service）。省略则返回全量概览。'),
      include: z.array(z.enum(['callers', 'callees', 'infra', 'layers', 'all']))
        .optional().default(['callers', 'callees'])
        .describe('包含内容：callers(调用者), callees(被调用者), infra(基础设施), layers(层级), all(全部)'),
      format: z.enum(['prompt', 'json']).optional().default('prompt')
        .describe('输出格式：prompt 为 AI 友好 Markdown，json 为结构化数据'),
    },
    async ({ product_line, repo_id, include, format }) => {
      const store = getStore();
      const userId = ctx.userId;
      const deviceId = ctx.deviceId ?? undefined;
      const includes = new Set(include.includes('all')
        ? ['callers', 'callees', 'infra', 'layers']
        : include);

      // 获取当前用户+设备的路径映射，用于覆盖共享图的 local_path
      const userPaths = userId ? await store.getUserPaths(userId, product_line, deviceId) : new Map<string, string>();

      if (repo_id) {
        const resolved = await resolveRepoId(store, product_line, repo_id);
        if (!resolved) {
          return text(`在产品线 ${product_line} 中未找到服务 ${repo_id}。请确认 repoId 是否正确，或先执行 scan_topology 扫描。`);
        }
        const actualRepoId = resolved.repoId;
        const rel = await store.getNodeWithRelations(product_line, actualRepoId);
        if (!rel.node) {
          return text(`在产品线 ${product_line} 中未找到服务 ${repo_id}。请确认 repoId 是否正确，或先执行 scan_topology 扫描。`);
        }

        const userPath = userPaths.get(actualRepoId);
        if (userPath) rel.node.localPath = userPath;

        if (format === 'json') {
          return text(JSON.stringify({
            node: rel.node,
            ...(includes.has('callers') ? { callers: rel.callers } : {}),
            ...(includes.has('callees') ? { callees: rel.callees } : {}),
            ...(includes.has('infra') ? { infra: rel.infra, serverPort: rel.serverPort } : {}),
          }, null, 2));
        }

        const lines: string[] = [
          `## ${rel.node.displayName} (${rel.node.repoId})`,
          `**技术栈**: ${rel.node.techStack ?? '未知'} | **层级**: 第${rel.node.layerIndex}层 ${rel.node.layerName ?? ''}`,
          rel.node.gitRemoteUrl ? `**Git**: ${rel.node.gitRemoteUrl}` : '',
          rel.node.gitHost ? `**Git Host**: ${rel.node.gitHost} | **Group**: ${rel.node.gitGroup ?? ''}` : '',
          rel.node.localPath ? `**本地路径**: ${rel.node.localPath}` : '',
          rel.node.description ? `**描述**: ${rel.node.description}` : '',
          '',
        ].filter(Boolean);

        if (includes.has('callees') && rel.callees.length > 0) {
          lines.push(`### 调用的下游服务 (${rel.callees.length}个)`);
          for (const c of rel.callees) {
            lines.push(`- ${c.repoId} (${c.protocol})`);
          }
          lines.push('');
        } else if (includes.has('callees')) {
          lines.push('### 调用的下游服务: 无');
          lines.push('');
        }

        if (includes.has('callers') && rel.callers.length > 0) {
          lines.push(`### 被以下服务调用 (${rel.callers.length}个)`);
          for (const c of rel.callers) {
            lines.push(`- ${c.repoId} (${c.protocol})`);
          }
          lines.push('');
        } else if (includes.has('callers')) {
          lines.push('### 被以下服务调用: 无（该服务是入口或无上游调用者）');
          lines.push('');
        }

        if (includes.has('infra') && Array.isArray(rel.infra) && rel.infra.length > 0) {
          lines.push('### 基础设施依赖');
          const grouped = new Map<string, string[]>();
          for (const item of rel.infra as Array<{ type: string; name: string; env?: string }>) {
            const key = item.type;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key)!.push(item.env ? `${item.name} (${item.env})` : item.name);
          }
          for (const [type, names] of grouped) {
            lines.push(`- **${type}**: ${names.join(', ')}`);
          }
          if (rel.serverPort) {
            lines.push(`- **Server Port**: ${rel.serverPort}`);
          }
          lines.push('');
        }

        return text(lines.join('\n'));
      }

      // 全量概览模式：注入当前用户的路径
      const data = await store.getFullTopology(product_line);
      if (data.nodes.length === 0) {
        return text(`产品线 ${product_line} 暂无拓扑数据。请先执行 scan_topology({ product_line: "${product_line}" }) 进行扫描。`);
      }

      for (const node of data.nodes) {
        const up = userPaths.get(node.repoId);
        if (up) node.localPath = up;
      }

      if (format === 'json') {
        return text(JSON.stringify(data, null, 2));
      }

      const lines: string[] = [
        `## 产品线拓扑概览: ${product_line}`,
        `**服务总数**: ${data.nodes.length} | **调用关系**: ${data.edges.length}`,
        '',
      ];

      if (includes.has('layers')) {
        lines.push('### 架构层级');
        const layerMap = new Map<number, { name: string; nodes: typeof data.nodes }>();
        for (const layer of data.layers) {
          const nodesInLayer = data.nodes.filter(n => n.layerIndex === layer.layerIndex);
          if (nodesInLayer.length > 0) {
            layerMap.set(layer.layerIndex, { name: layer.name, nodes: nodesInLayer });
          }
        }
        for (const [idx, info] of [...layerMap.entries()].sort((a, b) => a[0] - b[0])) {
          lines.push(`\n**第${idx}层 - ${info.name}** (${info.nodes.length}个服务):`);
          for (const n of info.nodes) {
            lines.push(`  - ${n.repoId} (${n.techStack ?? '?'}) ${n.localPath ? `→ ${n.localPath}` : ''}`);
          }
        }
        lines.push('');
      }

      return text(lines.join('\n'));
    },
  );
}

// ─── 2. get_topology_release_order ─────────────────────────────

export function registerGetTopologyReleaseOrder(server: McpServer, _ctx: ToolContext): void {
  server.tool(
    'get_topology_release_order',
    '计算产品线的服务发布顺序。基于调用链拓扑排序，被调方先发布，调用方后发布。',
    {
      product_line: z.string().describe('产品线名称'),
    },
    async ({ product_line }) => {
      const store = getStore();
      const result = await store.computeReleaseOrder(product_line);

      if (result.batches.length === 0) {
        return text(`产品线 ${product_line} 暂无拓扑数据或无调用关系，无法计算发布顺序。`);
      }

      const lines: string[] = [
        `## ${product_line} 发布顺序`,
        '',
      ];

      for (const batch of result.batches) {
        lines.push(`**第${batch.batch}批${batch.batch === 1 ? '（无依赖，可并行部署）' : ''}:**`);
        for (const repo of batch.repos) {
          lines.push(`  - ${repo}`);
        }
        lines.push('');
      }

      if (result.cycles.length > 0) {
        lines.push(`⚠️ **循环依赖** (${result.cycles.length}个服务参与): ${result.cycles.join(', ')}`);
        lines.push('提示: 循环依赖的服务需要协调同步发布。');
      } else {
        lines.push('✅ 无循环依赖');
      }

      return text(lines.join('\n'));
    },
  );
}

// ─── 3. get_topology_change_impact ─────────────────────────────

export function registerGetTopologyChangeImpact(server: McpServer, _ctx: ToolContext): void {
  server.tool(
    'get_topology_change_impact',
    '分析修改某个服务后的影响范围。返回所有直接和间接调用该服务的上游服务列表。',
    {
      product_line: z.string().describe('产品线名称'),
      repo_id: z.string().describe('被修改的服务 repoId（如 group/my-service）'),
    },
    async ({ product_line, repo_id }) => {
      const store = getStore();
      const resolved = await resolveRepoId(store, product_line, repo_id);
      const actualRepoId = resolved?.repoId ?? repo_id;
      const result = await store.computeChangeImpact(product_line, actualRepoId);
      const total = result.directCallers.length + result.indirectCallers.length;

      if (total === 0) {
        return text(`服务 ${repo_id} 在产品线 ${product_line} 中没有上游调用者，修改不影响其他服务。`);
      }

      const data = await store.getFullTopology(product_line);
      const nodeMap = new Map(data.nodes.map(n => [n.repoId, n]));

      const formatNode = (repoId: string): string => {
        const n = nodeMap.get(repoId);
        return n ? `${repoId} (${n.techStack ?? '?'}, ${n.layerName ?? `第${n.layerIndex}层`})` : repoId;
      };

      const lines: string[] = [
        `## 变更影响分析: ${actualRepoId}`,
        `**总影响**: ${total}个上游服务`,
        '',
      ];

      if (result.directCallers.length > 0) {
        lines.push(`### 直接调用者 (${result.directCallers.length}个)`);
        for (const c of result.directCallers) {
          lines.push(`- ${formatNode(c)}`);
        }
        lines.push('');
      }

      if (result.indirectCallers.length > 0) {
        lines.push(`### 间接调用者 (${result.indirectCallers.length}个)`);
        for (const c of result.indirectCallers) {
          lines.push(`- ${formatNode(c)}`);
        }
        lines.push('');
      }

      lines.push(`⚠️ 建议: 修改 ${repo_id} 的接口签名时，需同步通知以上 ${total} 个服务的负责人。`);

      return text(lines.join('\n'));
    },
  );
}

// ─── 4. resolve_service_path ───────────────────────────────────

export function registerResolveServicePath(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'resolve_service_path',
    '根据模糊服务名搜索匹配的服务，返回 repoId、本地路径、技术栈等信息。',
    {
      product_line: z.string().optional().describe('产品线名称，省略则搜索所有产品线'),
      service_name: z.string().describe('服务名称关键词（支持模糊匹配，如 "my-api"、"user-service"）'),
    },
    async ({ product_line, service_name }) => {
      const store = getStore();
      const results = await store.searchNodes(service_name, product_line);

      if (results.length === 0) {
        return text(`未找到匹配 "${service_name}" 的服务${product_line ? ` (产品线: ${product_line})` : ''}。请尝试其他关键词，或先执行 scan_topology 扫描。`);
      }

      // 用当前用户+设备的路径覆盖
      const userId = ctx.userId;
      const resolveDeviceId = ctx.deviceId ?? undefined;
      if (userId) {
        const plSet = new Set(results.map(n => n.productLine));
        const allPaths = new Map<string, string>();
        for (const pl of plSet) {
          const paths = await store.getUserPaths(userId, pl, resolveDeviceId);
          for (const [k, v] of paths) allPaths.set(`${pl}:${k}`, v);
        }
        for (const n of results) {
          const up = allPaths.get(`${n.productLine}:${n.repoId}`);
          if (up) n.localPath = up;
        }
      }

      const lines: string[] = [
        `## 搜索结果: "${service_name}" (${results.length}个匹配)`,
        '',
      ];

      for (const n of results) {
        lines.push(`### ${n.displayName}`);
        lines.push(`- **repoId**: ${n.repoId}`);
        lines.push(`- **技术栈**: ${n.techStack ?? '未知'}`);
        lines.push(`- **层级**: 第${n.layerIndex}层 ${n.layerName ?? ''}`);
        if (n.gitRemoteUrl) lines.push(`- **Git**: ${n.gitRemoteUrl}`);
        if (n.localPath) lines.push(`- **本地路径**: ${n.localPath}`);
        if (n.description) lines.push(`- **描述**: ${n.description}`);
        lines.push(`- **产品线**: ${n.productLine}`);
        lines.push('');
      }

      return text(lines.join('\n'));
    },
  );
}

// ─── 5. lookup_interface_provider ─────────────────────────────

export function registerLookupInterfaceProvider(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'lookup_interface_provider',
    '根据 MOA serviceUri 或 HTTP URL 路径查询接口提供方信息，返回代码仓库、appKey、流量数据及调用方列表。',
    {
      url: z.string()
        .describe('接口 URL。MOA 传 serviceUri（如 /service/behavior/charge-level），HTTP 传 URI path（如 /api/live/room/full）'),
      protocol: z.enum(['moa', 'http'])
        .describe('接口协议类型'),
      product_line: z.string().optional()
        .describe('产品线名称，不传则搜索所有产品线'),
      include_consumers: z.boolean().optional().default(false)
        .describe('是否返回调用方列表'),
      format: z.enum(['prompt', 'json']).optional().default('prompt')
        .describe('输出格式：prompt 为 AI 友好 Markdown，json 为结构化数据'),
    },
    async ({ url, protocol, product_line, include_consumers, format }) => {
      const store = getStore();
      const result = await store.lookupInterfaceProvider(url, protocol, product_line, include_consumers);

      // 注入当前用户的 localPath
      if (result.provider && ctx.userId) {
        const userPaths = await store.getUserPaths(ctx.userId, result.provider.productLine, ctx.deviceId ?? undefined);
        const userPath = userPaths.get(result.provider.repoId);
        if (userPath) result.provider.localPath = userPath;
      }

      if (!result.provider && result.matchedInterfaces.length === 0) {
        return text(`未找到接口 ${url} (${protocol}) 的提供方信息${product_line ? ` (产品线: ${product_line})` : ''}。\n\n可能原因：\n- 尚未执行拓扑扫描，请先运行 scan_topology\n- 接口 URL 不正确，请确认格式`);
      }

      if (format === 'json') {
        return text(JSON.stringify(result, null, 2));
      }

      const lines: string[] = [
        `## 接口提供方查询结果`,
        '',
        `**查询**: ${url} (${protocol.toUpperCase()})`,
        '',
      ];

      if (result.provider) {
        lines.push('### 提供方');
        lines.push(`- **仓库**: ${result.provider.repoId}`);
        lines.push(`- **名称**: ${result.provider.displayName}`);
        if (result.provider.appKey) lines.push(`- **AppKey**: ${result.provider.appKey}`);
        if (result.provider.techStack) lines.push(`- **技术栈**: ${result.provider.techStack}`);
        if (result.provider.gitRemoteUrl) lines.push(`- **Git**: ${result.provider.gitRemoteUrl}`);
        if (result.provider.localPath) lines.push(`- **本地路径**: ${result.provider.localPath}`);
        if (result.provider.providerFile) lines.push(`- **Provider 文件**: ${result.provider.providerFile}`);
        lines.push('');
      }

      if (result.matchedInterfaces.length > 0) {
        lines.push(`### 匹配的接口 (${result.matchedInterfaces.length}个)`);
        if (protocol === 'moa') {
          lines.push('| 方法名 | 日均调用量 | 分钟峰值 |');
          lines.push('|--------|-----------|---------|');
          for (const iface of result.matchedInterfaces) {
            const name = iface.methodName ?? iface.url;
            lines.push(`| ${name} | ${fmtNum(iface.traffic1dAvg)} | ${fmtNum(iface.traffic1dPeak)} |`);
          }
        } else {
          lines.push('| URL | 日均调用量 | 分钟峰值 |');
          lines.push('|-----|-----------|---------|');
          for (const iface of result.matchedInterfaces) {
            lines.push(`| ${iface.url} | ${fmtNum(iface.traffic1dAvg)} | ${fmtNum(iface.traffic1dPeak)} |`);
          }
        }
        lines.push('');
      }

      if (result.consumers.length > 0) {
        lines.push(`### 调用方 (${result.consumers.length}个)`);
        for (const c of result.consumers) {
          const appKeyStr = c.appKey ? ` (appKey: ${c.appKey})` : '';
          const srcStr = c.sourceFile ? ` — 来源: ${c.sourceFile}` : '';
          lines.push(`- ${c.repoId}${appKeyStr}${srcStr}`);
        }
        lines.push('');
      }

      return text(lines.join('\n'));
    },
  );
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
