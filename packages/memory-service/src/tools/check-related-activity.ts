// Created by dev on 2026/05/14
// MCP 工具: check_related_activity — 检查关联仓库的近期他人提交
// 用于工作过程中发现可能影响当前工作的上下游变更

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, getPool } from '@memforgeai/shared';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:check-related-activity');

interface RelatedCommit {
  repoId: string;
  relation: string;
  title: string;
  author: string;
  category: string;
  date: string;
  memoryId: string;
}

interface ActivityReport {
  targetRepos: string[];
  relatedRepos: string[];
  recentActivity: RelatedCommit[];
  riskAlerts: string[];
}

export function registerCheckRelatedActivity(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'check_related_activity',
    '检查当前工作涉及的仓库的上下游近期提交，发现可能影响当前工作的他人变更。支持传入工作上下文 ID 或直接指定仓库列表。',
    {
      context_id: z.string().optional().describe('工作上下文 ID（自动提取涉及的仓库列表）'),
      repo_ids: z.array(z.string()).optional().describe('直接指定仓库 ID 列表（优先于 context_id）'),
      product_line: z.string().optional().describe('产品线'),
      days: z.number().optional().describe('查看最近 N 天的活动，默认 7'),
    },
    async ({ context_id, repo_ids, product_line, days }) => {
      try {
        const lookbackDays = days ?? 7;
        let targetRepos: string[] = repo_ids ?? [];

        if (targetRepos.length === 0 && context_id) {
          const existing = await ctx.storage.getById(context_id);
          if (!existing) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: `工作上下文 ${context_id} 不存在` }),
              }],
            };
          }
          const meta = existing.metadata as Record<string, unknown>;
          const projects = (meta.projects as Array<{ name: string }>) ?? [];
          targetRepos = projects.map(p => p.name);
        }

        if (targetRepos.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: '未指定仓库。请传入 context_id 或 repo_ids。' }),
            }],
          };
        }

        const report = await buildActivityReport(targetRepos, product_line ?? null, lookbackDays, ctx.userId);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              ...report,
              hint: report.riskAlerts.length > 0
                ? '发现潜在风险，建议关注上述变更是否影响当前工作。'
                : '近期关联仓库无高风险变更。',
            }, null, 2),
          }],
        };
      } catch (err) {
        logger.error({ error: err }, 'check_related_activity 失败');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: (err as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );
}

async function buildActivityReport(
  targetRepos: string[],
  productLine: string | null,
  days: number,
  currentUserId: string | null,
): Promise<ActivityReport> {
  const pool = getPool();

  // 1. 查找关联仓库（拓扑上下游）
  let relatedRepos: string[] = [];
  try {
    const plFilter = productLine ? ` AND tn.product_line = $2` : '';
    const plBind = productLine ? [productLine] : [];

    const { rows } = await pool.query<{ related_repo: string; relation: string }>(`
      SELECT DISTINCT
        CASE WHEN te.source_repo_id = ANY($1) THEN te.target_repo_id
             ELSE te.source_repo_id END AS related_repo,
        te.protocol AS relation
      FROM memory.topology_edges te
      JOIN memory.topology_nodes tn ON tn.repo_id = te.source_repo_id OR tn.repo_id = te.target_repo_id
      WHERE (te.source_repo_id = ANY($1) OR te.target_repo_id = ANY($1))
        AND NOT (te.source_repo_id = ANY($1) AND te.target_repo_id = ANY($1))
        ${plFilter}
    `, [targetRepos, ...plBind]);

    relatedRepos = [...new Set(rows.map(r => r.related_repo))];
  } catch {
    // 拓扑表可能不存在
  }

  const allRepos = [...new Set([...targetRepos, ...relatedRepos])];

  // 2. 查询近期 from-commit 记忆（排除当前用户的提交，仅显示他人变更）
  let userFilter = '';
  const queryBindings: unknown[] = [allRepos, days];
  if (currentUserId) {
    userFilter = ` AND (created_by IS NULL OR created_by != $3)`;
    queryBindings.push(currentUserId);
  }
  const { rows: commits } = await pool.query<{
    id: string;
    title: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }>(`
    SELECT id, title, metadata, created_at::text
    FROM memory.entries
    WHERE tags @> ARRAY['from-commit']
      AND is_archived = false
      AND created_at >= NOW() - make_interval(days => $2)
      AND COALESCE(metadata->>'source_repo_id', metadata->>'repo_id') = ANY($1)
      ${userFilter}
    ORDER BY created_at DESC
    LIMIT 50
  `, queryBindings);

  const recentActivity: RelatedCommit[] = [];
  const riskAlerts: string[] = [];

  for (const c of commits) {
    const repoId = (c.metadata.source_repo_id as string) ?? (c.metadata.repo_id as string) ?? 'unknown';
    const author = (c.metadata.author as string) ?? (c.metadata.commitAuthor as string) ?? 'unknown';
    const category = (c.metadata.category as string) ?? 'unknown';
    const isRelated = relatedRepos.includes(repoId);
    const relation = isRelated ? 'upstream/downstream' : 'same-repo';

    recentActivity.push({
      repoId,
      relation,
      title: c.title,
      author,
      category,
      date: c.created_at.split('T')[0],
      memoryId: c.id,
    });

    // 风险判断
    if (category === 'migration' || category === 'security') {
      riskAlerts.push(`[${category.toUpperCase()}] ${repoId}: ${c.title}（by ${author}）`);
    }
    if (isRelated && (category === 'bugfix' || category === 'refactor')) {
      riskAlerts.push(`[关联仓库变更] ${repoId}(${relation}): ${c.title}（by ${author}）— 可能影响接口兼容性`);
    }
  }

  return {
    targetRepos,
    relatedRepos,
    recentActivity,
    riskAlerts,
  };
}
