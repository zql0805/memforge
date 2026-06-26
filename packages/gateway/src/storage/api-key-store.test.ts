// Created by dev on 2026/04/09

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';

vi.mock('@memforgeai/shared', () => ({
  query: vi.fn(),
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  ApiKeyCreationScope: {
    safeParse: (v: unknown) => {
      const valid = ['read', 'readwrite', 'admin'];
      if (v === undefined || v === null || v === '') return { success: true, data: 'readwrite' };
      return valid.includes(String(v))
        ? { success: true, data: String(v) }
        : { success: false, error: new Error('invalid') };
    },
    options: ['read', 'readwrite', 'admin'],
  },
}));

import { ApiKeyStore } from './api-key-store.js';
import { query } from '@memforgeai/shared';

const mockQuery = vi.mocked(query);

describe('ApiKeyStore', () => {
  let store: ApiKeyStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ApiKeyStore();
  });

  describe('generate', () => {
    it('生成的 key 以 mfk_ 开头', async () => {
      const fakeRow = {
        id: 'uuid-1',
        user_id: 'user-1',
        name: 'test',
        key_prefix: 'mfk_aBcDeFgH',
        key_hash: 'hash',
        scope: 'readwrite',
        last_used_at: null,
        expires_at: null,
        is_active: true,
        created_at: '2026-04-09',
      };
      mockQuery.mockResolvedValueOnce({ rows: [fakeRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] });

      const result = await store.generate('user-1', 'test');

      expect(result.key).toMatch(/^mfk_/);
      expect(result.key.length).toBeGreaterThan(20);
      expect(result.record.userId).toBe('user-1');
      expect(result.record.name).toBe('test');
    });

    it('key_prefix 为 key 的前 12 字符', async () => {
      const fakeRow = {
        id: 'uuid-1',
        user_id: 'user-1',
        name: 'test',
        key_prefix: 'mfk_aBcDeFgH',
        key_hash: 'hash',
        scope: 'readwrite',
        last_used_at: null,
        expires_at: null,
        is_active: true,
        created_at: '2026-04-09',
      };
      mockQuery.mockResolvedValueOnce({ rows: [fakeRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] });

      const result = await store.generate('user-1', 'test');
      const prefix = result.key.slice(0, 12);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO memory.api_keys'),
        expect.arrayContaining(['user-1', 'test', prefix, expect.any(String), null, 'readwrite']),
      );
    });

    it('key_hash 使用 SHA-256', async () => {
      const fakeRow = {
        id: 'uuid-1',
        user_id: 'user-1',
        name: 'test',
        key_prefix: 'placeholder',
        key_hash: 'placeholder',
        scope: 'readwrite',
        last_used_at: null,
        expires_at: null,
        is_active: true,
        created_at: '2026-04-09',
      };
      mockQuery.mockResolvedValueOnce({ rows: [fakeRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] });

      const result = await store.generate('user-1', 'test');
      const expectedHash = createHash('sha256').update(result.key).digest('hex');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO memory.api_keys'),
        expect.arrayContaining([expectedHash]),
      );
    });
  });

  describe('verify', () => {
    it('非 mfk_ 前缀直接返回 null', async () => {
      const result = await store.verify('invalid_key');
      expect(result).toBeNull();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('key 不存在返回 null', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

      const result = await store.verify('mfk_' + randomBytes(32).toString('base64url'));
      expect(result).toBeNull();
    });

    it('有效 key 返回 userId', async () => {
      const rawKey = randomBytes(32).toString('base64url');
      const fullKey = `mfk_${rawKey}`;
      const keyPrefix = fullKey.slice(0, 12);
      const keyHash = createHash('sha256').update(fullKey).digest('hex');

      // verify 查询
      mockQuery.mockResolvedValueOnce({
        rows: [{ user_id: 'user-1', expires_at: null, scope: 'readwrite' }],
        rowCount: 1, command: 'SELECT', oid: 0, fields: [],
      });
      // last_used_at 更新（异步）
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] });

      const result = await store.verify(fullKey);
      expect(result).toEqual({ userId: 'user-1', scope: 'readwrite' });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT user_id'),
        [keyPrefix, keyHash],
      );
    });

    it('过期的 key 返回 null', async () => {
      const rawKey = randomBytes(32).toString('base64url');
      const fullKey = `mfk_${rawKey}`;

      mockQuery.mockResolvedValueOnce({
        rows: [{ user_id: 'user-1', expires_at: '2020-01-01T00:00:00Z', scope: 'readwrite' }],
        rowCount: 1, command: 'SELECT', oid: 0, fields: [],
      });

      const result = await store.verify(fullKey);
      expect(result).toBeNull();
    });
  });

  describe('listByUser', () => {
    it('返回用户所有 key（含已撤销）', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: '1', user_id: 'u1', name: 'key1', key_prefix: 'mfk_aaaa', key_hash: 'h1', scope: 'read', last_used_at: null, expires_at: null, is_active: true, created_at: '2026-04-09' },
          { id: '2', user_id: 'u1', name: 'key2', key_prefix: 'mfk_bbbb', key_hash: 'h2', scope: 'readwrite', last_used_at: null, expires_at: null, is_active: false, created_at: '2026-04-08' },
        ],
        rowCount: 2, command: 'SELECT', oid: 0, fields: [],
      });

      const keys = await store.listByUser('u1');
      expect(keys).toHaveLength(2);
      expect(keys[0].isActive).toBe(true);
      expect(keys[1].isActive).toBe(false);
    });
  });

  describe('revoke', () => {
    it('撤销成功返回 true', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] });

      const result = await store.revoke('key-1', 'user-1');
      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SET is_active = FALSE'),
        ['key-1', 'user-1'],
      );
    });

    it('不存在的 key 返回 false', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] });

      const result = await store.revoke('nonexistent', 'user-1');
      expect(result).toBe(false);
    });

    it('其他用户的 key 无法撤销（userId 校验）', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] });

      const result = await store.revoke('key-1', 'wrong-user');
      expect(result).toBe(false);
    });
  });
});
