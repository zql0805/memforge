// Created by dev on 2026/05/09
// Git 历史知识引擎 — project_git_stats 存储层

import { getLogger, getPool } from '@memforgeai/shared';
import type { ProjectGitStats, HotFile, ContributorStat } from './types.js';

const logger = getLogger('git-engine:stats-store');

/**
 * 获取指定仓库的 Git 统计
 */
export async function getGitStats(productLine: string, repoId: string): Promise<ProjectGitStats | null> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM memory.project_git_stats WHERE product_line = $1 AND repo_id = $2`,
      [productLine, repoId],
    );
    if (rows.length === 0) return null;
    return rowToStats(rows[0]);
  } catch (err) {
    logger.warn({ productLine, repoId, err: (err as Error).message }, 'getGitStats 查询失败');
    return null;
  }
}

/**
 * 获取产品线下所有仓库的 Git 统计
 */
export async function getProductLineStats(productLine: string): Promise<ProjectGitStats[]> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM memory.project_git_stats WHERE product_line = $1 ORDER BY last_commit_at DESC NULLS LAST`,
      [productLine],
    );
    return rows.map(rowToStats);
  } catch (err) {
    logger.warn({ productLine, err: (err as Error).message }, 'getProductLineStats 查询失败');
    return [];
  }
}

/**
 * Upsert 仓库的 Git 统计
 */
export async function upsertGitStats(stats: Partial<ProjectGitStats> & { productLine: string; repoId: string }): Promise<void> {
  const pool = getPool();
  const setClauses: string[] = [];
  const values: unknown[] = [stats.productLine, stats.repoId];
  let idx = 3;

  const fieldMap: Record<string, string> = {
    latestLocalHash: 'latest_local_hash',
    latestRemoteHash: 'latest_remote_hash',
    localBehindCount: 'local_behind_count',
    defaultBranch: 'default_branch',
    commitsLast7d: 'commits_last_7d',
    commitsLast30d: 'commits_last_30d',
    activeContributors7d: 'active_contributors_7d',
    activeContributors30d: 'active_contributors_30d',
    hotFiles30d: 'hot_files_30d',
    firstCommitAt: 'first_commit_at',
    lastCommitAt: 'last_commit_at',
    totalCommits: 'total_commits',
    topContributors: 'top_contributors',
    lastFetchedAt: 'last_fetched_at',
    lastAnalyzedAt: 'last_analyzed_at',
    metadata: 'metadata',
  };

  const jsonbCols = new Set(['hot_files_30d', 'top_contributors', 'metadata']);
  for (const [key, col] of Object.entries(fieldMap)) {
    const val = (stats as Record<string, unknown>)[key];
    if (val !== undefined) {
      setClauses.push(`${col} = $${idx}`);
      values.push(jsonbCols.has(col) && typeof val === 'object' ? JSON.stringify(val) : val);
      idx++;
    }
  }

  if (setClauses.length === 0) return;

  const insertCols = setClauses.map(s => s.split(' = ')[0]);
  const insertVals = setClauses.map(s => s.split(' = ')[1]);

  await pool.query(
    `INSERT INTO memory.project_git_stats (product_line, repo_id, ${insertCols.join(', ')})
     VALUES ($1, $2, ${insertVals.join(', ')})
     ON CONFLICT (product_line, repo_id)
     DO UPDATE SET ${setClauses.join(', ')}, updated_at = NOW()`,
    values,
  );

  logger.debug({ productLine: stats.productLine, repoId: stats.repoId }, 'Git 统计已更新');
}

/**
 * 批量更新活跃度指标（适用于聚合器定期执行）
 */
export async function updateActivityMetrics(
  productLine: string,
  repoId: string,
  metrics: {
    commitsLast7d: number;
    commitsLast30d: number;
    activeContributors7d: number;
    activeContributors30d: number;
    hotFiles30d: HotFile[];
    topContributors: ContributorStat[];
    totalCommits: number;
    firstCommitAt: Date | null;
    lastCommitAt: Date | null;
  },
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO memory.project_git_stats (
       product_line, repo_id,
       commits_last_7d, commits_last_30d,
       active_contributors_7d, active_contributors_30d,
       hot_files_30d, top_contributors,
       total_commits, first_commit_at, last_commit_at,
       last_analyzed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT (product_line, repo_id)
     DO UPDATE SET
       commits_last_7d = $3, commits_last_30d = $4,
       active_contributors_7d = $5, active_contributors_30d = $6,
       hot_files_30d = $7, top_contributors = $8,
       total_commits = $9, first_commit_at = COALESCE($10, memory.project_git_stats.first_commit_at),
       last_commit_at = COALESCE($11, memory.project_git_stats.last_commit_at),
       last_analyzed_at = NOW(), updated_at = NOW()`,
    [
      productLine, repoId,
      metrics.commitsLast7d, metrics.commitsLast30d,
      metrics.activeContributors7d, metrics.activeContributors30d,
      JSON.stringify(metrics.hotFiles30d), JSON.stringify(metrics.topContributors),
      metrics.totalCommits, metrics.firstCommitAt, metrics.lastCommitAt,
    ],
  );
}

/**
 * 更新 fetch 状态（远程检测结果）
 */
export async function updateFetchStatus(
  productLine: string,
  repoId: string,
  latestLocalHash: string,
  latestRemoteHash: string | null,
  localBehindCount: number,
  defaultBranch: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO memory.project_git_stats (
       product_line, repo_id, latest_local_hash, latest_remote_hash,
       local_behind_count, default_branch, last_fetched_at
     ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (product_line, repo_id)
     DO UPDATE SET
       latest_local_hash = $3, latest_remote_hash = $4,
       local_behind_count = $5, default_branch = $6,
       last_fetched_at = NOW(), updated_at = NOW()`,
    [productLine, repoId, latestLocalHash, latestRemoteHash, localBehindCount, defaultBranch],
  );
}

/**
 * 获取产品线下的健康度预警
 */
interface HealthAlert {
  type: 'stale' | 'hot' | 'single_maintainer';
  severity: 'critical' | 'warning' | 'info';
  repoId: string;
  message: string;
  detail: string;
}

export async function getHealthAlerts(productLine: string): Promise<HealthAlert[]> {
  const pool = getPool();
  const alerts: HealthAlert[] = [];

  const { rows: staleRows } = await pool.query<{ repo_id: string; days: number }>(
    `SELECT repo_id, EXTRACT(DAY FROM NOW() - last_commit_at)::int as days
     FROM memory.project_git_stats
     WHERE product_line = $1 AND last_commit_at IS NOT NULL
       AND last_commit_at < NOW() - INTERVAL '30 days'
     ORDER BY last_commit_at ASC
     LIMIT 10`,
    [productLine],
  );
  for (const r of staleRows) {
    const severity = r.days > 90 ? 'critical' as const : 'warning' as const;
    alerts.push({ type: 'stale', severity, repoId: r.repo_id, message: `${r.repo_id.split('/').pop()} 已 ${r.days} 天无提交`, detail: `${r.days} 天无提交` });
  }

  const { rows: hotRows } = await pool.query<{ repo_id: string; c7: number }>(
    `SELECT repo_id, commits_last_7d as c7
     FROM memory.project_git_stats
     WHERE product_line = $1 AND commits_last_7d >= 20
     ORDER BY commits_last_7d DESC
     LIMIT 10`,
    [productLine],
  );
  for (const r of hotRows) {
    alerts.push({ type: 'hot', severity: 'info', repoId: r.repo_id, message: `${r.repo_id.split('/').pop()} 7 天内 ${r.c7} 次提交`, detail: `7 天内 ${r.c7} 次提交` });
  }

  const { rows: singleRows } = await pool.query<{ repo_id: string }>(
    `SELECT repo_id
     FROM memory.project_git_stats
     WHERE product_line = $1 AND active_contributors_30d = 1 AND commits_last_30d > 5`,
    [productLine],
  );
  for (const r of singleRows) {
    alerts.push({ type: 'single_maintainer', severity: 'warning', repoId: r.repo_id, message: `${r.repo_id.split('/').pop()} 仅 1 人维护`, detail: '仅 1 人维护' });
  }

  return alerts;
}

function safeParseJsonb<T>(val: unknown, fallback: T): T {
  if (val == null) return fallback;
  if (typeof val === 'string') {
    try { return JSON.parse(val) as T; } catch { return fallback; }
  }
  return val as T;
}

function rowToStats(row: Record<string, unknown>): ProjectGitStats {
  return {
    productLine: row.product_line as string,
    repoId: row.repo_id as string,
    latestLocalHash: row.latest_local_hash as string | null,
    latestRemoteHash: row.latest_remote_hash as string | null,
    localBehindCount: (row.local_behind_count as number) ?? 0,
    defaultBranch: (row.default_branch as string) ?? 'main',
    commitsLast7d: (row.commits_last_7d as number) ?? 0,
    commitsLast30d: (row.commits_last_30d as number) ?? 0,
    activeContributors7d: (row.active_contributors_7d as number) ?? 0,
    activeContributors30d: (row.active_contributors_30d as number) ?? 0,
    hotFiles30d: safeParseJsonb<HotFile[]>(row.hot_files_30d, []),
    firstCommitAt: row.first_commit_at ? new Date(row.first_commit_at as string) : null,
    lastCommitAt: row.last_commit_at ? new Date(row.last_commit_at as string) : null,
    totalCommits: (row.total_commits as number) ?? 0,
    topContributors: safeParseJsonb<ContributorStat[]>(row.top_contributors, []),
    lastFetchedAt: row.last_fetched_at ? new Date(row.last_fetched_at as string) : null,
    lastAnalyzedAt: row.last_analyzed_at ? new Date(row.last_analyzed_at as string) : null,
    metadata: safeParseJsonb<Record<string, unknown>>(row.metadata, {}),
  };
}
