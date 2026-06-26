// Created by dev on 2026/05/21
import { getLogger, getPool } from '@memforgeai/shared';
import type { ApiEmbeddingService } from '@memforgeai/shared';

const logger = getLogger('knowledge:embed-queue');

export class EmbedQueue {
  private processing = false;

  constructor(private readonly embedding: ApiEmbeddingService | null) {}

  async processQueue(): Promise<number> {
    if (!this.embedding) return 0;
    if (this.processing) return 0;
    this.processing = true;

    try {
      const pool = getPool();
      const pending = await pool.query(
        `SELECT id, title, question, content, summary, media_text
         FROM memory.knowledge_items
         WHERE embedding IS NULL
         ORDER BY created_at ASC
         LIMIT 50`,
      );

      if (pending.rows.length === 0) return 0;

      const texts = pending.rows.map(r =>
        [r.title, r.summary, r.question, r.content, r.media_text].filter(Boolean).join(' '),
      );

      let embeddings: number[][];
      try {
        embeddings = await this.embedding.embedBatch(texts);
      } catch (batchErr) {
        logger.warn({ err: batchErr }, '批量 embedding 失败，回退到逐条处理');
        embeddings = [];
        for (let i = 0; i < pending.rows.length; i++) {
          try {
            const vec = await this.embedding.embed(texts[i]);
            embeddings[i] = vec;
          } catch (itemErr) {
            logger.error({ err: itemErr, id: pending.rows[i].id }, 'embedding 失败，跳过该条目');
          }
        }
      }

      let processed = 0;
      for (let i = 0; i < pending.rows.length; i++) {
        if (!embeddings[i]) continue;
        try {
          const vec = '[' + embeddings[i].join(',') + ']';
          await pool.query(
            'UPDATE memory.knowledge_items SET embedding = $1 WHERE id = $2',
            [vec, pending.rows[i].id],
          );
          processed++;
        } catch (err) {
          logger.warn({ err: String(err), knowledgeId: pending.rows[i].id, title: pending.rows[i].title }, 'Embedding 更新失败');
        }
      }

      logger.info({ count: processed, total: pending.rows.length }, 'Processed embedding queue');
      return processed;
    } finally {
      this.processing = false;
    }
  }

  startInterval(ms = 10_000): NodeJS.Timeout {
    return setInterval(() => {
      this.processQueue().catch(err => logger.warn({ err: String(err) }, 'Embed queue 批量处理失败'));
    }, ms);
  }
}
