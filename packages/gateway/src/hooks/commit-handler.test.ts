import { describe, it, expect } from 'vitest';
import { generateHookToken, type CommitPayload } from './commit-handler.js';

describe('commit-handler', () => {
  describe('generateHookToken', () => {
    it('生成以 mfh_ 为前缀的 token', () => {
      const token = generateHookToken();
      expect(token.startsWith('mfh_')).toBe(true);
    });

    it('token 长度 ≥ 32', () => {
      const token = generateHookToken();
      expect(token.length).toBeGreaterThanOrEqual(32);
    });

    it('每次生成不同的 token', () => {
      const t1 = generateHookToken();
      const t2 = generateHookToken();
      expect(t1).not.toBe(t2);
    });
  });
});
