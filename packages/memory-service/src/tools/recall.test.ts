// Created by dev on 2026/04/06
// Copyright © 2026

import { describe, it, expect } from 'vitest';
import { computeDecayFactor, buildCacheKey } from './recall.js';

describe('computeDecayFactor', () => {
  it('常青知识(coding_standard)不衰减', () => {
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
    expect(computeDecayFactor(oneYearAgo, 'coding_standard')).toBe(1.0);
  });

  it('常青知识(architecture)不衰减', () => {
    const twoYearsAgo = new Date(Date.now() - 730 * 24 * 3600 * 1000).toISOString();
    expect(computeDecayFactor(twoYearsAgo, 'architecture')).toBe(1.0);
  });

  it('常青知识(convention)不衰减', () => {
    const old = new Date(Date.now() - 1000 * 24 * 3600 * 1000).toISOString();
    expect(computeDecayFactor(old, 'convention')).toBe(1.0);
  });

  it('刚创建的记忆衰减因子接近 1.0', () => {
    const now = new Date().toISOString();
    expect(computeDecayFactor(now, 'bug_pattern')).toBeCloseTo(1.0, 2);
  });

  it('半衰期到达时衰减因子接近 0.5', () => {
    // bug_pattern 半衰期 = 180 天
    const halfLifeAgo = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();
    expect(computeDecayFactor(halfLifeAgo, 'bug_pattern')).toBeCloseTo(0.5, 1);
  });

  it('tool_usage 半衰期 60 天衰减更快', () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    expect(computeDecayFactor(sixtyDaysAgo, 'tool_usage')).toBeCloseTo(0.5, 1);
  });

  it('未知 scope 使用默认半衰期 90 天', () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    expect(computeDecayFactor(ninetyDaysAgo, 'unknown_scope')).toBeCloseTo(0.5, 1);
  });

  it('未来日期返回 1.0', () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    expect(computeDecayFactor(future, 'bug_pattern')).toBe(1.0);
  });

  it('非常古老的记忆衰减因子接近 0', () => {
    const veryOld = new Date(Date.now() - 3600 * 24 * 3600 * 1000).toISOString();
    const factor = computeDecayFactor(veryOld, 'tool_usage');
    expect(factor).toBeLessThan(0.001);
  });
});

describe('buildCacheKey', () => {
  it('包含所有参数', () => {
    const key = buildCacheKey('test query', 'proj1', 'main', 10, 'json', ['tag1'], ['arch']);
    expect(key).toContain('test query');
    expect(key).toContain('proj1');
    expect(key).toContain('main');
    expect(key).toContain('10');
    expect(key).toContain('json');
    expect(key).toContain('tag1');
    expect(key).toContain('arch');
  });

  it('空参数生成不同的 key', () => {
    const k1 = buildCacheKey('q', undefined, null, 5, 'prompt');
    const k2 = buildCacheKey('q', 'proj', null, 5, 'prompt');
    expect(k1).not.toBe(k2);
  });

  it('tags 排序保证一致性', () => {
    const k1 = buildCacheKey('q', 'p', null, 5, 'json', ['b', 'a']);
    const k2 = buildCacheKey('q', 'p', null, 5, 'json', ['a', 'b']);
    expect(k1).toBe(k2);
  });

  it('scope 排序保证一致性', () => {
    const k1 = buildCacheKey('q', 'p', null, 5, 'json', undefined, ['z', 'a']);
    const k2 = buildCacheKey('q', 'p', null, 5, 'json', undefined, ['a', 'z']);
    expect(k1).toBe(k2);
  });
});
