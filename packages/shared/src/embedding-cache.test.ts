// Created by dev on 2026/05/18
// Copyright © 2026

import { describe, it, expect, beforeEach } from 'vitest';
import { EmbeddingVectorCache } from './embedding-cache.js';

describe('EmbeddingVectorCache', () => {
  let cache: EmbeddingVectorCache;

  beforeEach(() => {
    cache = new EmbeddingVectorCache('BAAI/bge-m3', { enabled: true, ttlSeconds: 60 });
  });

  it('buildKey 对相同输入稳定', () => {
    const k1 = cache.buildKey('query', 'hello');
    const k2 = cache.buildKey('query', 'hello');
    expect(k1).toBe(k2);
    expect(k1).toContain('BAAI/bge-m3');
    expect(k1).toContain(':query:');
  });

  it('buildKey 区分 query / passage / raw', () => {
    const kq = cache.buildKey('query', 'text');
    const kp = cache.buildKey('passage', 'text');
    const kr = cache.buildKey('raw', 'text');
    expect(kq).not.toBe(kp);
    expect(kq).not.toBe(kr);
  });

  it('set 后 get 命中 L1', async () => {
    const vec = [0.1, 0.2, 0.3];
    await cache.set('query', 'cached text', vec);
    const hit = await cache.get('query', 'cached text');
    expect(hit).toEqual(vec);
    expect(cache.getStats().hits).toBe(1);
    expect(cache.getStats().misses).toBe(0);
  });

  it('未缓存时 miss', async () => {
    const hit = await cache.get('passage', 'missing');
    expect(hit).toBeNull();
    expect(cache.getStats().misses).toBe(1);
  });
});
