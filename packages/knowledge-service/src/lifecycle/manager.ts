// Created by dev on 2026/05/21
import { getLogger, getPool } from '@memforgeai/shared';
import type { KnowledgePostgresStorage } from '../storage/postgres.js';

const logger = getLogger('knowledge:lifecycle');

export class LifecycleManager {
  constructor(private readonly storage: KnowledgePostgresStorage) {}

  async publish(id: string, userId: string | null): Promise<boolean> {
    const item = await this.storage.getById(id);
    if (!item) return false;
    if (item.status !== 'draft') {
      logger.warn({ id, status: item.status }, 'Can only publish from draft status');
      return false;
    }
    await this.storage.updateStatus(id, 'published', userId);
    return true;
  }

  async archive(id: string, userId: string | null): Promise<boolean> {
    const item = await this.storage.getById(id);
    if (!item) return false;
    if (item.status !== 'published') {
      logger.warn({ id, status: item.status }, 'Can only archive from published status');
      return false;
    }
    await this.storage.updateStatus(id, 'archived', userId);
    return true;
  }

  /**
   * 按 source_type 清理知识条目（全量重建前调用）。
   * 如果指定 projectId，仅清理该项目的条目。
   * 如果指定 sourceRefPrefix，仅清理 source_ref 以该前缀开头的条目。
   */
  async cleanupBySource(projectId: string | null, sourceType: string, sourceRefPrefix?: string): Promise<number> {
    const pool = getPool();
    const conditions = ['source_type = $1'];
    const bindings: unknown[] = [sourceType];

    if (projectId) {
      bindings.push(projectId);
      conditions.push(`project_id = $${bindings.length}`);
    }

    if (sourceRefPrefix) {
      bindings.push(sourceRefPrefix + '%');
      conditions.push(`source_ref LIKE $${bindings.length}`);
    }

    const result = await pool.query(
      `DELETE FROM memory.knowledge_items WHERE ${conditions.join(' AND ')}`,
      bindings,
    );

    const count = result.rowCount ?? 0;
    logger.info({ projectId, sourceType, sourceRefPrefix, deleted: count }, '已清理知识条目');
    return count;
  }

  /**
   * 根据变更文件列表标记 deep_index 知识条目为 stale。
   * 返回被标记的条目数。
   */
  async markStaleByFiles(repoId: string, changedFiles: string[]): Promise<number> {
    const pool = getPool();

    if (changedFiles.length === 0) {
      // 无具体文件列表时，标记该仓库所有 deep_index 条目
      const result = await pool.query(
        `UPDATE memory.knowledge_items
         SET metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{stale_since}',
           to_jsonb(NOW()::text)
         )
         WHERE source_type = 'deep_index'
           AND (project_id = $1 OR metadata->>'repoId' = $1)
           AND status = 'published'
           AND metadata->>'stale_since' IS NULL`,
        [repoId],
      );
      const count = result.rowCount ?? 0;
      if (count > 0) logger.info({ repoId, staleCount: count }, '已标记仓库全部 deep_index 条目为 stale');
      return count;
    }

    // 有文件列表时，按文件名匹配
    const codeFiles = changedFiles.filter(f =>
      /\.(ts|js|java|php|py|go|rs|kt|vue|tsx|jsx)$/.test(f),
    );
    if (codeFiles.length === 0) return 0;

    const filePatterns = codeFiles.slice(0, 20).map(f => `%${f.split('/').pop()}%`);

    const result = await pool.query(
      `UPDATE memory.knowledge_items
       SET metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{stale_since}',
         to_jsonb(NOW()::text)
       )
       WHERE source_type = 'deep_index'
         AND (project_id = $1 OR metadata->>'repoId' = $1)
         AND status = 'published'
         AND metadata->>'stale_since' IS NULL
         AND (${filePatterns.map((_, i) => `content LIKE $${i + 2}`).join(' OR ')})`,
      [repoId, ...filePatterns],
    );

    const count = result.rowCount ?? 0;
    if (count > 0) {
      logger.info({ repoId, staleCount: count, files: codeFiles.length }, '已按文件标记 stale');
    }
    return count;
  }

  /**
   * 获取 stale 知识条目统计。
   */
  async getStaleStats(productLine?: string): Promise<Record<string, unknown>> {
    const pool = getPool();
    const conditions = [
      "metadata->>'stale_since' IS NOT NULL",
      "status = 'published'",
    ];
    const bindings: unknown[] = [];
    let idx = 1;

    if (productLine) {
      conditions.push(`product_line = $${idx}`);
      bindings.push(productLine);
      idx++;
    }

    const whereClause = conditions.join(' AND ');

    const totalResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM memory.knowledge_items WHERE ${whereClause}`,
      bindings,
    );

    const byRepoResult = await pool.query(
      `SELECT COALESCE(metadata->>'repoId', project_id) AS repo,
              COUNT(*)::int AS count,
              MIN(metadata->>'stale_since') AS oldest_stale
       FROM memory.knowledge_items
       WHERE ${whereClause}
       GROUP BY repo
       ORDER BY count DESC`,
      bindings,
    );

    const byLevelResult = await pool.query(
      `SELECT COALESCE(metadata->>'level', 'unknown') AS level, COUNT(*)::int AS count
       FROM memory.knowledge_items
       WHERE ${whereClause}
       GROUP BY level`,
      bindings,
    );

    return {
      totalStale: totalResult.rows[0]?.count ?? 0,
      byRepo: byRepoResult.rows,
      byLevel: byLevelResult.rows,
    };
  }
}
