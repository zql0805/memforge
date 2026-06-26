// Created by dev on 2026/04/04
// Copyright © 2026
// 规则效果度量服务

import { getLogger } from '@memforgeai/shared';
import type { RuleMetricsOverview } from '@memforgeai/shared';
import type { RulesPostgresStorage } from '../storage/postgres.js';

const logger = getLogger('metrics');

export class MetricsService {
  constructor(private storage: RulesPostgresStorage) {}

  async getOverview(
    timeRangeDays = 30,
    filters?: { teamFilter?: { teamIds: string[]; userId?: string }; projectIds?: string[] },
  ): Promise<RuleMetricsOverview> {
    const { rules: activeRules } = await this.storage.listRules({
      status: 'active',
      limit: 1000,
      ...(filters?.teamFilter ? { teamFilter: filters.teamFilter } : {}),
      ...(filters?.projectIds ? { projectIds: filters.projectIds } : {}),
    });
    const totalActiveRules = activeRules.length;

    const currentEvents = await this.storage.getGlobalEventCounts(timeRangeDays);
    const previousEvents = await this.storage.getGlobalEventCounts(timeRangeDays * 2);

    const currentViolations = currentEvents.violated;
    // 上一期间的违规 = 总的两倍期间 - 当前期间
    const previousViolations = previousEvents.violated - currentViolations;

    const totalApplied = currentEvents.applied + currentEvents.auto_fixed;
    const totalAccepted = currentEvents.accepted;
    const totalRejected = currentEvents.rejected;

    const adoptionRate = (totalAccepted + totalRejected) > 0
      ? totalAccepted / (totalAccepted + totalRejected)
      : 0;

    const violationChangePercent = previousViolations > 0
      ? ((currentViolations - previousViolations) / previousViolations) * 100
      : 0;

    const { active: activeCombos, total: totalCombos } = await this.storage.getCategoryLanguageCombinations();
    const coverageRate = totalCombos > 0 ? activeCombos / totalCombos : 0;

    // 违规最多的规则 top 5
    const topViolated = [...activeRules]
      .sort((a, b) => b.violatedCount - a.violatedCount)
      .slice(0, 5)
      .filter(r => r.violatedCount > 0)
      .map(r => ({ id: r.id, title: r.title, violatedCount: r.violatedCount }));

    // 采纳率最低的规则（有足够样本量）
    const leastAdopted = activeRules
      .filter(r => (r.acceptedCount + r.rejectedCount) >= 5)
      .map(r => ({
        id: r.id,
        title: r.title,
        adoptionRate: r.acceptedCount / (r.acceptedCount + r.rejectedCount),
      }))
      .sort((a, b) => a.adoptionRate - b.adoptionRate)
      .slice(0, 5);

    // 建议废弃：90 天内采纳率 < 20% 且样本量 >= 10
    const suggestedDeprecations = activeRules
      .filter(r => {
        const total = r.acceptedCount + r.rejectedCount;
        if (total < 10) return false;
        const rate = r.acceptedCount / total;
        return rate < 0.2;
      })
      .map(r => ({
        id: r.id,
        title: r.title,
        reason: `采纳率 ${Math.round((r.acceptedCount / (r.acceptedCount + r.rejectedCount)) * 100)}%（低于 20% 阈值），建议审查是否仍有必要`,
      }));

    logger.info({
      totalActiveRules, adoptionRate: Math.round(adoptionRate * 100),
      violations: currentViolations,
    }, '度量计算完成');

    return {
      totalActiveRules,
      totalApplied,
      totalViolations: currentViolations,
      adoptionRate: Math.round(adoptionRate * 100) / 100,
      violationTrend: {
        current: currentViolations,
        previous: previousViolations,
        changePercent: Math.round(violationChangePercent * 10) / 10,
      },
      coverageRate: Math.round(coverageRate * 100) / 100,
      topViolatedRules: topViolated,
      leastAdoptedRules: leastAdopted,
      suggestedDeprecations,
    };
  }

  async getRuleMetrics(ruleId: string, timeRangeDays = 30) {
    const rule = await this.storage.getRuleById(ruleId);
    if (!rule) return null;

    const currentViolated = await this.storage.getEventCountByType(ruleId, 'violated', timeRangeDays);
    const previousViolated = (await this.storage.getEventCountByType(ruleId, 'violated', timeRangeDays * 2)) - currentViolated;

    const adoptionRate = (rule.acceptedCount + rule.rejectedCount) > 0
      ? rule.acceptedCount / (rule.acceptedCount + rule.rejectedCount)
      : null;

    return {
      ruleId: rule.id,
      title: rule.title,
      status: rule.status,
      appliedCount: rule.appliedCount,
      violatedCount: rule.violatedCount,
      acceptedCount: rule.acceptedCount,
      rejectedCount: rule.rejectedCount,
      adoptionRate: adoptionRate !== null ? Math.round(adoptionRate * 100) / 100 : null,
      violationTrend: {
        current: currentViolated,
        previous: previousViolated,
        changePercent: previousViolated > 0
          ? Math.round(((currentViolated - previousViolated) / previousViolated) * 1000) / 10
          : 0,
      },
    };
  }
}
