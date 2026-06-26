// Created by dev on 2026/04/07
// Copyright © 2026
// MCP 工具: get_developer_profile — 从实际工作数据自动生成开发者画像

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, getPool } from '@memforgeai/shared';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:developer-profile');

interface ScopeStat { scope: string; count: number }
interface TagStat { tag: string; count: number }
interface MonthlyActivity { month: string; count: number }
interface ReviewStat { category: string; severity: string; count: number }
interface WorkStat { work_type: string; status: string; count: number; avg_hours: number | null }

interface GitContribRepo {
  repoId: string;
  productLine: string;
  totalCommits: number;
  lastCommitAt: string | null;
}

interface GitCategoryStat { category: string; count: number }

interface GitActivitySummary {
  autoLearnedMemories: number;
  llmAnalyzedCount: number;
  coveredRepos: number;
  categoryDistribution: GitCategoryStat[];
  topContributedRepos: GitContribRepo[];
}

interface DeveloperProfile {
  userId: string | null;
  overview: {
    totalMemories: number;
    totalRules: number;
    totalRelations: number;
    totalWorkContexts: number;
    memberSince: string | null;
    lastActivity: string | null;
  };
  knowledgeDomains: ScopeStat[];
  techStack: TagStat[];
  monthlyActivity: MonthlyActivity[];
  reviewInsights: ReviewStat[];
  workPatterns: WorkStat[];
  gitActivity: GitActivitySummary;
  strengths: string[];
  improvements: string[];
}

export function registerGetDeveloperProfile(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'get_developer_profile',
    '从实际工作数据（记忆、规则、Code Review、工作上下文）自动生成开发者画像，展示技术能力分布、知识领域、成长轨迹和改进方向。多用户部署时自动按当前用户过滤。',
    {
      product_line: z.string().optional().describe('产品线过滤'),
      user_id: z.string().optional().describe('指定用户 ID（默认使用当前登录用户，管理员可查看其他用户画像）'),
    },
    async ({ product_line, user_id }) => {
      try {
        const effectiveUserId = user_id ?? ctx.userId;
        if (user_id && user_id !== ctx.userId && ctx.userRole !== 'admin') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: '仅 admin 角色可查看其他用户的开发者画像。' }),
            }],
          };
        }
        const profile = await buildProfile(effectiveUserId, product_line);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, ...profile }, null, 2),
          }],
        };
      } catch (err) {
        logger.error({ error: err }, '生成开发者画像失败');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: (err as Error).message,
            }),
          }],
        };
      }
    },
  );
}

/**
 * 构建 SQL 条件片段和绑定参数。
 * userId 非空时追加 created_by 过滤（画像仅统计该用户的贡献），
 * 为空时回退到全库聚合（单用户部署或管理员查看全局）。
 * @param columnPrefix 表别名前缀（如 'e'），生成 'e.created_by'
 */
function buildUserFilter(
  userId: string | null,
  startIdx: number,
  columnPrefix?: string,
): { clause: string; bindings: unknown[]; nextIdx: number } {
  if (!userId) return { clause: '', bindings: [], nextIdx: startIdx };
  const col = columnPrefix ? `${columnPrefix}.created_by` : 'created_by';
  return {
    clause: ` AND (${col} = $${startIdx} OR ${col} IS NULL)`,
    bindings: [userId],
    nextIdx: startIdx + 1,
  };
}

async function buildProfile(userId: string | null, productLine?: string): Promise<DeveloperProfile> {
  const pool = getPool();

  const uf1 = buildUserFilter(userId, 1);
  const ufAliased = buildUserFilter(userId, 1, 'e');

  // 产品线过滤子句（仅在指定产品线时启用）
  let plClause1 = '';
  let plClauseAliased = '';
  const plBindings1: unknown[] = [];
  const plBindingsAliased: unknown[] = [];
  if (productLine) {
    const plIdx1 = uf1.nextIdx;
    plClause1 = ` AND project_id = $${plIdx1}`;
    plBindings1.push(productLine);
    const plIdxA = ufAliased.nextIdx;
    plClauseAliased = ` AND e.project_id = $${plIdxA}`;
    plBindingsAliased.push(productLine);
  }

  // 1. 概览统计
  const ufRules = buildUserFilter(userId, 1);
  const ufRelSource = buildUserFilter(userId, 1, 'es');
  const { rows: [overview] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM memory.entries WHERE is_archived = false${uf1.clause}${plClause1}) as total_memories,
      (SELECT COUNT(*) FROM memory.rules WHERE TRUE${ufRules.clause}) as total_rules,
      (SELECT COUNT(*) FROM memory.knowledge_relations kr
        LEFT JOIN memory.entries es ON kr.source_id::uuid = es.id
        WHERE TRUE${ufRelSource.clause}) as total_relations,
      (SELECT COUNT(*) FROM memory.entries WHERE scope = 'task_progress' AND is_archived = false${uf1.clause}${plClause1}) as total_work_contexts,
      (SELECT MIN(created_at)::text FROM memory.entries WHERE is_archived = false${uf1.clause}${plClause1}) as member_since,
      (SELECT MAX(updated_at)::text FROM memory.entries WHERE is_archived = false${uf1.clause}${plClause1}) as last_activity
  `, [...uf1.bindings, ...plBindings1]);

  // 2. 知识领域分布 (按 scope)
  const { rows: knowledgeDomains } = await pool.query(`
    SELECT scope, COUNT(*)::int as count
    FROM memory.entries
    WHERE is_archived = false AND scope != 'task_progress'${uf1.clause}${plClause1}
    GROUP BY scope
    ORDER BY count DESC
  `, [...uf1.bindings, ...plBindings1]);

  // 3. 技术栈分布 (从 tags 提取)
  const { rows: techStack } = await pool.query(`
    SELECT tag, COUNT(*)::int as count
    FROM memory.entries, unnest(tags) as tag
    WHERE is_archived = false${uf1.clause}${plClause1}
      AND tag NOT IN ('work-context', 'session-summary', 'topology', 'bootstrap', 'document')
      AND tag NOT LIKE 'pl:%'
      AND tag NOT LIKE 'file:%'
      AND LENGTH(tag) > 1
    GROUP BY tag
    ORDER BY count DESC
    LIMIT 30
  `, [...uf1.bindings, ...plBindings1]);

  // 4. 月度活动 (最近 12 个月)
  const { rows: monthlyActivity } = await pool.query(`
    SELECT to_char(created_at, 'YYYY-MM') as month, COUNT(*)::int as count
    FROM memory.entries
    WHERE is_archived = false${uf1.clause}${plClause1}
      AND created_at >= NOW() - INTERVAL '12 months'
    GROUP BY month
    ORDER BY month ASC
  `, [...uf1.bindings, ...plBindings1]);

  // 5. Code Review 洞察
  const { rows: reviewInsights } = await pool.query(`
    SELECT
      COALESCE(e.metadata->>'review_category', 'general') as category,
      COALESCE(e.metadata->>'severity', 'info') as severity,
      COUNT(*)::int as count
    FROM memory.entries e
    WHERE e.source IN ('code_review', 'auto_code_review')
      AND e.is_archived = false${ufAliased.clause}${plClauseAliased}
    GROUP BY category, severity
    ORDER BY count DESC
    LIMIT 20
  `, [...ufAliased.bindings, ...plBindingsAliased]);

  // 6. 工作模式 (从工作上下文)
  const { rows: workPatterns } = await pool.query(`
    SELECT
      COALESCE(e.metadata->>'work_type', 'unknown') as work_type,
      COALESCE(e.metadata->>'status', 'unknown') as status,
      COUNT(*)::int as count,
      ROUND(AVG(
        CASE WHEN e.metadata->'evaluation' IS NOT NULL
        THEN (e.metadata->'evaluation'->>'duration_hours')::numeric
        ELSE NULL END
      )::numeric, 1) as avg_hours
    FROM memory.entries e
    WHERE e.scope = 'task_progress'
      AND e.is_archived = false${ufAliased.clause}${plClauseAliased}
    GROUP BY work_type, status
    ORDER BY count DESC
  `, [...ufAliased.bindings, ...plBindingsAliased]);

  // 7. Git 活跃度（从 from-commit 标签记忆 + project_git_stats 聚合）
  const { rows: [gitOverviewRow] } = await pool.query(`
    SELECT
      COUNT(*)::int AS auto_learned,
      COUNT(*) FILTER (WHERE metadata->>'llm_analyzed' = 'true')::int AS llm_analyzed,
      COUNT(DISTINCT COALESCE(metadata->>'source_repo_id', metadata->>'repo_id')) FILTER (WHERE COALESCE(metadata->>'source_repo_id', metadata->>'repo_id') IS NOT NULL)::int AS covered_repos
    FROM memory.entries
    WHERE tags @> ARRAY['from-commit'] AND is_archived = false${uf1.clause}${plClause1}
  `, [...uf1.bindings, ...plBindings1]);

  const { rows: gitCategoryDist } = await pool.query(`
    SELECT COALESCE(metadata->>'category', 'unknown') AS category, COUNT(*)::int AS count
    FROM memory.entries
    WHERE tags @> ARRAY['from-commit'] AND is_archived = false${uf1.clause}${plClause1}
    GROUP BY category ORDER BY count DESC LIMIT 10
  `, [...uf1.bindings, ...plBindings1]);

  let topContributedRepos: GitContribRepo[] = [];
  try {
    // 从个人 from-commit 记忆中按 repo 聚合，而非全局 project_git_stats
    const { rows } = await pool.query<{
      repo_id: string; product_line: string;
      total_commits: number; last_commit_at: string | null;
    }>(`
      SELECT metadata->>'source_repo_id' AS repo_id,
             COALESCE(metadata->>'source_product_line', project_id) AS product_line,
             COUNT(*)::int AS total_commits,
             MAX(created_at)::text AS last_commit_at
      FROM memory.entries
      WHERE tags @> ARRAY['from-commit'] AND is_archived = false
        AND metadata->>'source_repo_id' IS NOT NULL
        ${uf1.clause}${plClause1}
      GROUP BY repo_id, product_line
      ORDER BY total_commits DESC LIMIT 10
    `, [...uf1.bindings, ...plBindings1]);
    topContributedRepos = rows.map(r => ({
      repoId: r.repo_id, productLine: r.product_line,
      totalCommits: r.total_commits, lastCommitAt: r.last_commit_at,
    }));
  } catch { /* from-commit 记忆可能尚未生成 */ }

  const gitActivity: GitActivitySummary = {
    autoLearnedMemories: gitOverviewRow?.auto_learned ?? 0,
    llmAnalyzedCount: gitOverviewRow?.llm_analyzed ?? 0,
    coveredRepos: gitOverviewRow?.covered_repos ?? 0,
    categoryDistribution: gitCategoryDist as GitCategoryStat[],
    topContributedRepos,
  };

  // 8. 分析优势和改进方向
  const strengths: string[] = [];
  const improvements: string[] = [];

  const scopeMap: Record<string, string> = {
    architecture: '系统架构',
    domain_knowledge: '业务领域知识',
    bug_pattern: 'Bug 模式识别',
    coding_standard: '编码规范',
    performance_insight: '性能优化',
    lesson_learned: '经验总结',
    convention: '团队约定',
    tool_usage: '工具使用',
    review_insight: '代码审查',
  };

  const domainCounts = knowledgeDomains as ScopeStat[];
  if (domainCounts.length > 0) {
    const maxCount = domainCounts[0].count;
    for (const d of domainCounts) {
      const label = scopeMap[d.scope] || d.scope;
      if (d.count >= maxCount * 0.6) {
        strengths.push(`${label}知识丰富（${d.count} 条记忆）`);
      }
    }

    const allScopes = Object.keys(scopeMap);
    const existingScopes = new Set(domainCounts.map(d => d.scope));
    for (const scope of allScopes) {
      if (!existingScopes.has(scope)) {
        improvements.push(`「${scopeMap[scope]}」领域暂无积累，建议在相关工作中主动记录`);
      }
    }
    for (const d of domainCounts) {
      const label = scopeMap[d.scope] || d.scope;
      if (d.count < 5 && d.count > 0) {
        improvements.push(`「${label}」积累较少（仅 ${d.count} 条），建议持续补充`);
      }
    }
  }

  if (overview.total_rules < 20) {
    improvements.push(`编码规则较少（${overview.total_rules} 条），建议从 Code Review 中提炼更多规则`);
  } else {
    strengths.push(`已建立 ${overview.total_rules} 条编码规则，规范化程度较好`);
  }

  if (overview.total_relations < 20) {
    improvements.push('知识关联较少，建议使用知识图谱功能建立更多记忆间的关联');
  }

  const workCompleted = (workPatterns as WorkStat[]).filter(w => w.status === 'completed');
  if (workCompleted.length > 0) {
    const totalCompleted = workCompleted.reduce((s, w) => s + w.count, 0);
    strengths.push(`已完成 ${totalCompleted} 个工作上下文追踪，工作流程规范`);
  }

  if (gitActivity.autoLearnedMemories > 50) {
    strengths.push(`Git 历史学习活跃（${gitActivity.autoLearnedMemories} 条自动提取记忆，覆盖 ${gitActivity.coveredRepos} 个仓库）`);
  } else if (gitActivity.autoLearnedMemories === 0) {
    improvements.push('尚未启用 Git 历史学习，建议对核心仓库运行 bootstrap_project_history 提取知识');
  }

  if (gitActivity.llmAnalyzedCount > 0) {
    strengths.push(`${gitActivity.llmAnalyzedCount} 个重要提交已获得 LLM 深度分析`);
  }

  return {
    userId,
    overview: {
      totalMemories: Number(overview.total_memories),
      totalRules: Number(overview.total_rules),
      totalRelations: Number(overview.total_relations),
      totalWorkContexts: Number(overview.total_work_contexts),
      memberSince: overview.member_since,
      lastActivity: overview.last_activity,
    },
    knowledgeDomains: domainCounts,
    techStack: techStack as TagStat[],
    monthlyActivity: monthlyActivity as MonthlyActivity[],
    reviewInsights: reviewInsights as ReviewStat[],
    workPatterns: workPatterns as WorkStat[],
    gitActivity,
    strengths,
    improvements,
  };
}
