// Created by dev on 2026/04/07
// Copyright © 2026
// 拓扑结构化存储 — CRUD 操作

import { getLogger, getPool, queryWithRLS, getRLSContext } from '@memforgeai/shared';
import type { RegistryData, RegistryRepo, DetectedEdge, RegistryInterfaceRecord, MoaRegistryEntry } from '../tools/topology/types.js';

const logger = getLogger('topology-store');

export interface TopologyNode {
  id: string;
  productLine: string;
  repoId: string;
  displayName: string;
  techStack: string | null;
  layerName: string | null;
  layerIndex: number;
  description: string;
  localPath: string | null;
  gitRemoteUrl: string | null;
  gitHost: string | null;
  gitGroup: string | null;
  dependencies: unknown[];
  signals: Record<string, unknown>;
  scannedBy: string | null;
  lastScannedAt: string | null;
  isManual: boolean;
  isHidden: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TopologyEdge {
  id: string;
  productLine: string;
  fromRepoId: string;
  toRepoId: string;
  protocol: string;
  sourceFile: string | null;
  confidence: number;
  isManual: boolean;
  isHidden: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TopologyLayer {
  id: string;
  productLine: string;
  layerIndex: number;
  name: string;
  color: string;
  isCustom: boolean;
}

export interface TopologyFullData {
  productLine: string;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  layers: TopologyLayer[];
}

export interface LookupProviderResult {
  provider: {
    repoId: string;
    displayName: string;
    appKey: string | null;
    techStack: string | null;
    gitRemoteUrl: string | null;
    localPath: string | null;
    providerFile: string | null;
    productLine: string;
  } | null;
  matchedInterfaces: Array<{
    url: string;
    methodName: string | null;
    protocol: 'moa' | 'http';
    traffic1dAvg: number;
    traffic1dPeak: number;
    providerFile: string | null;
  }>;
  consumers: Array<{
    repoId: string;
    displayName: string;
    appKey: string | null;
    sourceFile: string | null;
  }>;
}

export class TopologyStore {
  private pool = getPool();
  private async q<T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(text: string, params?: unknown[]): Promise<import('pg').QueryResult<T>> {
    if (getRLSContext()) return queryWithRLS<T>(text, params);
    return this.pool.query<T>(text, params);
  }

  async getFullTopology(productLine: string): Promise<TopologyFullData> {
    const pl = productLine.toLowerCase();
    const [nodesResult, edgesResult, layersResult] = await Promise.all([
      this.q(
        `SELECT tn.*, COALESCE(u.display_name, u.email) as scanned_by_name
         FROM memory.topology_nodes tn
         LEFT JOIN memory.users u ON u.id::text = tn.scanned_by
         WHERE tn.product_line = $1 AND tn.is_hidden = false
         ORDER BY tn.layer_index, tn.display_name`,
        [pl],
      ),
      this.q(
        `SELECT * FROM memory.topology_edges WHERE product_line = $1 AND is_hidden = false ORDER BY protocol, from_repo_id`,
        [pl],
      ),
      this.q(
        `SELECT * FROM memory.topology_layers WHERE product_line = $1 OR product_line = '_default_' ORDER BY layer_index`,
        [pl],
      ),
    ]);

    return {
      productLine: pl,
      nodes: nodesResult.rows.map(mapNode),
      edges: edgesResult.rows.map(mapEdge),
      layers: this.mergeLayers(layersResult.rows, pl),
    };
  }

  async listProductLines(): Promise<string[]> {
    const { rows } = await this.q<{ product_line: string }>(
      `SELECT DISTINCT product_line FROM memory.topology_nodes WHERE product_line != '_default_' ORDER BY product_line`,
    );
    return rows.map(r => r.product_line);
  }

  async updateNode(productLine: string, repoId: string, updates: Partial<{
    displayName: string;
    layerIndex: number;
    layerName: string;
    description: string;
    isHidden: boolean;
    metadata: Record<string, unknown>;
  }>): Promise<TopologyNode | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 3;

    if (updates.displayName !== undefined) { sets.push(`display_name = $${idx}`); vals.push(updates.displayName); idx++; }
    if (updates.layerIndex !== undefined) { sets.push(`layer_index = $${idx}`); vals.push(updates.layerIndex); idx++; }
    if (updates.layerName !== undefined) { sets.push(`layer_name = $${idx}`); vals.push(updates.layerName); idx++; }
    if (updates.description !== undefined) { sets.push(`description = $${idx}`); vals.push(updates.description); idx++; }
    if (updates.isHidden !== undefined) { sets.push(`is_hidden = $${idx}`); vals.push(updates.isHidden); idx++; }
    if (updates.metadata !== undefined) { sets.push(`metadata = $${idx}`); vals.push(JSON.stringify(updates.metadata)); idx++; }

    if (sets.length === 0) return null;
    sets.push('updated_at = NOW()');

    const { rows } = await this.q(
      `UPDATE memory.topology_nodes SET ${sets.join(', ')} WHERE product_line = $1 AND repo_id = $2 RETURNING *`,
      [productLine.toLowerCase(), repoId, ...vals],
    );
    return rows.length > 0 ? mapNode(rows[0]) : null;
  }

  async addEdge(productLine: string, fromRepoId: string, toRepoId: string, protocol: string, sourceFile?: string): Promise<TopologyEdge> {
    const { rows } = await this.q(
      `INSERT INTO memory.topology_edges (product_line, from_repo_id, to_repo_id, protocol, source_file, is_manual, confidence)
       VALUES ($1, $2, $3, $4, $5, true, 1.0)
       ON CONFLICT (product_line, from_repo_id, to_repo_id, protocol) DO UPDATE SET is_hidden = false, updated_at = NOW()
       RETURNING *`,
      [productLine.toLowerCase(), fromRepoId, toRepoId, protocol, sourceFile ?? null],
    );
    return mapEdge(rows[0]);
  }

  async removeEdge(edgeId: string): Promise<boolean> {
    const { rowCount } = await this.q(
      `UPDATE memory.topology_edges SET is_hidden = true, updated_at = NOW() WHERE id = $1`,
      [edgeId],
    );
    return (rowCount ?? 0) > 0;
  }

  async deleteEdge(edgeId: string): Promise<boolean> {
    const { rowCount } = await this.q(
      `DELETE FROM memory.topology_edges WHERE id = $1 AND is_manual = true`,
      [edgeId],
    );
    return (rowCount ?? 0) > 0;
  }

  async addManualNode(productLine: string, repoId: string, displayName: string, opts: Partial<{
    techStack: string;
    layerIndex: number;
    layerName: string;
    description: string;
    localPath: string;
  }> = {}): Promise<TopologyNode> {
    const { rows } = await this.q(
      `INSERT INTO memory.topology_nodes (product_line, repo_id, display_name, tech_stack, layer_index, layer_name, description, local_path, is_manual)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       ON CONFLICT (product_line, repo_id) DO UPDATE SET
         display_name = EXCLUDED.display_name, tech_stack = COALESCE(EXCLUDED.tech_stack, memory.topology_nodes.tech_stack),
         layer_index = EXCLUDED.layer_index, layer_name = EXCLUDED.layer_name,
         description = EXCLUDED.description, local_path = COALESCE(EXCLUDED.local_path, memory.topology_nodes.local_path),
         is_hidden = false, updated_at = NOW()
       RETURNING *`,
      [productLine.toLowerCase(), repoId, displayName, opts.techStack ?? null,
       opts.layerIndex ?? 8, opts.layerName ?? null, opts.description ?? '', opts.localPath ?? null],
    );
    return mapNode(rows[0]);
  }

  /**
   * 全量导入：upsert 节点/边/层级（用于 force 模式，admin/lead 重建共享图）
   */
  async importFromRegistry(registry: RegistryData, scannedBy?: string): Promise<{ nodesUpserted: number; edgesUpserted: number }> {
    const pl = registry.productLine.toLowerCase();
    let nodesUpserted = 0;
    let edgesUpserted = 0;

    for (const [repoId, repo] of Object.entries(registry.repos)) {
      const name = repoId.split('/').pop() ?? repoId;
      const groupLabel = this.resolveGroupLabel(repo.group, registry.groups ?? {});
      try {
        await this.q(
          `INSERT INTO memory.topology_nodes (
             product_line, repo_id, display_name, tech_stack, layer_index, layer_name,
             description, git_remote_url, git_host, git_group,
             dependencies, signals, scanned_by, last_scanned_at, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), $14)
           ON CONFLICT (product_line, repo_id) DO UPDATE SET
             tech_stack = EXCLUDED.tech_stack,
             layer_index = CASE WHEN memory.topology_nodes.is_manual THEN memory.topology_nodes.layer_index ELSE EXCLUDED.layer_index END,
             layer_name = CASE WHEN memory.topology_nodes.is_manual THEN memory.topology_nodes.layer_name ELSE EXCLUDED.layer_name END,
             git_remote_url = COALESCE(EXCLUDED.git_remote_url, memory.topology_nodes.git_remote_url),
             git_host = COALESCE(EXCLUDED.git_host, memory.topology_nodes.git_host),
             git_group = COALESCE(EXCLUDED.git_group, memory.topology_nodes.git_group),
             dependencies = EXCLUDED.dependencies,
             signals = EXCLUDED.signals,
             scanned_by = COALESCE(EXCLUDED.scanned_by, memory.topology_nodes.scanned_by),
             last_scanned_at = NOW(),
             metadata = memory.topology_nodes.metadata || EXCLUDED.metadata,
             updated_at = NOW()`,
          [pl, repoId, name, repo.lang, repo.layer, groupLabel, repo.desc ?? '',
           repo.remote || null, repo.gitHost || null, repo.gitGroup || null,
           JSON.stringify(repo.dependencies ?? []),
           JSON.stringify(repo.signals ?? {}),
           scannedBy || null,
           JSON.stringify({
             group: repo.group,
             importedAt: new Date().toISOString(),
             ...(repo.infra?.length ? { infra: repo.infra } : {}),
             ...(repo.serverPort ? { serverPort: repo.serverPort } : {}),
           })],
        );
        nodesUpserted++;
      } catch (err) {
        logger.warn({ repoId, err: (err as Error).message }, '节点导入失败');
      }
    }

    for (const edge of registry.edges ?? []) {
      try {
        await this.q(
          `INSERT INTO memory.topology_edges (product_line, from_repo_id, to_repo_id, protocol, confidence, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (product_line, from_repo_id, to_repo_id, protocol) DO UPDATE SET
             confidence = GREATEST(memory.topology_edges.confidence, EXCLUDED.confidence),
             metadata = memory.topology_edges.metadata || EXCLUDED.metadata,
             updated_at = NOW()`,
          [pl, edge.from, edge.to, edge.label, edge.confidence,
           JSON.stringify({ evidence: edge.evidence, autoDetected: edge.autoDetected })],
        );
        edgesUpserted++;
      } catch (err) {
        logger.warn({ from: edge.from, to: edge.to, err: (err as Error).message }, '边导入失败');
      }
    }

    this.syncLayers(pl, registry.groups ?? {});

    // 导入调用图扩展数据（appKey + 接口 + MOA 注册表）
    if (registry.interfaces || registry.moaRegistry) {
      await this.importCallGraphExtras(registry);
    }

    logger.info({ pl, nodesUpserted, edgesUpserted }, '拓扑数据已导入结构化表');
    return { nodesUpserted, edgesUpserted };
  }

  /**
   * Additive 导入：仅 INSERT 新节点/边，不覆盖已有数据。
   * 用于普通用户扫描——贡献新仓库发现，但不修改团队已有的图结构。
   */
  async importNewRepos(registry: RegistryData, scannedBy?: string): Promise<{ nodesAdded: number; edgesAdded: number }> {
    const pl = registry.productLine.toLowerCase();
    let nodesAdded = 0;
    let edgesAdded = 0;

    for (const [repoId, repo] of Object.entries(registry.repos)) {
      const name = repoId.split('/').pop() ?? repoId;
      const groupLabel = this.resolveGroupLabel(repo.group, registry.groups ?? {});
      try {
        // 防止同一 git_remote_url 以不同 repoId 重复入库
        if (repo.remote) {
          const existing = await this.q(
            `SELECT repo_id FROM memory.topology_nodes
             WHERE product_line = $1 AND git_remote_url = $2 AND repo_id != $3 LIMIT 1`,
            [pl, repo.remote, repoId],
          );
          if ((existing.rowCount ?? 0) > 0) continue;
        }
        const { rowCount } = await this.q(
          `INSERT INTO memory.topology_nodes (
             product_line, repo_id, display_name, tech_stack, layer_index, layer_name,
             description, git_remote_url, git_host, git_group,
             dependencies, signals, scanned_by, last_scanned_at, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), $14)
           ON CONFLICT (product_line, repo_id) DO NOTHING`,
          [pl, repoId, name, repo.lang, repo.layer, groupLabel, repo.desc ?? '',
           repo.remote || null, repo.gitHost || null, repo.gitGroup || null,
           JSON.stringify(repo.dependencies ?? []),
           JSON.stringify(repo.signals ?? {}),
           scannedBy || null,
           JSON.stringify({
             group: repo.group,
             importedAt: new Date().toISOString(),
             ...(repo.infra?.length ? { infra: repo.infra } : {}),
             ...(repo.serverPort ? { serverPort: repo.serverPort } : {}),
           })],
        );
        if ((rowCount ?? 0) > 0) nodesAdded++;
      } catch (err) {
        logger.warn({ repoId, err: (err as Error).message }, 'additive 节点导入失败');
      }
    }

    for (const edge of registry.edges ?? []) {
      try {
        const { rowCount } = await this.q(
          `INSERT INTO memory.topology_edges (product_line, from_repo_id, to_repo_id, protocol, confidence, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (product_line, from_repo_id, to_repo_id, protocol) DO NOTHING`,
          [pl, edge.from, edge.to, edge.label, edge.confidence,
           JSON.stringify({ evidence: edge.evidence, autoDetected: edge.autoDetected })],
        );
        if ((rowCount ?? 0) > 0) edgesAdded++;
      } catch (err) {
        logger.warn({ from: edge.from, to: edge.to, err: (err as Error).message }, 'additive 边导入失败');
      }
    }

    this.syncLayers(pl, registry.groups ?? {});

    // 导入调用图扩展数据（appKey + 接口 + MOA 注册表）
    if (registry.interfaces || registry.moaRegistry) {
      await this.importCallGraphExtras(registry);
    }

    logger.info({ pl, nodesAdded, edgesAdded }, '拓扑数据 additive 导入完成');
    return { nodesAdded, edgesAdded };
  }

  /**
   * 批量写入/更新用户+设备的本地路径映射。
   * deviceId 区分同一用户在不同电脑上的路径差异。
   */
  async upsertUserPaths(
    userId: string,
    productLine: string,
    paths: Array<{ repoId: string; localPath: string }>,
    deviceId?: string,
  ): Promise<number> {
    const pl = productLine.toLowerCase();
    const did = deviceId || '_default_';
    let count = 0;
    for (const { repoId, localPath } of paths) {
      if (!localPath) continue;
      try {
        await this.q(
          `INSERT INTO memory.topology_user_paths (user_id, device_id, product_line, repo_id, local_path, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (user_id, device_id, product_line, repo_id) DO UPDATE SET
             local_path = EXCLUDED.local_path,
             updated_at = NOW()`,
          [userId, did, pl, repoId, localPath],
        );
        count++;
      } catch (err) {
        logger.warn({ userId, deviceId: did, repoId, err: (err as Error).message }, '用户路径写入失败');
      }
    }
    logger.info({ userId, deviceId: did, pl, count }, '用户本地路径已更新');
    return count;
  }

  /**
   * 清理本次扫描中不再出现的用户路径。
   * 在 upsertUserPaths 之后调用，删除不在 validRepoIds 中的旧路径记录。
   */
  async cleanupStaleUserPaths(
    userId: string,
    productLine: string,
    validRepoIds: string[],
    deviceId?: string,
  ): Promise<number> {
    if (validRepoIds.length === 0) return 0;
    const pl = productLine.toLowerCase();
    const did = deviceId || '_default_';
    try {
      const placeholders = validRepoIds.map((_, i) => `$${i + 4}`).join(', ');
      const { rowCount } = await this.q(
        `DELETE FROM memory.topology_user_paths
         WHERE user_id = $1 AND device_id = $2 AND product_line = $3
           AND repo_id NOT IN (${placeholders})`,
        [userId, did, pl, ...validRepoIds],
      );
      const deleted = rowCount ?? 0;
      if (deleted > 0) {
        logger.info({ userId, deviceId: did, pl, deleted }, '已清理失效的用户路径');
      }
      return deleted;
    } catch (err) {
      logger.warn({ userId, pl, err: (err as Error).message }, '清理失效路径失败');
      return 0;
    }
  }

  /**
   * 获取指定用户+设备在产品线中的本地路径映射。
   * 优先返回当前设备的路径，如果当前设备无路径则降级到该用户任意设备的最新路径。
   */
  async getUserPaths(userId: string, productLine: string, deviceId?: string): Promise<Map<string, string>> {
    const pl = productLine.toLowerCase();
    const did = deviceId || '_default_';

    // 优先查当前设备
    const { rows } = await this.q(
      `SELECT repo_id, local_path FROM memory.topology_user_paths
       WHERE user_id = $1 AND device_id = $2 AND product_line = $3`,
      [userId, did, pl],
    );

    if (rows.length > 0) {
      const map = new Map<string, string>();
      for (const row of rows) {
        map.set(row.repo_id as string, row.local_path as string);
      }
      return map;
    }

    // 降级：查该用户所有设备中最新的路径
    const { rows: fallbackRows } = await this.q(
      `SELECT DISTINCT ON (repo_id) repo_id, local_path
       FROM memory.topology_user_paths
       WHERE user_id = $1 AND product_line = $2
       ORDER BY repo_id, updated_at DESC`,
      [userId, pl],
    );
    const map = new Map<string, string>();
    for (const row of fallbackRows) {
      map.set(row.repo_id as string, row.local_path as string);
    }
    return map;
  }

  /**
   * 获取产品线的用户路径覆盖统计（按 user_id + device_id 分组）
   */
  async getUserPathsCoverage(productLine: string): Promise<Array<{
    userId: string;
    deviceId: string;
    displayName: string;
    repoCount: number;
    updatedAt: string;
  }>> {
    const pl = productLine.toLowerCase();
    const { rows } = await this.q(
      `SELECT tp.user_id,
              STRING_AGG(DISTINCT tp.device_id, ',') as device_id,
              COALESCE(MAX(u.display_name), MAX(u.email), tp.user_id) as display_name,
              COUNT(DISTINCT tp.repo_id)::int as repo_count,
              MAX(tp.updated_at)::text as updated_at
       FROM memory.topology_user_paths tp
       LEFT JOIN memory.users u ON u.id::text = tp.user_id
       WHERE tp.product_line = $1
       GROUP BY tp.user_id
       ORDER BY repo_count DESC`,
      [pl],
    );
    return rows.map((r: Record<string, unknown>) => ({
      userId: r.user_id as string,
      deviceId: r.device_id as string,
      displayName: r.display_name as string,
      repoCount: r.repo_count as number,
      updatedAt: r.updated_at as string,
    }));
  }

  async clearProductLine(productLine: string): Promise<void> {
    const pl = productLine.toLowerCase();
    await this.q('DELETE FROM memory.topology_edge_interfaces WHERE product_line = $1', [pl]);
    await this.q('DELETE FROM memory.topology_moa_registry WHERE product_line = $1', [pl]);
    await this.q('DELETE FROM memory.topology_edges WHERE product_line = $1', [pl]);
    await this.q('DELETE FROM memory.topology_nodes WHERE product_line = $1', [pl]);
    await this.q('DELETE FROM memory.topology_layers WHERE product_line = $1', [pl]);
  }

  async clearAutoDetected(productLine: string): Promise<{ nodesDeleted: number; edgesDeleted: number }> {
    const pl = productLine.toLowerCase();
    // 先清理接口级数据（外键引用 edges）
    const ifaceRes = await this.q(
      'DELETE FROM memory.topology_edge_interfaces WHERE product_line = $1 RETURNING id',
      [pl],
    );
    const moaRegRes = await this.q(
      'DELETE FROM memory.topology_moa_registry WHERE product_line = $1 RETURNING id',
      [pl],
    );
    const edgeRes = await this.q(
      'DELETE FROM memory.topology_edges WHERE product_line = $1 AND NOT is_manual RETURNING id',
      [pl],
    );
    const nodeRes = await this.q(
      'DELETE FROM memory.topology_nodes WHERE product_line = $1 AND NOT is_manual RETURNING id',
      [pl],
    );
    const layerRes = await this.q(
      'DELETE FROM memory.topology_layers WHERE product_line = $1 AND NOT is_custom RETURNING layer_index',
      [pl],
    );
    logger.info({
      pl, nodesDeleted: nodeRes.rowCount, edgesDeleted: edgeRes.rowCount,
      layersDeleted: layerRes.rowCount, interfacesDeleted: ifaceRes.rowCount,
      moaRegistryDeleted: moaRegRes.rowCount,
    }, '已清理自动检测的拓扑数据');
    return { nodesDeleted: nodeRes.rowCount ?? 0, edgesDeleted: edgeRes.rowCount ?? 0 };
  }

  /**
   * 智能清理：仅删除当前用户之前扫描贡献的、但本次扫描中不再出现的节点。
   * 其他用户贡献的节点不受影响，实现多用户扫描结果的并集语义。
   * 清理节点后会级联清理引用了不存在节点的非手动边。
   */
  async cleanupOrphanedByUser(
    productLine: string,
    scannedBy: string | null,
    validRepoIds: string[],
  ): Promise<{ nodesDeleted: number; edgesDeleted: number }> {
    const pl = productLine.toLowerCase();
    if (!scannedBy || validRepoIds.length === 0) return { nodesDeleted: 0, edgesDeleted: 0 };

    const placeholders = validRepoIds.map((_, i) => `$${i + 3}`).join(', ');

    const nodeRes = await this.q(
      `DELETE FROM memory.topology_nodes
       WHERE product_line = $1
         AND scanned_by = $2
         AND repo_id NOT IN (${placeholders})
         AND NOT is_manual
       RETURNING repo_id`,
      [pl, scannedBy, ...validRepoIds],
    );
    const nodesDeleted = nodeRes.rowCount ?? 0;

    let edgesDeleted = 0;
    if (nodesDeleted > 0) {
      const edgeRes = await this.q(
        `DELETE FROM memory.topology_edges
         WHERE product_line = $1
           AND NOT is_manual
           AND (
             from_repo_id NOT IN (SELECT repo_id FROM memory.topology_nodes WHERE product_line = $1)
             OR to_repo_id NOT IN (SELECT repo_id FROM memory.topology_nodes WHERE product_line = $1)
           )
         RETURNING id`,
        [pl],
      );
      edgesDeleted = edgeRes.rowCount ?? 0;
    }

    if (nodesDeleted > 0 || edgesDeleted > 0) {
      logger.info({ pl, scannedBy, nodesDeleted, edgesDeleted },
        '已清理当前用户的过期拓扑节点');
    }
    return { nodesDeleted, edgesDeleted };
  }

  /**
   * 批量将节点从一个产品线移动到另一个产品线。
   * 同时移动关联的边（from 或 to 在 repoIds 列表中的边）。
   */
  async moveNodes(sourcePl: string, targetPl: string, repoIds: string[]): Promise<{ nodesMoved: number; edgesMoved: number }> {
    const src = sourcePl.toLowerCase();
    const tgt = targetPl.toLowerCase();

    const nodeRes = await this.q(
      `UPDATE memory.topology_nodes SET product_line = $1, updated_at = NOW()
       WHERE product_line = $2 AND repo_id = ANY($3)`,
      [tgt, src, repoIds],
    );

    const edgeRes = await this.q(
      `UPDATE memory.topology_edges SET product_line = $1, updated_at = NOW()
       WHERE product_line = $2
         AND (from_repo_id = ANY($3) OR to_repo_id = ANY($3))`,
      [tgt, src, repoIds],
    );

    logger.info({ src, tgt, nodesMoved: nodeRes.rowCount, edgesMoved: edgeRes.rowCount, repoIds },
      '批量移动拓扑节点完成');
    return { nodesMoved: nodeRes.rowCount ?? 0, edgesMoved: edgeRes.rowCount ?? 0 };
  }

  /**
   * 复制节点到另一个产品线（节点在源产品线保留）。
   * 使用 ON CONFLICT DO NOTHING 避免重复创建已存在的节点。
   * 同时复制关联的边（两端都在 repoIds 中的边）。
   */
  async copyNodes(sourcePl: string, targetPl: string, repoIds: string[]): Promise<{ nodesCopied: number; edgesCopied: number }> {
    const src = sourcePl.toLowerCase();
    const tgt = targetPl.toLowerCase();

    const nodeRes = await this.q(
      `INSERT INTO memory.topology_nodes
        (product_line, repo_id, display_name, tech_stack, layer_name, layer_index, description,
         is_manual, metadata, git_remote_url, git_host, git_group, dependencies, signals)
       SELECT $1, repo_id, display_name, tech_stack, layer_name, layer_index, description,
              is_manual, metadata, git_remote_url, git_host, git_group, dependencies, signals
       FROM memory.topology_nodes
       WHERE product_line = $2 AND repo_id = ANY($3)
       ON CONFLICT (product_line, repo_id) DO NOTHING`,
      [tgt, src, repoIds],
    );

    const edgeRes = await this.q(
      `INSERT INTO memory.topology_edges
        (product_line, from_repo_id, to_repo_id, protocol, source_file, confidence, is_manual, metadata)
       SELECT $1, from_repo_id, to_repo_id, protocol, source_file, confidence, is_manual, metadata
       FROM memory.topology_edges
       WHERE product_line = $2
         AND from_repo_id = ANY($3) AND to_repo_id = ANY($3)
       ON CONFLICT (product_line, from_repo_id, to_repo_id, protocol) DO NOTHING`,
      [tgt, src, repoIds],
    );

    logger.info({ src, tgt, nodesCopied: nodeRes.rowCount, edgesCopied: edgeRes.rowCount, repoIds },
      '批量复制拓扑节点完成');
    return { nodesCopied: nodeRes.rowCount ?? 0, edgesCopied: edgeRes.rowCount ?? 0 };
  }

  /**
   * 获取拓扑数据并注入当前用户+设备的 local_path
   */
  async getFullTopologyWithUserPaths(productLine: string, userId: string | null, deviceId?: string): Promise<TopologyFullData> {
    const data = await this.getFullTopology(productLine);
    if (!userId) return data;

    const userPaths = await this.getUserPaths(userId, productLine, deviceId);
    for (const node of data.nodes) {
      const userPath = userPaths.get(node.repoId);
      if (userPath) {
        node.localPath = userPath;
      }
    }
    return data;
  }

  private syncLayers(pl: string, groups: Record<string, { label: string; layer: number }>): void {
    const layerLabels = new Map<number, string[]>();
    for (const group of Object.values(groups)) {
      const labels = layerLabels.get(group.layer) ?? [];
      if (!labels.includes(group.label)) labels.push(group.label);
      layerLabels.set(group.layer, labels);
    }
    for (const [layerIdx, labels] of layerLabels) {
      this.q(
        `INSERT INTO memory.topology_layers (product_line, layer_index, name, color)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (product_line, layer_index) DO UPDATE SET
           name = CASE WHEN memory.topology_layers.is_custom THEN memory.topology_layers.name ELSE EXCLUDED.name END,
           color = CASE WHEN memory.topology_layers.is_custom THEN memory.topology_layers.color ELSE EXCLUDED.color END`,
        [pl, layerIdx, labels.join(' / '), '#909399'],
      ).catch(() => { /* 忽略层级冲突 */ });
    }
  }

  private resolveGroupLabel(group: string, groups: Record<string, { label: string; layer: number }>): string {
    if (groups[group]) return groups[group].label;
    const defaults: Record<string, string> = {
      client: 'App客户端', frontend: '前端', 'admin-fe': '管理后台前端',
      'api-gateway': '接口网关', 'web-interface': 'Web接口层',
      'admin-web': '管理后台Web', 'admin-rpc': '管理后台RPC',
      microservice: '微服务', payment: '支付/充值',
      common: '公共库/协议', infra: '基础设施',
      tool: '工具', uncategorized: '待归类',
    };
    return defaults[group] ?? '待归类';
  }

  private mergeLayers(rows: Array<Record<string, unknown>>, pl: string): TopologyLayer[] {
    const byIndex = new Map<number, TopologyLayer>();
    for (const row of rows) {
      const layer = mapLayer(row);
      if (layer.productLine === pl) {
        byIndex.set(layer.layerIndex, layer);
      } else if (!byIndex.has(layer.layerIndex)) {
        byIndex.set(layer.layerIndex, layer);
      }
    }
    return [...byIndex.values()].sort((a, b) => a.layerIndex - b.layerIndex);
  }

  async searchNodes(keyword: string, productLine?: string): Promise<TopologyNode[]> {
    const pattern = `%${keyword}%`;
    const plCondition = productLine ? `AND product_line = $2` : '';
    const params: unknown[] = [pattern];
    if (productLine) params.push(productLine.toLowerCase());

    const { rows } = await this.q(
      `SELECT * FROM memory.topology_nodes
       WHERE is_hidden = false
         AND (repo_id ILIKE $1 OR display_name ILIKE $1 OR description ILIKE $1)
         ${plCondition}
       ORDER BY display_name
       LIMIT 10`,
      params,
    );
    return rows.map(mapNode);
  }

  async getNodeWithRelations(productLine: string, repoId: string): Promise<{
    node: TopologyNode | null;
    callers: Array<{ repoId: string; protocol: string; edgeId: string }>;
    callees: Array<{ repoId: string; protocol: string; edgeId: string }>;
    infra: unknown[];
    serverPort: string | null;
  }> {
    const pl = productLine.toLowerCase();
    const [nodeResult, callersResult, calleesResult] = await Promise.all([
      this.q(
        `SELECT * FROM memory.topology_nodes WHERE product_line = $1 AND repo_id = $2 AND is_hidden = false`,
        [pl, repoId],
      ),
      this.q(
        `SELECT id, from_repo_id, protocol FROM memory.topology_edges WHERE product_line = $1 AND to_repo_id = $2 AND is_hidden = false`,
        [pl, repoId],
      ),
      this.q(
        `SELECT id, to_repo_id, protocol FROM memory.topology_edges WHERE product_line = $1 AND from_repo_id = $2 AND is_hidden = false`,
        [pl, repoId],
      ),
    ]);

    const node = nodeResult.rows.length > 0 ? mapNode(nodeResult.rows[0]) : null;
    const metadata = node?.metadata ?? {};
    return {
      node,
      callers: callersResult.rows.map((r: Record<string, unknown>) => ({
        repoId: r.from_repo_id as string,
        protocol: r.protocol as string,
        edgeId: r.id as string,
      })),
      callees: calleesResult.rows.map((r: Record<string, unknown>) => ({
        repoId: r.to_repo_id as string,
        protocol: r.protocol as string,
        edgeId: r.id as string,
      })),
      infra: (metadata.infra ?? []) as unknown[],
      serverPort: (metadata.serverPort as string) ?? null,
    };
  }

  /**
   * 根据 MOA serviceUri 或 HTTP URL 路径查询接口提供方信息
   */
  async lookupInterfaceProvider(
    url: string,
    protocol: 'moa' | 'http',
    productLine?: string,
    includeConsumers?: boolean,
  ): Promise<LookupProviderResult> {
    const pl = productLine?.toLowerCase();
    const plCondition = pl ? 'AND product_line = $2' : '';
    const plParams = pl ? [url, pl] : [url];

    let providerRepoId: string | null = null;
    let providerFile: string | null = null;
    let providerPl: string | null = pl ?? null;

    if (protocol === 'moa') {
      // MOA: 先从 moa_registry 精确匹配
      const { rows } = await this.q(
        `SELECT repo_id, provider_file, product_line
         FROM memory.topology_moa_registry
         WHERE service_uri = $1 ${plCondition}
         ORDER BY confidence DESC
         LIMIT 1`,
        plParams,
      );
      if (rows.length > 0) {
        providerRepoId = rows[0].repo_id as string;
        providerFile = rows[0].provider_file as string | null;
        providerPl = rows[0].product_line as string;
      } else {
        // 降级：模糊匹配
        const { rows: fuzzy } = await this.q(
          `SELECT repo_id, provider_file, product_line
           FROM memory.topology_moa_registry
           WHERE service_uri ILIKE '%' || $1 || '%' ${plCondition}
           ORDER BY confidence DESC
           LIMIT 1`,
          plParams,
        );
        if (fuzzy.length > 0) {
          providerRepoId = fuzzy[0].repo_id as string;
          providerFile = fuzzy[0].provider_file as string | null;
          providerPl = fuzzy[0].product_line as string;
        }
      }
    } else {
      // HTTP: 从 edge_interfaces 查 to_repo_id（提供方）
      const { rows } = await this.q(
        `SELECT DISTINCT to_repo_id, provider_file, product_line
         FROM memory.topology_edge_interfaces
         WHERE protocol = 'http' AND interface_url = $1 ${plCondition}
         LIMIT 1`,
        plParams,
      );
      if (rows.length > 0) {
        providerRepoId = rows[0].to_repo_id as string;
        providerFile = rows[0].provider_file as string | null;
        providerPl = rows[0].product_line as string;
      } else {
        // 降级：前缀匹配
        const { rows: prefix } = await this.q(
          `SELECT DISTINCT to_repo_id, provider_file, product_line
           FROM memory.topology_edge_interfaces
           WHERE protocol = 'http' AND interface_url LIKE $1 || '%' ${plCondition}
           LIMIT 1`,
          plParams,
        );
        if (prefix.length > 0) {
          providerRepoId = prefix[0].to_repo_id as string;
          providerFile = prefix[0].provider_file as string | null;
          providerPl = prefix[0].product_line as string;
        }
      }
    }

    // 查 provider 节点信息
    let provider: LookupProviderResult['provider'] = null;
    if (providerRepoId && providerPl) {
      const { rows } = await this.q(
        `SELECT repo_id, display_name, app_key, tech_stack, git_remote_url, local_path
         FROM memory.topology_nodes
         WHERE repo_id = $1 AND product_line = $2 AND is_hidden = false`,
        [providerRepoId, providerPl],
      );
      if (rows.length > 0) {
        const r = rows[0];
        provider = {
          repoId: r.repo_id as string,
          displayName: r.display_name as string,
          appKey: r.app_key as string | null,
          techStack: r.tech_stack as string | null,
          gitRemoteUrl: r.git_remote_url as string | null,
          localPath: r.local_path as string | null,
          providerFile,
          productLine: providerPl,
        };
      }
    }

    // 查匹配的接口及流量
    const interfacePlCondition = providerPl ? 'AND ei.product_line = $3' : '';
    const interfaceParams = protocol === 'moa'
      ? [url, protocol, ...(providerPl ? [providerPl] : [])]
      : [url, protocol, ...(providerPl ? [providerPl] : [])];

    const { rows: ifRows } = await this.q(
      `SELECT ei.interface_url, ei.method_name, ei.protocol,
              ei.traffic_1d_avg, ei.traffic_1d_peak,
              ei.provider_file
       FROM memory.topology_edge_interfaces ei
       WHERE ei.interface_url = $1 AND ei.protocol = $2 ${interfacePlCondition}
       ORDER BY ei.traffic_1d_avg DESC`,
      interfaceParams,
    );

    const matchedInterfaces: LookupProviderResult['matchedInterfaces'] = ifRows.map(
      (r: Record<string, unknown>) => ({
        url: r.interface_url as string,
        methodName: r.method_name as string | null,
        protocol: r.protocol as 'moa' | 'http',
        traffic1dAvg: Number(r.traffic_1d_avg ?? 0),
        traffic1dPeak: Number(r.traffic_1d_peak ?? 0),
        providerFile: r.provider_file as string | null,
      }),
    );

    // 查调用方
    let consumers: LookupProviderResult['consumers'] = [];
    if (includeConsumers) {
      const consumerPlCondition = providerPl ? 'AND ei.product_line = $3' : '';
      const consumerParams = [url, protocol, ...(providerPl ? [providerPl] : [])];

      const { rows: cRows } = await this.q(
        `SELECT DISTINCT n.repo_id, n.display_name, n.app_key, ei.source_file
         FROM memory.topology_edge_interfaces ei
         JOIN memory.topology_nodes n
           ON n.repo_id = ei.from_repo_id AND n.product_line = ei.product_line
         WHERE ei.interface_url = $1 AND ei.protocol = $2 ${consumerPlCondition}
         ORDER BY n.repo_id`,
        consumerParams,
      );
      consumers = cRows.map((r: Record<string, unknown>) => ({
        repoId: r.repo_id as string,
        displayName: r.display_name as string,
        appKey: r.app_key as string | null,
        sourceFile: r.source_file as string | null,
      }));
    }

    return { provider, matchedInterfaces, consumers };
  }

  /**
   * 扫描后导入调用图扩展数据（appKey + 接口 + MOA 注册表）
   */
  async importCallGraphExtras(registry: RegistryData): Promise<{ interfacesUpserted: number; moaRegistryUpserted: number }> {
    const pl = registry.productLine.toLowerCase();
    let interfacesUpserted = 0;
    let moaRegistryUpserted = 0;

    // 更新 appKey
    for (const [repoId, repo] of Object.entries(registry.repos)) {
      if (repo.appKey) {
        await this.q(
          `UPDATE memory.topology_nodes SET app_key = $1, updated_at = NOW()
           WHERE product_line = $2 AND repo_id = $3`,
          [repo.appKey, pl, repoId],
        );
      }
    }

    // 写入接口明细
    if (registry.interfaces?.length) {
      interfacesUpserted = await this.upsertEdgeInterfaces(pl, registry.interfaces as RegistryInterfaceRecord[]);
    }

    // 写入 MOA 注册表
    if (registry.moaRegistry?.length) {
      moaRegistryUpserted = await this.upsertMoaRegistry(pl, registry.moaRegistry);
    }

    logger.info({ pl, interfacesUpserted, moaRegistryUpserted }, '调用图扩展数据已导入');
    return { interfacesUpserted, moaRegistryUpserted };
  }

  /**
   * 批量写入/更新接口明细
   */
  async upsertEdgeInterfaces(productLine: string, interfaces: RegistryInterfaceRecord[]): Promise<number> {
    const pl = productLine.toLowerCase();
    let count = 0;
    for (const iface of interfaces) {
      try {
        // 查找对应的 edge_id
        const { rows: edgeRows } = await this.q(
          `SELECT id FROM memory.topology_edges
           WHERE product_line = $1 AND from_repo_id = $2 AND to_repo_id = $3 AND is_hidden = false
           LIMIT 1`,
          [pl, iface.fromRepoId, iface.toRepoId],
        );
        const edgeId = edgeRows.length > 0 ? edgeRows[0].id : null;

        await this.q(
          `INSERT INTO memory.topology_edge_interfaces
             (product_line, edge_id, from_repo_id, to_repo_id, protocol, interface_url,
              method_name, traffic_1d_avg, traffic_1d_peak,
              traffic_updated_at, source_file, provider_file, confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11, $12)
           ON CONFLICT (product_line, from_repo_id, to_repo_id, protocol, interface_url, method_name)
           DO UPDATE SET
             edge_id = COALESCE(EXCLUDED.edge_id, memory.topology_edge_interfaces.edge_id),
             traffic_1d_avg = EXCLUDED.traffic_1d_avg,
             traffic_1d_peak = EXCLUDED.traffic_1d_peak,
             traffic_updated_at = NOW(),
             source_file = COALESCE(EXCLUDED.source_file, memory.topology_edge_interfaces.source_file),
             provider_file = COALESCE(EXCLUDED.provider_file, memory.topology_edge_interfaces.provider_file),
             confidence = GREATEST(EXCLUDED.confidence, memory.topology_edge_interfaces.confidence),
             updated_at = NOW()`,
          [pl, edgeId, iface.fromRepoId, iface.toRepoId, iface.type, iface.interfaceUrl,
           iface.methodName ?? null, iface.traffic1dAvg, iface.traffic1dPeak,
           iface.sourceFile ?? null, iface.providerFile ?? null, iface.confidence],
        );
        count++;
      } catch (err) {
        logger.warn({ url: iface.interfaceUrl, err: (err as Error).message }, '接口明细写入失败');
      }
    }
    return count;
  }

  /**
   * 批量写入/更新 MOA 注册表
   */
  async upsertMoaRegistry(productLine: string, entries: MoaRegistryEntry[]): Promise<number> {
    const pl = productLine.toLowerCase();
    let count = 0;
    for (const entry of entries) {
      try {
        // 获取 git_remote_url
        const { rows: nodeRows } = await this.q(
          `SELECT git_remote_url FROM memory.topology_nodes
           WHERE product_line = $1 AND repo_id = $2 LIMIT 1`,
          [pl, entry.repoId],
        );
        const gitRemoteUrl = nodeRows.length > 0 ? nodeRows[0].git_remote_url : null;

        await this.q(
          `INSERT INTO memory.topology_moa_registry
             (product_line, service_uri, repo_id, git_remote_url, provider_file, confidence, last_scanned_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (product_line, service_uri)
           DO UPDATE SET
             repo_id = EXCLUDED.repo_id,
             git_remote_url = COALESCE(EXCLUDED.git_remote_url, memory.topology_moa_registry.git_remote_url),
             provider_file = COALESCE(EXCLUDED.provider_file, memory.topology_moa_registry.provider_file),
             confidence = GREATEST(EXCLUDED.confidence, memory.topology_moa_registry.confidence),
             last_scanned_at = NOW(),
             updated_at = NOW()`,
          [pl, entry.serviceUri, entry.repoId, gitRemoteUrl, entry.providerFile ?? null, entry.confidence],
        );
        count++;
      } catch (err) {
        logger.warn({ uri: entry.serviceUri, err: (err as Error).message }, 'MOA 注册表写入失败');
      }
    }
    return count;
  }

  /**
   * 获取调用关系图（按 from+to 聚合边，流量累加）
   */
  async getCallGraph(productLine: string): Promise<{
    nodes: Array<{ id: string; name: string; layer: string; techStack: string; appKey: string | null; gitUrl: string | null; description: string | null }>;
    edges: Array<{
      id: string; source: string; target: string; protocol: string;
      traffic1dAvg: number; interfaceCount: number;
    }>;
    lastTrafficUpdate: string | null;
  }> {
    const pl = productLine.toLowerCase();

    // 查节点
    const { rows: nodeRows } = await this.q(
      `SELECT repo_id, display_name, layer_name, tech_stack, app_key,
              git_remote_url, description
       FROM memory.topology_nodes
       WHERE product_line = $1 AND is_hidden = false
       ORDER BY display_name`,
      [pl],
    );

    const nodes = nodeRows.map((r: Record<string, unknown>) => ({
      id: r.repo_id as string,
      name: r.display_name as string,
      layer: r.layer_name as string ?? '',
      techStack: r.tech_stack as string ?? '',
      appKey: r.app_key as string | null,
      gitUrl: r.git_remote_url as string | null,
      description: r.description as string | null,
    }));

    // 以 topology_edges 唯一节点对为基础，统计接口数量和流量（不返回接口详情）
    const { rows: edgeRows } = await this.q(
      `WITH edge_pairs AS (
         SELECT from_repo_id, to_repo_id,
                CASE WHEN COUNT(DISTINCT protocol) > 1 THEN 'mixed' ELSE MIN(protocol) END AS protocol
         FROM memory.topology_edges
         WHERE product_line = $1 AND is_hidden = false AND LOWER(protocol) != 'sdk'
         GROUP BY from_repo_id, to_repo_id
       )
       SELECT ep.from_repo_id, ep.to_repo_id, ep.protocol,
              COALESCE(SUM(i.traffic_1d_avg)::bigint, 0) AS total_traffic_1d,
              COUNT(i.id)::int AS interface_count,
              MAX(i.traffic_updated_at)::text AS last_updated
       FROM edge_pairs ep
       LEFT JOIN memory.topology_edge_interfaces i
         ON i.product_line = $1
         AND i.from_repo_id = ep.from_repo_id
         AND i.to_repo_id = ep.to_repo_id
       GROUP BY ep.from_repo_id, ep.to_repo_id, ep.protocol
       ORDER BY total_traffic_1d DESC`,
      [pl],
    );

    let lastTrafficUpdate: string | null = null;
    const edges = edgeRows.map((r: Record<string, unknown>) => {
      const updated = r.last_updated as string | null;
      if (updated && (!lastTrafficUpdate || updated > lastTrafficUpdate)) {
        lastTrafficUpdate = updated;
      }
      return {
        id: `${r.from_repo_id}|${r.to_repo_id}`,
        source: r.from_repo_id as string,
        target: r.to_repo_id as string,
        protocol: r.protocol as string,
        traffic1dAvg: Number(r.total_traffic_1d ?? 0),
        interfaceCount: Number(r.interface_count ?? 0),
      };
    });

    return { nodes, edges, lastTrafficUpdate };
  }

  /**
   * 查询两个节点间的接口详情（按需加载）
   */
  async getEdgeInterfaces(productLine: string, fromRepoId: string, toRepoId: string): Promise<Array<{
    url: string; methodName: string | null; protocol: string;
    traffic1dAvg: number; traffic1dPeak: number;
  }>> {
    const pl = productLine.toLowerCase();
    const { rows } = await this.q(
      `SELECT interface_url, method_name, protocol, traffic_1d_avg, traffic_1d_peak
       FROM memory.topology_edge_interfaces
       WHERE product_line = $1 AND from_repo_id = $2 AND to_repo_id = $3
       ORDER BY traffic_1d_avg DESC`,
      [pl, fromRepoId, toRepoId],
    );
    return rows.map((r: Record<string, unknown>) => ({
      url: r.interface_url as string,
      methodName: r.method_name as string | null,
      protocol: r.protocol as string,
      traffic1dAvg: Number(r.traffic_1d_avg ?? 0),
      traffic1dPeak: Number(r.traffic_1d_peak ?? 0),
    }));
  }

  /**
   * 搜索调用关系子图（按 URL / 节点名 / AppKey）
   */
  async searchCallGraph(
    productLine: string,
    query: string,
    type: 'url' | 'node' | 'appkey',
  ): Promise<ReturnType<TopologyStore['getCallGraph']>> {
    const pl = productLine.toLowerCase();
    const pattern = `%${query}%`;
    let repoIds: string[] = [];

    if (type === 'url') {
      const { rows } = await this.q(
        `SELECT DISTINCT from_repo_id, to_repo_id
         FROM memory.topology_edge_interfaces
         WHERE product_line = $1
           AND (interface_url ILIKE $2 OR (method_name IS NOT NULL AND interface_url || '/' || method_name ILIKE $2))`,
        [pl, pattern],
      );
      const ids = new Set<string>();
      for (const r of rows) {
        ids.add(r.from_repo_id as string);
        ids.add(r.to_repo_id as string);
      }
      repoIds = [...ids];
    } else if (type === 'node') {
      const { rows } = await this.q(
        `SELECT repo_id FROM memory.topology_nodes
         WHERE product_line = $1 AND is_hidden = false
           AND (display_name ILIKE $2 OR repo_id ILIKE $2)`,
        [pl, pattern],
      );
      const directIds = rows.map(r => r.repo_id as string);
      // 加入邻居节点
      if (directIds.length > 0) {
        const placeholders = directIds.map((_, i) => `$${i + 2}`).join(', ');
        const { rows: neighborRows } = await this.q(
          `SELECT DISTINCT from_repo_id AS repo_id FROM memory.topology_edge_interfaces
           WHERE product_line = $1 AND to_repo_id IN (${placeholders})
           UNION
           SELECT DISTINCT to_repo_id AS repo_id FROM memory.topology_edge_interfaces
           WHERE product_line = $1 AND from_repo_id IN (${placeholders})`,
          [pl, ...directIds],
        );
        repoIds = [...new Set([...directIds, ...neighborRows.map(r => r.repo_id as string)])];
      }
    } else if (type === 'appkey') {
      const { rows } = await this.q(
        `SELECT repo_id FROM memory.topology_nodes
         WHERE product_line = $1 AND is_hidden = false AND app_key ILIKE $2`,
        [pl, pattern],
      );
      const directIds = rows.map(r => r.repo_id as string);
      if (directIds.length > 0) {
        const placeholders = directIds.map((_, i) => `$${i + 2}`).join(', ');
        const { rows: neighborRows } = await this.q(
          `SELECT DISTINCT from_repo_id AS repo_id FROM memory.topology_edge_interfaces
           WHERE product_line = $1 AND to_repo_id IN (${placeholders})
           UNION
           SELECT DISTINCT to_repo_id AS repo_id FROM memory.topology_edge_interfaces
           WHERE product_line = $1 AND from_repo_id IN (${placeholders})`,
          [pl, ...directIds],
        );
        repoIds = [...new Set([...directIds, ...neighborRows.map(r => r.repo_id as string)])];
      }
    }

    if (repoIds.length === 0) {
      return { nodes: [], edges: [], lastTrafficUpdate: null };
    }

    // 取子图
    const placeholders = repoIds.map((_, i) => `$${i + 2}`).join(', ');

    const { rows: nodeRows } = await this.q(
      `SELECT repo_id, display_name, layer_name, tech_stack, app_key
       FROM memory.topology_nodes
       WHERE product_line = $1 AND repo_id IN (${placeholders}) AND is_hidden = false`,
      [pl, ...repoIds],
    );

    const { rows: edgeRows } = await this.q(
      `SELECT from_repo_id, to_repo_id,
              SUM(traffic_1d_avg)::bigint AS total_traffic_1d,
              COUNT(*)::int AS interface_count,
              CASE WHEN COUNT(DISTINCT protocol) > 1 THEN 'mixed' ELSE MIN(protocol) END AS protocol,
              MAX(traffic_updated_at)::text AS last_updated,
              json_agg(json_build_object(
                'url', interface_url, 'methodName', method_name, 'protocol', protocol,
                'traffic1dAvg', traffic_1d_avg, 'traffic1dPeak', traffic_1d_peak
              ) ORDER BY traffic_1d_avg DESC) AS interfaces
       FROM memory.topology_edge_interfaces
       WHERE product_line = $1
         AND from_repo_id IN (${placeholders}) AND to_repo_id IN (${placeholders})
       GROUP BY from_repo_id, to_repo_id`,
      [pl, ...repoIds],
    );

    let lastTrafficUpdate: string | null = null;
    return {
      nodes: nodeRows.map((r: Record<string, unknown>) => ({
        id: r.repo_id as string,
        name: r.display_name as string,
        layer: (r.layer_name as string) ?? '',
        techStack: (r.tech_stack as string) ?? '',
        appKey: r.app_key as string | null,
        gitUrl: (r.git_url as string) ?? null,
        description: (r.description as string) ?? null,
      })),
      edges: edgeRows.map((r: Record<string, unknown>) => {
        const updated = r.last_updated as string | null;
        if (updated && (!lastTrafficUpdate || updated > lastTrafficUpdate)) {
          lastTrafficUpdate = updated;
        }
        return {
          id: `${r.from_repo_id}|${r.to_repo_id}`,
          source: r.from_repo_id as string,
          target: r.to_repo_id as string,
          protocol: r.protocol as string,
          traffic1dAvg: Number(r.total_traffic_1d ?? 0),
          interfaceCount: r.interface_count as number,
          interfaces: ((r.interfaces as Array<{ url: string; methodName: string | null; protocol: string; traffic1dAvg: number; traffic1dPeak: number }>) ?? []),
        };
      }),
      lastTrafficUpdate,
    };
  }

  /**
   * 刷新全部接口的 Hubble 流量（读出 → 查 Hubble → 回写）
   */
  async refreshTraffic(productLine: string): Promise<{ updated: number }> {
    const pl = productLine.toLowerCase();
    const { rows } = await this.q(
      `SELECT id, interface_url, method_name, protocol, to_repo_id
       FROM memory.topology_edge_interfaces
       WHERE product_line = $1`,
      [pl],
    );

    // 构建 repoId → appKey 映射
    const { rows: nodeRows } = await this.q(
      `SELECT repo_id, app_key FROM memory.topology_nodes
       WHERE product_line = $1 AND app_key IS NOT NULL`,
      [pl],
    );
    const appKeyMap = new Map<string, string>();
    for (const n of nodeRows) {
      appKeyMap.set(n.repo_id as string, n.app_key as string);
    }

    // 使用 traffic-query 模块
    const { queryInterfaceTraffic } = await import('../tools/topology/traffic-query.js');
    let updated = 0;

    for (const row of rows) {
      try {
        const appKey = appKeyMap.get(row.to_repo_id as string);
        const traffic = await queryInterfaceTraffic(
          {
            type: row.protocol as 'moa' | 'http',
            fromRepoId: '',
            toRepoId: row.to_repo_id as string,
            interfaceUrl: row.interface_url as string,
            methodName: row.method_name as string | undefined,
            confidence: 0.9,
          },
          appKey,
        );

        await this.q(
          `UPDATE memory.topology_edge_interfaces
           SET traffic_1d_avg = $1, traffic_1d_peak = $2,
               traffic_updated_at = NOW(), updated_at = NOW()
           WHERE id = $3`,
          [traffic.traffic1dAvg, traffic.traffic1dPeak, row.id],
        );
        updated++;
      } catch (err) {
        logger.warn({ id: row.id, err: (err as Error).message }, '流量刷新失败');
      }
    }

    logger.info({ pl, total: rows.length, updated }, '流量刷新完成');
    return { updated };
  }

  /**
   * 根据调用边计算发布顺序（Kahn 拓扑排序）
   * 原则：被调方（callee）先发布，调用方（caller）后发布
   */
  async computeReleaseOrder(productLine: string): Promise<{ batches: Array<{ batch: number; repos: string[] }>; cycles: string[] }> {
    const edgeRows = await this.q(
      `SELECT from_repo_id, to_repo_id FROM memory.topology_edges WHERE product_line = $1 AND is_hidden = false`,
      [productLine],
    );
    const nodeRows = await this.q(
      `SELECT repo_id FROM memory.topology_nodes WHERE product_line = $1 AND is_hidden = false`,
      [productLine],
    );

    const allNodes = new Set<string>();
    for (const r of nodeRows.rows) allNodes.add(r.repo_id as string);

    // from → to 表示 from 依赖 to（from 调用 to），发布时 to 要先于 from
    // 依赖图：adj[node] = 该节点依赖的节点列表（即该节点调用的服务）
    const dependsOn = new Map<string, Set<string>>();
    const depCount = new Map<string, number>();

    for (const n of allNodes) {
      dependsOn.set(n, new Set());
      depCount.set(n, 0);
    }

    for (const row of edgeRows.rows) {
      const from = row.from_repo_id as string;
      const to = row.to_repo_id as string;
      if (!allNodes.has(from) || !allNodes.has(to)) continue;
      if (from === to) continue;
      const deps = dependsOn.get(from)!;
      if (!deps.has(to)) {
        deps.add(to);
        depCount.set(from, (depCount.get(from) ?? 0) + 1);
      }
    }

    // Kahn 拓扑排序：无依赖（depCount=0）先发布
    const batches: Array<{ batch: number; repos: string[] }> = [];
    const processed = new Set<string>();
    let batchNum = 1;

    while (processed.size < allNodes.size) {
      const ready: string[] = [];
      for (const n of allNodes) {
        if (!processed.has(n) && (depCount.get(n) ?? 0) === 0) {
          ready.push(n);
        }
      }
      if (ready.length === 0) break; // 存在循环依赖
      ready.sort();
      batches.push({ batch: batchNum++, repos: ready });
      for (const n of ready) {
        processed.add(n);
        // 减少依赖该节点的服务的 depCount
        for (const [node, deps] of dependsOn) {
          if (deps.has(n)) {
            deps.delete(n);
            depCount.set(node, (depCount.get(node) ?? 0) - 1);
          }
        }
      }
    }

    // 检测循环依赖
    const cycles: string[] = [];
    for (const n of allNodes) {
      if (!processed.has(n)) cycles.push(n);
    }

    return { batches, cycles };
  }

  /**
   * 计算变更影响分析：给定一个 repoId，返回所有直接和间接调用它的上游服务
   */
  async computeChangeImpact(productLine: string, repoId: string): Promise<{ directCallers: string[]; indirectCallers: string[] }> {
    const edgeRows = await this.q(
      `SELECT from_repo_id, to_repo_id FROM memory.topology_edges WHERE product_line = $1 AND is_hidden = false`,
      [productLine],
    );

    // adj[to] = [from1, from2, ...] — 谁调用了 to
    const callers = new Map<string, string[]>();
    for (const row of edgeRows.rows) {
      const from = row.from_repo_id as string;
      const to = row.to_repo_id as string;
      if (!callers.has(to)) callers.set(to, []);
      callers.get(to)!.push(from);
    }

    const directCallers = callers.get(repoId) ?? [];
    const indirectCallers: string[] = [];
    const visited = new Set<string>([repoId, ...directCallers]);
    const queue = [...directCallers];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const upstreams = callers.get(current) ?? [];
      for (const u of upstreams) {
        if (!visited.has(u)) {
          visited.add(u);
          indirectCallers.push(u);
          queue.push(u);
        }
      }
    }

    return { directCallers: directCallers.sort(), indirectCallers: indirectCallers.sort() };
  }
}

function mapNode(row: Record<string, unknown>): TopologyNode {
  return {
    id: row.id as string,
    productLine: row.product_line as string,
    repoId: row.repo_id as string,
    displayName: row.display_name as string,
    techStack: row.tech_stack as string | null,
    layerName: row.layer_name as string | null,
    layerIndex: row.layer_index as number,
    description: row.description as string,
    localPath: row.local_path as string | null,
    gitRemoteUrl: (row.git_remote_url as string | null) ?? null,
    gitHost: (row.git_host as string | null) ?? null,
    gitGroup: (row.git_group as string | null) ?? null,
    dependencies: (row.dependencies ?? []) as unknown[],
    signals: (row.signals ?? {}) as Record<string, unknown>,
    scannedBy: (row.scanned_by_name as string | null) ?? (row.scanned_by as string | null) ?? null,
    lastScannedAt: row.last_scanned_at ? (row.last_scanned_at as Date).toISOString() : null,
    isManual: row.is_manual as boolean,
    isHidden: row.is_hidden as boolean,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function mapEdge(row: Record<string, unknown>): TopologyEdge {
  return {
    id: row.id as string,
    productLine: row.product_line as string,
    fromRepoId: row.from_repo_id as string,
    toRepoId: row.to_repo_id as string,
    protocol: row.protocol as string,
    sourceFile: row.source_file as string | null,
    confidence: row.confidence as number,
    isManual: row.is_manual as boolean,
    isHidden: row.is_hidden as boolean,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function mapLayer(row: Record<string, unknown>): TopologyLayer {
  return {
    id: row.id as string,
    productLine: row.product_line as string,
    layerIndex: row.layer_index as number,
    name: row.name as string,
    color: row.color as string,
    isCustom: row.is_custom as boolean,
  };
}
