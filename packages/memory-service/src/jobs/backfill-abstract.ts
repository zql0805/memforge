// Created by dev on 2026/06/02

import { initPool, loadDbConfig, getPool, getLogger } from '@memforgeai/shared';
import { generateAbstract } from '../storage/postgres.js';

const logger = getLogger('job:backfill-abstract');
const BATCH_SIZE = 100;

async function backfillAbstracts(): Promise<number> {
  const pool = getPool();
  let totalUpdated = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await pool.query(
      `SELECT id, title, content FROM memory.entries
       WHERE abstract IS NULL AND content IS NOT NULL AND content != ''
       ORDER BY created_at DESC
       LIMIT $1`,
      [BATCH_SIZE],
    );

    if (batch.rows.length === 0) break;

    for (const row of batch.rows) {
      const abstract = generateAbstract(row.title ?? '', row.content);
      await pool.query(
        'UPDATE memory.entries SET abstract = $1 WHERE id = $2',
        [abstract, row.id],
      );
      totalUpdated++;
    }

    logger.info({ batch: batch.rows.length, totalUpdated }, '回填批次完成');

    if (batch.rows.length < BATCH_SIZE) break;
  }

  return totalUpdated;
}

async function main(): Promise<void> {
  initPool(loadDbConfig());
  logger.info('开始回填 abstract 摘要...');
  const count = await backfillAbstracts();
  logger.info({ totalUpdated: count }, '回填完成');
  process.exit(0);
}

main().catch(err => {
  logger.error({ err }, '回填失败');
  process.exit(1);
});
