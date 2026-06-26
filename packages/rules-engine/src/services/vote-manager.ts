// Created by dev on 2026/04/04
// Copyright © 2026
// 加权投票引擎：角色权重、阈值判定、一票否决、超时升级

import { getLogger } from '@memforgeai/shared';
import type { VoterRole, RulesConfig, Rule } from '@memforgeai/shared';
import type { RulesPostgresStorage } from '../storage/postgres.js';

const logger = getLogger('vote-manager');

export interface VoteResult {
  accepted: boolean;
  newStatus: 'voting' | 'active' | 'rejected';
  weightedScore: number;
  totalVoters: number;
  vetoed: boolean;
  vetoedBy?: string;
  needsMoreVotes: boolean;
  message: string;
}

export class VoteManager {
  constructor(
    private storage: RulesPostgresStorage,
    private config: RulesConfig,
  ) {}

  /**
   * 投票并检查是否达到激活/拒绝阈值。
   * 返回投票后的状态判定结果。
   */
  async castAndEvaluate(
    ruleId: string,
    userId: string,
    role: VoterRole,
    vote: -1 | 0 | 1,
    comment?: string,
  ): Promise<VoteResult> {
    const rule = await this.storage.getRuleById(ruleId);
    if (!rule) throw new Error('规则不存在');

    // 如果规则还在 candidate 状态，自动切换到 voting
    if (rule.status === 'candidate') {
      await this.storage.updateRuleStatus(ruleId, 'voting');
    } else if (rule.status !== 'voting') {
      throw new Error(`当前状态 ${rule.status} 不允许投票，仅 candidate/voting 可投票`);
    }

    await this.storage.castVote({ ruleId, userId, role, vote, comment: comment ?? null });

    return await this.evaluate(ruleId, rule);
  }

  /**
   * 评估投票状态，判断是否达到激活/拒绝条件
   */
  async evaluate(ruleId: string, rule?: Rule): Promise<VoteResult> {
    if (!rule) {
      rule = (await this.storage.getRuleById(ruleId))!;
    }

    const votes = await this.storage.getVotesForRule(ruleId);
    const { roleWeights, minVoters, passThreshold } = this.config.voting;

    let weightedApprove = 0;
    let weightedReject = 0;
    let vetoed = false;
    let vetoedBy: string | undefined;

    for (const v of votes) {
      const weight = roleWeights[v.role] ?? 1;

      if (v.vote === 1) {
        weightedApprove += weight;
      } else if (v.vote === -1) {
        weightedReject += weight;

        // admin 对 security 类规则有一票否决权
        if (v.role === 'admin' && rule.category === 'security') {
          vetoed = true;
          vetoedBy = v.userId;
        }
      }
    }

    const totalVoters = votes.length;
    const weightedScore = weightedApprove - weightedReject;

    // 一票否决
    if (vetoed) {
      await this.storage.updateRuleStatus(ruleId, 'rejected');
      await this.recordStatusEvent(ruleId, 'rejected', vetoedBy, { reason: 'admin_veto' });
      logger.info({ ruleId, vetoedBy }, 'security 规则被 admin 一票否决');
      return {
        accepted: false,
        newStatus: 'rejected',
        weightedScore,
        totalVoters,
        vetoed: true,
        vetoedBy,
        needsMoreVotes: false,
        message: `security 规则被 admin(${vetoedBy}) 一票否决。`,
      };
    }

    // 检查最小投票人数
    if (totalVoters < minVoters) {
      return {
        accepted: false,
        newStatus: 'voting',
        weightedScore,
        totalVoters,
        vetoed: false,
        needsMoreVotes: true,
        message: `还需要 ${minVoters - totalVoters} 人投票（当前 ${totalVoters}/${minVoters}）。`,
      };
    }

    // 检查加权通过阈值
    if (weightedScore >= passThreshold) {
      await this.storage.updateRuleStatus(ruleId, 'active');
      await this.recordStatusEvent(ruleId, 'accepted', undefined, { weightedScore, passThreshold });
      logger.info({ ruleId, weightedScore, passThreshold }, '规则投票通过，已激活');
      return {
        accepted: true,
        newStatus: 'active',
        weightedScore,
        totalVoters,
        vetoed: false,
        needsMoreVotes: false,
        message: `投票通过（加权得分 ${weightedScore} >= 阈值 ${passThreshold}），规则已激活。`,
      };
    }

    // 反对票过多 → 拒绝（加权反对 > 通过阈值的一半且反对 > 赞成）
    if (weightedReject > passThreshold / 2 && weightedReject > weightedApprove) {
      await this.storage.updateRuleStatus(ruleId, 'rejected');
      await this.recordStatusEvent(ruleId, 'rejected', undefined, { weightedReject, weightedApprove });
      logger.info({ ruleId, weightedReject, weightedApprove }, '规则投票被拒绝');
      return {
        accepted: false,
        newStatus: 'rejected',
        weightedScore,
        totalVoters,
        vetoed: false,
        needsMoreVotes: false,
        message: `投票未通过（加权反对 ${weightedReject} > 赞成 ${weightedApprove}），规则已拒绝。`,
      };
    }

    return {
      accepted: false,
      newStatus: 'voting',
      weightedScore,
      totalVoters,
      vetoed: false,
      needsMoreVotes: false,
      message: `投票进行中（加权得分 ${weightedScore}，需要 ${passThreshold} 通过）。`,
    };
  }

  /**
   * 投票结果确定后记录 accepted/rejected 事件，驱动度量数据。
   * 静默失败，不影响投票主流程。
   */
  private async recordStatusEvent(
    ruleId: string,
    eventType: 'accepted' | 'rejected',
    userId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.storage.recordEvent({
        ruleId,
        eventType,
        filePath: null,
        codeSnippet: null,
        userId: userId ?? null,
        metadata: { source: 'vote_evaluation', ...metadata },
      });
    } catch (err) {
      logger.warn({ err: String(err), ruleId, eventType }, '记录投票结果事件失败（不影响投票流程）');
    }
  }

  /**
   * 检查超时投票并自动升级
   */
  async checkTimeouts(): Promise<Array<{ ruleId: string; title: string; action: string }>> {
    const timedOut = await this.storage.getTimedOutVotingRules(this.config.voting.timeoutDays);
    const results: Array<{ ruleId: string; title: string; action: string }> = [];

    const { minVoters } = this.config.voting;

    for (const rule of timedOut) {
      const evaluation = await this.evaluate(rule.id, rule);

      if (evaluation.weightedScore > 0 && evaluation.totalVoters >= minVoters) {
        await this.storage.updateRuleStatus(rule.id, 'active');
        await this.recordStatusEvent(rule.id, 'accepted', undefined, { reason: 'timeout_auto_activate' });
        results.push({ ruleId: rule.id, title: rule.title, action: '超时自动激活（有正向投票且满足最低人数）' });
      } else {
        const reason = evaluation.totalVoters < minVoters
          ? `投票人数不足 (${evaluation.totalVoters}/${minVoters})`
          : `得分 ${evaluation.weightedScore}`;
        results.push({ ruleId: rule.id, title: rule.title, action: `超时待 admin 决定（${reason}）` });
      }
    }

    if (results.length > 0) {
      logger.info({ count: results.length }, '处理超时投票规则');
    }

    return results;
  }
}
