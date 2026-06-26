// Created by dev on 2026/04/04
// Copyright © 2026
// 冲突检测：语义重复 + 逻辑矛盾 + 范围冲突

import { getLogger } from '@memforgeai/shared';
import type { ConflictCheckResult, RulesConfig, ApiEmbeddingService } from '@memforgeai/shared';
import { RulesPostgresStorage, cosineSimilarity } from '../storage/postgres.js';

const logger = getLogger('conflict-detector');

export class ConflictDetector {
  constructor(
    private storage: RulesPostgresStorage,
    private embedding: ApiEmbeddingService,
    private config: RulesConfig,
  ) {}

  /**
   * 三级冲突检测：
   * 1. 语义重复 (cosine > duplicateThreshold)
   * 2. 逻辑矛盾 (example_good vs existing.example_bad 交叉比较)
   * 3. 范围冲突 (project 级降低 security 标准)
   */
  async check(
    newRuleEmbedding: number[],
    newRule: { title: string; description: string; category: string; severity: string; exampleGood?: string | null; exampleBad?: string | null; projectId?: string },
  ): Promise<ConflictCheckResult> {
    const result: ConflictCheckResult = {
      hasDuplicate: false,
      hasContradiction: false,
      hasScopeConflict: false,
      relatedRules: [],
    };

    const similarities = await this.storage.searchRuleEmbeddings(
      newRuleEmbedding,
      this.config.conflictRelatedThreshold,
    );
    if (similarities.length === 0) return result;

    const ruleMap = new Map(
      (await this.storage.getRulesByIds(similarities.map(s => s.id))).map(r => [r.id, r]),
    );

    // 检查语义重复
    for (const item of similarities) {
      const rule = ruleMap.get(item.id);
      if (!rule || rule.status === 'rejected' || rule.status === 'deprecated') continue;

      if (item.similarity >= this.config.conflictDuplicateThreshold) {
        result.hasDuplicate = true;
        result.duplicateRule = { id: rule.id, title: rule.title, similarity: round(item.similarity) };
        logger.warn({ ruleId: rule.id, similarity: item.similarity }, '检测到语义重复规则');
        break;
      }

      result.relatedRules.push({ id: rule.id, title: rule.title, similarity: round(item.similarity) });
    }

    // 截取相关规则列表（最多 5 条）
    result.relatedRules = result.relatedRules.slice(0, 5);

    // 逻辑矛盾检测 — 比较 example_good/bad 交叉相似度
    if (newRule.exampleGood && similarities.length > 0) {
      const contradictionResult = await this.checkContradiction(newRule.exampleGood, similarities);
      if (contradictionResult) {
        result.hasContradiction = true;
        result.contradictionRule = contradictionResult;
      }
    }

    // 范围冲突检测
    if (newRule.projectId && newRule.projectId !== 'default') {
      const scopeConflict = await this.checkScopeConflict(newRule);
      if (scopeConflict) {
        result.hasScopeConflict = true;
        result.scopeConflictDetail = scopeConflict;
      }
    }

    return result;
  }

  /**
   * 逻辑矛盾检测：new.example_good 与 existing.example_bad 如果语义相似度 > 0.8，
   * 说明新规则的"正确示例"和已有规则的"错误示例"几乎一样 — 潜在矛盾
   */
  private async checkContradiction(
    newExampleGood: string,
    candidates: Array<{ id: string; similarity: number }>,
  ): Promise<{ id: string; title: string; detail: string } | null> {
    const goodEmbedding = await this.embedding.embedPassage(newExampleGood);
    const topCandidates = candidates.slice(0, 10);
    const ruleMap = new Map(
      (await this.storage.getRulesByIds(topCandidates.map(c => c.id))).map(r => [r.id, r]),
    );

    for (const candidate of topCandidates) {
      const rule = ruleMap.get(candidate.id);
      if (!rule?.exampleBad) continue;

      const badEmbedding = await this.embedding.embedPassage(rule.exampleBad);
      const crossSim = cosineSimilarity(goodEmbedding, badEmbedding);

      if (crossSim > 0.8) {
        logger.warn({ ruleId: rule.id, crossSimilarity: crossSim }, '检测到逻辑矛盾');
        return {
          id: rule.id,
          title: rule.title,
          detail: `新规则的正确示例与已有规则 "${rule.title}" 的错误示例语义相似度 ${round(crossSim)}，可能存在逻辑矛盾`,
        };
      }
    }

    return null;
  }

  /**
   * 范围冲突检测：项目级规则不能降低组织级 security 规则的标准
   */
  private async checkScopeConflict(
    newRule: { category: string; severity: string; projectId?: string },
  ): Promise<string | null> {
    if (newRule.category !== 'security') return null;

    const orgRules = await this.storage.getActiveRules(['_global_']);
    const orgSecurityRules = orgRules.filter(r => r.category === 'security');

    const severityLevel: Record<string, number> = { critical: 0, error: 1, warning: 2, info: 3 };
    const newLevel = severityLevel[newRule.severity] ?? 2;

    for (const orgRule of orgSecurityRules) {
      const orgLevel = severityLevel[orgRule.severity] ?? 2;
      if (newLevel > orgLevel) {
        return `项目级规则的 severity(${newRule.severity}) 低于组织级安全规则 "${orgRule.title}"(${orgRule.severity})，这会降低安全标准`;
      }
    }

    return null;
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
