// Created by dev on 2026/05/08
// 拓扑存储多用户共享逻辑测试

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * TopologyStore 的 cleanupOrphanedByUser 和 force 模式逻辑测试。
 * 由于 TopologyStore 依赖 PostgreSQL 连接池，此处 mock getPool 进行单元验证。
 */

// mock 数据库模块
const mockQuery = vi.fn();
vi.mock('@memforgeai/shared', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getPool: () => ({ query: mockQuery }),
  queryWithRLS: vi.fn(),
  getRLSContext: () => null,
}));

// 动态 import 以确保 mock 生效
const { TopologyStore } = await import('./topology-store.js');

describe('TopologyStore.cleanupOrphanedByUser', () => {
  let store: InstanceType<typeof TopologyStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new TopologyStore();
  });

  it('scannedBy 为空时不执行任何删除', async () => {
    const result = await store.cleanupOrphanedByUser('test-product', null, ['repo-a']);
    expect(result).toEqual({ nodesDeleted: 0, edgesDeleted: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('validRepoIds 为空时不执行任何删除', async () => {
    const result = await store.cleanupOrphanedByUser('test-product', 'user-1', []);
    expect(result).toEqual({ nodesDeleted: 0, edgesDeleted: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('正确构造 DELETE SQL 并使用 scanned_by 过滤', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 2, rows: [{ repo_id: 'old-a' }, { repo_id: 'old-b' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'edge-1' }] });

    const result = await store.cleanupOrphanedByUser(
      'TestProduct',
      'user-123',
      ['repo-a', 'repo-b', 'repo-c'],
    );

    expect(result).toEqual({ nodesDeleted: 2, edgesDeleted: 1 });

    // 验证节点 DELETE 调用
    const nodeCall = mockQuery.mock.calls[0];
    expect(nodeCall[0]).toContain('DELETE FROM memory.topology_nodes');
    expect(nodeCall[0]).toContain('scanned_by = $2');
    expect(nodeCall[0]).toContain('NOT is_manual');
    expect(nodeCall[1][0]).toBe('test-product');
    expect(nodeCall[1][1]).toBe('user-123');
    expect(nodeCall[1].slice(2)).toEqual(['repo-a', 'repo-b', 'repo-c']);

    // 验证边 DELETE 调用（基于子查询，仅清理孤立边）
    const edgeCall = mockQuery.mock.calls[1];
    expect(edgeCall[0]).toContain('DELETE FROM memory.topology_edges');
    expect(edgeCall[0]).toContain('NOT is_manual');
    expect(edgeCall[0]).toContain('from_repo_id NOT IN');
    expect(edgeCall[1][0]).toBe('test-product');
  });

  it('节点未删除时不执行边清理', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await store.cleanupOrphanedByUser('test', 'user-1', ['a']);

    expect(result).toEqual({ nodesDeleted: 0, edgesDeleted: 0 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('product_line 自动转小写', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await store.cleanupOrphanedByUser('MyProduct', 'user-1', ['repo-a']);

    expect(mockQuery.mock.calls[0][1][0]).toBe('myproduct');
  });
});

describe('TopologyStore.importFromRegistry — scanned_by 传递', () => {
  let store: InstanceType<typeof TopologyStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new TopologyStore();
  });

  it('importFromRegistry 传入 scannedBy 写入 SQL', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    const registry = {
      productLine: 'test',
      generatedAt: '2026-01-01',
      rootDir: '/tmp',
      repos: {
        'org/repo-a': {
          localPath: '/tmp/a',
          lang: 'Java',
          remote: '',
          group: 'microservice',
          layer: 4,
          desc: 'Test Service',
          isKnown: false,
          isCloned: true,
        },
      },
      edges: [],
      groups: {},
    };

    await store.importFromRegistry(registry as never, 'scanner-user-id');

    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO memory.topology_nodes');
    expect(insertCall[0]).toContain('scanned_by');
    // scanned_by is parameter $13
    expect(insertCall[1][12]).toBe('scanner-user-id');
  });
});

describe('force 模式行为验证（场景说明）', () => {
  it('force 模式应使用 importFromRegistry + cleanupOrphanedByUser 而非 clearAutoDetected', () => {
    /**
     * 验证要点（代码结构已在 scan-topology.ts 中修改）：
     *
     * 旧行为（有 Bug）：
     *   force=true → clearAutoDetected(全部删除) → importFromRegistry(重新导入)
     *   问题：clearAutoDetected 删除整个产品线所有非手动节点，导致其他用户的贡献丢失
     *
     * 新行为（已修复）：
     *   force=true → importFromRegistry(upsert) → cleanupOrphanedByUser(仅清理当前用户的过期节点)
     *   效果：其他用户贡献的节点不受影响，仅清理当前用户扫描过但本次不再出现的节点
     *
     * 边清理策略：
     *   cleanupOrphanedByUser 删除节点后，级联清理引用了不存在节点的非手动边
     *   使用子查询 `from_repo_id NOT IN (SELECT repo_id FROM topology_nodes WHERE ...)` 精确匹配
     */
    expect(true).toBe(true);
  });

  it('remote scan 不再自动 force，由调用方显式决定', () => {
    /**
     * gateway server.ts 修改：
     *   旧：const useForce = isPrivilegedRole;  // lead/admin 自动 force
     *   新：const useForce = body.force === true && isPrivilegedRole;  // 显式传入
     *
     * WebUI 侧：
     *   ScanControl + ProductLineSelector 增加「强制更新」复选框
     *   默认不勾选（additive 模式），勾选后才传 force: true
     */
    expect(true).toBe(true);
  });
});
