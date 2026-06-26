// Created by dev on 2026/04/06
// Copyright © 2026

import { describe, it, expect } from 'vitest';
import { inferRelationType } from './auto-link.js';

describe('inferRelationType', () => {
  describe('guided_by — 规范指导工作', () => {
    it('coding_standard → guided_by', () => {
      expect(inferRelationType('coding_standard', 'task_progress', null, null)).toBe('guided_by');
    });

    it('convention → guided_by', () => {
      expect(inferRelationType('convention', 'task_progress', null, null)).toBe('guided_by');
    });

    it('coding_standard 在 bug_fix 上下文中仍然是 guided_by', () => {
      const ctx = { type: 'bug_fix' };
      expect(inferRelationType('coding_standard', 'task_progress', null, ctx)).toBe('guided_by');
    });
  });

  describe('caused_by — Bug 模式导致修复', () => {
    it('bug_pattern + bug_fix → caused_by', () => {
      const ctx = { type: 'bug_fix' };
      expect(inferRelationType('bug_pattern', 'task_progress', null, ctx)).toBe('caused_by');
    });

    it('bug_pattern + 非 bug_fix → related_to', () => {
      const ctx = { type: 'requirement' };
      expect(inferRelationType('bug_pattern', 'task_progress', null, ctx)).toBe('related_to');
    });

    it('bug_pattern + 无上下文 → related_to', () => {
      expect(inferRelationType('bug_pattern', 'task_progress', null, null)).toBe('related_to');
    });
  });

  describe('fixed_by — 调试策略/复盘帮助解决 Bug', () => {
    it('debugging_strategy + bug_fix → fixed_by', () => {
      const ctx = { type: 'bug_fix' };
      expect(inferRelationType('debugging_strategy', 'task_progress', null, ctx)).toBe('fixed_by');
    });

    it('failure_postmortem + bug_fix → fixed_by', () => {
      const ctx = { type: 'bug_fix' };
      expect(inferRelationType('failure_postmortem', 'task_progress', null, ctx)).toBe('fixed_by');
    });

    it('debugging_strategy + 非 bug_fix → references', () => {
      const ctx = { type: 'investigation' };
      expect(inferRelationType('debugging_strategy', 'task_progress', null, ctx)).toBe('references');
    });

    it('failure_postmortem + 无上下文 → references', () => {
      expect(inferRelationType('failure_postmortem', 'task_progress', null, null)).toBe('references');
    });
  });

  describe('references — 参考关系', () => {
    it('lesson_learned → references', () => {
      expect(inferRelationType('lesson_learned', 'task_progress', null, null)).toBe('references');
    });

    it('performance_insight → references', () => {
      expect(inferRelationType('performance_insight', 'task_progress', null, null)).toBe('references');
    });

    it('architecture → references', () => {
      expect(inferRelationType('architecture', 'task_progress', null, null)).toBe('references');
    });

    it('domain_knowledge → references', () => {
      expect(inferRelationType('domain_knowledge', 'task_progress', null, null)).toBe('references');
    });
  });

  describe('related_to — 泛关联', () => {
    it('task_progress → related_to', () => {
      expect(inferRelationType('task_progress', 'task_progress', null, null)).toBe('related_to');
    });

    it('未知 scope → related_to', () => {
      expect(inferRelationType('some_random_scope', 'task_progress', null, null)).toBe('related_to');
    });
  });

  describe('work_type 兼容性', () => {
    it('通过 contextMeta.work_type 也能识别 bug_fix', () => {
      const ctx = { work_type: 'bug_fix' };
      expect(inferRelationType('bug_pattern', 'task_progress', null, ctx)).toBe('caused_by');
    });

    it('type=work_context 时使用 work_type 判断', () => {
      const ctx = { type: 'work_context', work_type: 'bug_fix' };
      expect(inferRelationType('bug_pattern', 'task_progress', null, ctx)).toBe('caused_by');
    });

    it('type=work_context + work_type=requirement 不是 bug_fix', () => {
      const ctx = { type: 'work_context', work_type: 'requirement' };
      expect(inferRelationType('bug_pattern', 'task_progress', null, ctx)).toBe('related_to');
    });

    it('非 work_context 的 type 时 work_type 仍优先', () => {
      const ctx = { type: 'requirement', work_type: 'bug_fix' };
      expect(inferRelationType('bug_pattern', 'task_progress', null, ctx)).toBe('caused_by');
    });
  });
});
