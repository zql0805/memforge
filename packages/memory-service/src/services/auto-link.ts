// Created by dev on 2026/04/05
// Copyright © 2026
// 智能关联引擎 — 自动发现工作上下文与记忆/规则之间的关系

import { getLogger, getPool } from '@memforgeai/shared';
import type { ApiEmbeddingService } from '@memforgeai/shared';
import type { PostgresStorage } from '../storage/postgres.js';

const logger = getLogger('auto-link');

interface LinkResult {
  relationsCreated: number;
  details: Array<{ targetId: string; targetTitle: string; relation: string; confidence: number }>;
}

/**
 * 为工作上下文自动建立与相关记忆的知识关联。
 *
 * 执行流程：
 * 1. 获取工作上下文的 embedding
 * 2. 语义搜索相关记忆（排除自身和其他工作上下文）
 * 3. 根据目标记忆的 scope 推断关系类型
 * 4. 写入 knowledge_relations 表（跳过已存在的关系）
 */
export async function autoLinkWorkContext(
  contextId: string,
  storage: PostgresStorage,
  embedding: ApiEmbeddingService,
  projectIds?: string[],
): Promise<LinkResult> {
  const result: LinkResult = { relationsCreated: 0, details: [] };

  try {
    const context = await storage.getById(contextId);
    if (!context) {
      logger.warn({ contextId }, '自动关联：工作上下文不存在');
      return result;
    }

    const contextEmb = context.embedding
      ?? await embedding.embedPassage(context.content);

    const related = await storage.searchByEmbedding(
      contextEmb, projectIds, null, 15, 0.55,
    );

    const pool = getPool();

    for (const item of related) {
      if (item.id === contextId) continue;

      const entry = await storage.getById(item.id);
      if (!entry) continue;

      // 跳过其他工作上下文
      const meta = entry.metadata as Record<string, unknown> | null;
      if (meta?.type === 'work_context') continue;

      const contextMeta = context.metadata as Record<string, unknown> | null;
      const relation = inferRelationType(entry.scope, context.scope, meta, contextMeta);
      const confidence = Math.round(item.similarity * 100) / 100;

      // 幂等：跳过已存在的关系
      const { rows: existing } = await pool.query(
        `SELECT id FROM memory.knowledge_relations
         WHERE source_id = $1 AND target_id = $2 AND relation_type = $3
         LIMIT 1`,
        [contextId, item.id, relation],
      );

      if (existing.length > 0) continue;

      await pool.query(
        `INSERT INTO memory.knowledge_relations
         (source_id, source_type, target_id, target_type, relation_type, confidence, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [contextId, 'entry', item.id, 'entry', relation, confidence, 'auto-link'],
      );

      result.relationsCreated++;
      result.details.push({
        targetId: item.id,
        targetTitle: entry.title,
        relation,
        confidence,
      });
    }

    logger.info({
      contextId,
      created: result.relationsCreated,
      searched: related.length,
    }, '自动关联完成');
  } catch (err) {
    logger.error({ contextId, error: err }, '自动关联执行失败');
  }

  return result;
}

/**
 * 为新存储的普通记忆自动建立与相似记忆/规则的知识关联。
 * 比 autoLinkWorkContext 更轻量：只查相似度 ≥ 0.7 的记忆，最多建 5 条关系。
 */
export async function autoLinkNewMemory(
  entryId: string,
  storage: PostgresStorage,
  embedding: ApiEmbeddingService,
  projectIds?: string[],
): Promise<number> {
  try {
    const entry = await storage.getById(entryId);
    if (!entry) return 0;

    const skipScopes = new Set(['task_progress']);
    if (skipScopes.has(entry.scope)) return 0;

    const entryEmb = entry.embedding
      ?? await embedding.embedPassage(entry.content);

    const related = await storage.searchByEmbedding(
      entryEmb, projectIds, null, 8, 0.7,
    );

    const pool = getPool();
    let created = 0;

    for (const item of related) {
      if (item.id === entryId) continue;
      if (created >= 5) break;

      const target = await storage.getById(item.id);
      if (!target) continue;

      const targetMeta = target.metadata as Record<string, unknown> | null;
      if (targetMeta?.type === 'work_context') continue;

      const relation = inferRelationType(target.scope, entry.scope, targetMeta, null);
      const confidence = Math.round(item.similarity * 100) / 100;

      const { rows: existing } = await pool.query(
        `SELECT id FROM memory.knowledge_relations
         WHERE source_id = $1 AND target_id = $2
         LIMIT 1`,
        [entryId, item.id],
      );
      if (existing.length > 0) continue;

      await pool.query(
        `INSERT INTO memory.knowledge_relations
         (source_id, source_type, target_id, target_type, relation_type, confidence, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [entryId, 'entry', item.id, 'entry', relation, confidence, 'auto-link'],
      );
      created++;
    }

    if (created > 0) {
      logger.info({ entryId, created }, '新记忆自动关联完成');
    }
    return created;
  } catch (err) {
    logger.error({ entryId, error: err }, '新记忆自动关联失败');
    return 0;
  }
}

/**
 * 为经验教训记忆建立 `produced` 关系到父工作上下文。
 */
export async function linkLessonToContext(
  contextId: string,
  lessonId: string,
): Promise<void> {
  try {
    const pool = getPool();
    const { rows: existing } = await pool.query(
      `SELECT id FROM memory.knowledge_relations
       WHERE source_id = $1 AND target_id = $2 AND relation_type = 'produced'
       LIMIT 1`,
      [contextId, lessonId],
    );
    if (existing.length > 0) return;

    await pool.query(
      `INSERT INTO memory.knowledge_relations
       (source_id, source_type, target_id, target_type, relation_type, confidence, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [contextId, 'entry', lessonId, 'entry', 'produced', 1.0, 'auto-link'],
    );

    logger.debug({ contextId, lessonId }, '经验 ← 工作上下文关联已建立');
  } catch (err) {
    logger.error({ contextId, lessonId, error: err }, 'linkLessonToContext 失败');
  }
}

/**
 * 根据目标记忆的 scope、工作上下文类型和元数据推断关系类型。
 *
 * 关系方向：source（工作上下文）→ target（相关记忆）
 * - guided_by: 规范/约定指导了此次工作
 * - caused_by: Bug 模式是此次修复的原因
 * - fixed_by: 调试策略/复盘帮助解决了此次 Bug
 * - references: 参考了架构/经验/知识
 * - related_to: 泛关联
 * - produced: 工作上下文产生了经验教训（由 linkLessonToContext 写入）
 */
export function inferRelationType(
  targetScope: string,
  _contextScope: string,
  _targetMeta: Record<string, unknown> | null,
  contextMeta: Record<string, unknown> | null,
): string {
  const contextWorkType = contextMeta?.type === 'work_context'
    ? contextMeta?.work_type
    : (contextMeta?.work_type ?? contextMeta?.type);
  const isBugFix = contextWorkType === 'bug_fix';

  switch (targetScope) {
    case 'coding_standard':
    case 'convention':
      return 'guided_by';

    case 'bug_pattern':
      return isBugFix ? 'caused_by' : 'related_to';

    case 'debugging_strategy':
    case 'failure_postmortem':
      return isBugFix ? 'fixed_by' : 'references';

    case 'lesson_learned':
    case 'performance_insight':
      return 'references';

    case 'architecture':
      return 'references';

    case 'domain_knowledge':
      return 'references';

    case 'task_progress':
      return 'related_to';

    default:
      return 'related_to';
  }
}
