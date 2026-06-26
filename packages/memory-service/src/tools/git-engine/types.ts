// Created by dev on 2026/05/09
// Git 历史知识引擎 — 核心类型定义

import type { MemoryScope, MemorySource } from '@memforgeai/shared';

// ── 提交信息 ──────────────────────────────────────

export interface CommitInfo {
  hash: string;
  subject: string;
  author: string;
  date: string;
  body: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: FileChange[];
}

export interface FileChange {
  status: 'A' | 'M' | 'D' | 'R' | 'C';
  file: string;
  oldFile?: string;
}

// ── 分类结果 ──────────────────────────────────────

export interface CommitClassification {
  category: CommitCategory;
  scope: MemoryScope;
  source: MemorySource;
  visibility: 'global' | 'product_line' | 'personal';
  /** Layer 2 LLM 分析是否值得触发 */
  shouldDeepAnalyze: boolean;
  /** 触发 Layer 2 的原因 */
  deepAnalyzeReason?: string;
}

export type CommitCategory =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'migration'
  | 'security'
  | 'performance'
  | 'infra'
  | 'docs'
  | 'style'
  | 'test'
  | 'chore'
  | 'notable';

// ── 仓库目标 ──────────────────────────────────────

export interface RepoTarget {
  localPath: string;
  repoId: string;
  productLine: string;
  techStack?: string;
}

// ── 变更事件 ──────────────────────────────────────

export interface ChangeEvent {
  type: 'local_commit' | 'remote_update' | 'manual_trigger';
  repo: RepoTarget;
  commits: CommitInfo[];
  /** 远程检测时：本地落后的提交数 */
  behindCount?: number;
  /** 远程检测时：远程 HEAD hash */
  remoteHead?: string;
  timestamp: Date;
}

// ── Git 统计（对应 project_git_stats 表行） ──────

export interface ProjectGitStats {
  productLine: string;
  repoId: string;
  latestLocalHash: string | null;
  latestRemoteHash: string | null;
  localBehindCount: number;
  defaultBranch: string;
  commitsLast7d: number;
  commitsLast30d: number;
  activeContributors7d: number;
  activeContributors30d: number;
  hotFiles30d: HotFile[];
  firstCommitAt: Date | null;
  lastCommitAt: Date | null;
  totalCommits: number;
  topContributors: ContributorStat[];
  lastFetchedAt: Date | null;
  lastAnalyzedAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface HotFile {
  file: string;
  count: number;
  lastModified: string;
}

export interface ContributorStat {
  name: string;
  commits: number;
  lastActive: string;
}

// ── 引擎配置 ──────────────────────────────────────

export interface GitEngineConfig {
  /** 轮询间隔（毫秒） */
  pollIntervalMs: number;
  /** 每仓库每轮最大处理提交数 */
  maxCommitsPerCycle: number;
  /** 是否启用远程 fetch（需要网络） */
  enableRemoteFetch: boolean;
  /** Layer 2 LLM 分析每日预算 */
  llmDailyBudget: number;
}

export const DEFAULT_ENGINE_CONFIG: GitEngineConfig = {
  pollIntervalMs: 6 * 60 * 60 * 1000,
  maxCommitsPerCycle: 100,
  enableRemoteFetch: true,
  llmDailyBudget: 50,
};

// ── Bootstrap 进度 ──────────────────────────────────

export interface BootstrapProgress {
  totalCommits: number;
  processedCommits: number;
  lastProcessedHash: string | null;
  progressPercent: number;
  storedMemories: number;
  llmCallsUsed: number;
  startedAt: string;
  estimatedCompletion?: string;
}
