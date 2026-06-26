// Created by dev on 2026/04/09
// Copyright © 2026

import { describe, it, expect } from 'vitest';
import { RBACEnforcer } from './rbac.js';
import type { UserRole } from './types.js';

describe('RBACEnforcer', () => {
  const rbac = new RBACEnforcer();

  describe('checkPermission', () => {
    it('viewer 可以调用 read 工具', () => {
      expect(rbac.checkPermission('viewer', 'recall_memory')).toBeNull();
      expect(rbac.checkPermission('viewer', 'list_memories')).toBeNull();
      expect(rbac.checkPermission('viewer', 'list_rules')).toBeNull();
    });

    it('viewer 不能调用 write 工具', () => {
      expect(rbac.checkPermission('viewer', 'store_memory')).not.toBeNull();
      expect(rbac.checkPermission('viewer', 'update_memory')).not.toBeNull();
    });

    it('developer 可以调用 read + write 工具', () => {
      expect(rbac.checkPermission('developer', 'recall_memory')).toBeNull();
      expect(rbac.checkPermission('developer', 'store_memory')).toBeNull();
      expect(rbac.checkPermission('developer', 'update_memory')).toBeNull();
    });

    it('developer 不能调用 admin 工具', () => {
      expect(rbac.checkPermission('developer', 'bootstrap')).not.toBeNull();
      expect(rbac.checkPermission('developer', 'import_memories')).not.toBeNull();
    });

    it('admin 可以调用所有工具', () => {
      expect(rbac.checkPermission('admin', 'bootstrap')).toBeNull();
      expect(rbac.checkPermission('admin', 'import_memories')).toBeNull();
      expect(rbac.checkPermission('admin', 'store_memory')).toBeNull();
      expect(rbac.checkPermission('admin', 'recall_memory')).toBeNull();
    });

    it('未注册的工具被拒绝', () => {
      expect(rbac.checkPermission('admin', 'nonexistent_tool')).not.toBeNull();
    });

    it('拓扑查询工具对 viewer 可用', () => {
      expect(rbac.checkPermission('viewer', 'query_topology')).toBeNull();
      expect(rbac.checkPermission('viewer', 'get_topology_release_order')).toBeNull();
      expect(rbac.checkPermission('viewer', 'get_topology_change_impact')).toBeNull();
    });

    it('read scope API Key 不能调用 write 工具', () => {
      expect(rbac.checkApiKeyScope('read', 'store_memory')).not.toBeNull();
      expect(rbac.checkApiKeyScope('read', 'recall_memory')).toBeNull();
    });

    it('readwrite scope API Key 不能调用 admin 工具', () => {
      expect(rbac.checkApiKeyScope('readwrite', 'bootstrap')).not.toBeNull();
      expect(rbac.checkApiKeyScope('readwrite', 'store_memory')).toBeNull();
    });

    it('admin scope API Key 不受 scope 限制', () => {
      expect(rbac.checkApiKeyScope('admin', 'bootstrap')).toBeNull();
    });

    it('scan_topology 对 viewer 可用（read 权限）', () => {
      expect(rbac.checkPermission('viewer', 'scan_topology')).toBeNull();
    });
  });

  describe('hasRole', () => {
    it('角色层级比较正确', () => {
      expect(rbac.hasRole('admin', 'admin')).toBe(true);
      expect(rbac.hasRole('admin', 'viewer')).toBe(true);
      expect(rbac.hasRole('viewer', 'admin')).toBe(false);
      expect(rbac.hasRole('developer', 'lead')).toBe(false);
      expect(rbac.hasRole('lead', 'developer')).toBe(true);
    });
  });

  describe('getAccessibleTools', () => {
    it('viewer 只能看到 read 工具', () => {
      const tools = rbac.getAccessibleTools('viewer');
      for (const t of tools) {
        expect(t.permission).toBe('read');
      }
      expect(tools.length).toBeGreaterThan(0);
    });

    it('admin 能看到所有工具', () => {
      const adminTools = rbac.getAccessibleTools('admin');
      const viewerTools = rbac.getAccessibleTools('viewer');
      expect(adminTools.length).toBeGreaterThan(viewerTools.length);
    });

    it('每个工具都有权限信息', () => {
      const tools = rbac.getAccessibleTools('developer');
      for (const t of tools) {
        expect(t.tool).toBeTruthy();
        expect(['read', 'write', 'admin']).toContain(t.permission);
        expect(typeof t.autoApprove).toBe('boolean');
      }
    });
  });
});
