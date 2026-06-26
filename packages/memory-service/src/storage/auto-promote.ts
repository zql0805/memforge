import { getPool, getLogger } from '@memforgeai/shared';
import { writeToKnowledge } from './storage-router.js';

const logger = getLogger('storage:auto-promote');

const PROMOTABLE_SCOPES = ['bug_pattern', 'performance_insight', 'lesson_learned'];
const PROMOTION_THRESHOLD = 3;

const SCOPE_TO_KNOWLEDGE_TYPE: Record<string, string> = {
  bug_pattern: 'troubleshooting',
  performance_insight: 'technical',
  lesson_learned: 'technical',
};

export async function incrementRecallCount(entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) return;

  const pool = getPool();
  const placeholders = entryIds.map((_, i) => `$${i + 1}`).join(',');

  try {
    await pool.query(
      `UPDATE memory.entries
       SET metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{recall_count}',
         (COALESCE((metadata->>'recall_count')::int, 0) + 1)::text::jsonb
       )
       WHERE id IN (${placeholders}) AND is_archived = false`,
      entryIds,
    );
  } catch (err) {
    logger.warn({ err }, 'recall_count 更新失败');
  }
}

export async function checkAndPromote(entryIds: string[]): Promise<number> {
  if (entryIds.length === 0) return 0;

  const pool = getPool();
  const placeholders = entryIds.map((_, i) => `$${i + 1}`).join(',');

  try {
    const { rows: candidates } = await pool.query(
      `SELECT id, project_id, title, content, scope, tags,
              COALESCE((metadata->>'recall_count')::int, 0) AS recall_count,
              metadata, team_id, org_id, visibility
       FROM memory.entries
       WHERE id IN (${placeholders})
         AND scope = ANY($${entryIds.length + 1})
         AND COALESCE((metadata->>'recall_count')::int, 0) >= $${entryIds.length + 2}
         AND COALESCE((metadata->>'promoted_to_knowledge')::boolean, false) = false
         AND is_archived = false`,
      [...entryIds, PROMOTABLE_SCOPES, PROMOTION_THRESHOLD],
    );

    let promoted = 0;
    for (const row of candidates) {
      const knowledgeType = SCOPE_TO_KNOWLEDGE_TYPE[row.scope] ?? 'technical';
      const productLine = (row.metadata as Record<string, unknown>)?.product_line as string | undefined;

      const entryVisibility = row.visibility as string | null;
      const entryTeamId = row.team_id as string | null;
      const entryOrgId = row.org_id as string | null;

      // 继承 entry 的 visibility，回退到基于 productLine 的推断
      const resolvedVisibility = entryVisibility ?? (productLine ? 'product_line' : 'personal');

      const ok = await writeToKnowledge({
        projectId: row.project_id,
        productLine,
        teamId: entryTeamId ?? undefined,
        orgId: entryOrgId ?? undefined,
        title: row.title,
        content: row.content,
        knowledgeType,
        sourceType: 'auto_promote',
        sourceRef: `entry:${row.id}`,
        tags: row.tags ?? [],
        visibility: resolvedVisibility,
      });

      if (ok) {
        await pool.query(
          `UPDATE memory.entries
           SET metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{promoted_to_knowledge}',
             'true'::jsonb
           )
           WHERE id = $1`,
          [row.id],
        );
        promoted++;
        logger.info({ entryId: row.id, scope: row.scope, recallCount: row.recall_count }, '记忆自动晋升到知识库');
      }
    }
    return promoted;
  } catch (err) {
    logger.warn({ err }, '自动晋升检查失败');
    return 0;
  }
}
