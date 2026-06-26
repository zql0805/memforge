// Created by dev on 2026/05/09
// Git 历史知识引擎 — 模块入口

export { GitChangeEngine } from './git-change-engine.js';
export { classifyCommit, parseNameStatus, parseDiffNumstat, buildMemoryContent } from './commit-classifier.js';
export { getGitStats, getProductLineStats, upsertGitStats, updateActivityMetrics, updateFetchStatus, getHealthAlerts } from './stats-store.js';
export { LlmAnalyzer, enrichContentWithAnalysis } from './llm-analyzer.js';
export { execGit, getCommitStats, getTotalStats, getHotFiles, buildContributorStats, checkRemoteStatus } from './git-helpers.js';
export type {
  CommitInfo, FileChange, CommitClassification, CommitCategory,
  RepoTarget, ProjectGitStats, HotFile, ContributorStat,
  GitEngineConfig, BootstrapProgress,
} from './types.js';
export { DEFAULT_ENGINE_CONFIG } from './types.js';
