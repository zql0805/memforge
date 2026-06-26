// Created by dev on 2026/04/06
// Copyright © 2026

import { describe, it, expect, beforeEach } from 'vitest';
import { McpRouter, RouterError } from './router.js';
import type { GatewayConfig } from './config.js';

const testConfig: GatewayConfig = {
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'info',
  jwtSecret: 'a]kF9#mP2$vL5xR8nQ1wY4hB7jD0cT3z',
  jwtIssuer: 'test',
  jwtAudience: 'test',
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 86400,
  memoryServiceUrl: 'http://127.0.0.1:3001',
  knowledgeServiceUrl: 'http://127.0.0.1:3003',
  rulesServiceUrl: 'http://127.0.0.1:3002',
  rateLimitGlobalRpm: 600,
  rateLimitPerUserRpm: 120,
  rateLimitPerToolRpm: 60,
  loginRateLimitPerIpRpm: 10,
  loginRateLimitPerAccountRpm: 5,
  loginRateLimitGlobalRpm: 100,
  openRegistration: true,
  loginLockMaxAttempts: 5,
  loginLockDurationMs: 900_000,
  corsOrigins: ['*'],
  deviceVerification: false,
};

describe('McpRouter', () => {
  let router: McpRouter;

  beforeEach(() => {
    router = new McpRouter(testConfig);
  });

  describe('resolveServiceUrl', () => {
    it('memory 工具路由到 memory service', () => {
      const memoryTools = [
        'store_memory', 'recall_memory', 'list_memories', 'update_memory',
        'archive_memory', 'store_incident', 'store_log_insight',
        'store_troubleshoot', 'store_session_summary',
        'index_documents', 'sync_documents', 'watch_docs',
        'learn_from_commits', 'learn_from_review',
        'import_topology', 'scan_topology', 'bootstrap',
        'export_memories', 'import_memories',
        'start_work_context', 'update_work_context', 'evaluate_work_context',
      ];
      for (const tool of memoryTools) {
        expect(router.resolveServiceUrl(tool), `${tool} should route to memory`).toBe('http://127.0.0.1:3001');
      }
    });

    it('rules 工具路由到 rules engine', () => {
      const rulesTools = [
        'propose_rule', 'list_rules', 'get_rule', 'vote_rule', 'update_rule',
        'deprecate_rule', 'enforce_rules', 'discover_rules', 'measure_rules',
        'record_rule_event',
        'get_skill_radar', 'get_team_matrix',
        'get_knowledge_graph', 'add_knowledge_relation',
        'record_milestone', 'assess_skill', 'get_growth_path',
      ];
      for (const tool of rulesTools) {
        expect(router.resolveServiceUrl(tool), `${tool} should route to rules`).toBe('http://127.0.0.1:3002');
      }
    });

    it('未知工具返回 null', () => {
      expect(router.resolveServiceUrl('nonexistent_tool')).toBeNull();
      expect(router.resolveServiceUrl('')).toBeNull();
    });

    it('工具集之间无交集', () => {
      const memSet = new Set([
        'store_memory', 'recall_memory', 'list_memories', 'update_memory',
        'archive_memory', 'store_incident', 'store_log_insight',
        'store_troubleshoot', 'store_session_summary',
        'index_documents', 'sync_documents', 'watch_docs',
        'learn_from_commits', 'learn_from_review',
        'import_topology', 'scan_topology', 'bootstrap',
        'export_memories', 'import_memories',
        'start_work_context', 'update_work_context', 'evaluate_work_context',
      ]);
      const rulesSet = new Set([
        'propose_rule', 'list_rules', 'get_rule', 'vote_rule', 'update_rule',
        'deprecate_rule', 'enforce_rules', 'discover_rules', 'measure_rules',
        'record_rule_event',
        'get_skill_radar', 'get_team_matrix',
        'get_knowledge_graph', 'add_knowledge_relation',
        'record_milestone', 'assess_skill', 'get_growth_path',
      ]);
      for (const tool of memSet) {
        expect(rulesSet.has(tool), `${tool} exists in both sets`).toBe(false);
      }
    });
  });

  describe('extractToolName', () => {
    it('从 tools/call 请求中提取工具名', () => {
      const body = {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'recall_memory', arguments: { query: 'test' } },
      };
      expect(router.extractToolName(body)).toBe('recall_memory');
    });

    it('非 tools/call 请求返回 null', () => {
      expect(router.extractToolName({ method: 'tools/list' })).toBeNull();
      expect(router.extractToolName({ method: 'resources/read' })).toBeNull();
    });

    it('null/undefined/非对象返回 null', () => {
      expect(router.extractToolName(null)).toBeNull();
      expect(router.extractToolName(undefined)).toBeNull();
      expect(router.extractToolName('string')).toBeNull();
      expect(router.extractToolName(42)).toBeNull();
    });

    it('缺少 params.name 返回 null', () => {
      expect(router.extractToolName({ method: 'tools/call', params: {} })).toBeNull();
      expect(router.extractToolName({ method: 'tools/call' })).toBeNull();
    });

    it('params.name 为空字符串时也能提取', () => {
      const body = {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: '' },
      };
      expect(router.extractToolName(body)).toBe('');
    });
  });

  describe('isReadOnlyMethod', () => {
    it('只读方法返回 true', () => {
      const readOnlyMethods = [
        'tools/list', 'resources/list', 'resources/read',
        'prompts/list', 'prompts/get',
      ];
      for (const m of readOnlyMethods) {
        expect(router.isReadOnlyMethod(m), `${m} should be read-only`).toBe(true);
      }
    });

    it('非只读方法返回 false', () => {
      expect(router.isReadOnlyMethod('tools/call')).toBe(false);
      expect(router.isReadOnlyMethod('resources/write')).toBe(false);
      expect(router.isReadOnlyMethod('')).toBe(false);
      expect(router.isReadOnlyMethod('initialize')).toBe(false);
    });
  });

  describe('RouterError', () => {
    it('包含正确的 name 和 message', () => {
      const err = new RouterError('后端不可用');
      expect(err.name).toBe('RouterError');
      expect(err.message).toBe('后端不可用');
      expect(err).toBeInstanceOf(Error);
    });

    it('包含 cause 属性', () => {
      const cause = new Error('connection refused');
      const err = new RouterError('后端不可用', cause);
      expect(err.cause).toBe(cause);
    });

    it('cause 为 undefined 时不报错', () => {
      const err = new RouterError('测试');
      expect(err.cause).toBeUndefined();
    });
  });
});
