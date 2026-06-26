import { getPool, getLogger } from '@memforgeai/shared';

const logger = getLogger('retention:cleanup');

interface CleanupResult {
  notificationLogDeleted: number;
  codeReviewsDeleted: number;
}

export async function runRetentionCleanup(): Promise<CleanupResult> {
  const pool = getPool();
  const result: CleanupResult = { notificationLogDeleted: 0, codeReviewsDeleted: 0 };

  try {
    const notifResult = await pool.query(
      `DELETE FROM memory.notification_log WHERE created_at < NOW() - INTERVAL '30 days' RETURNING id`,
    );
    result.notificationLogDeleted = notifResult.rowCount ?? 0;

    if (result.notificationLogDeleted > 0) {
      logger.info({ deleted: result.notificationLogDeleted }, 'notification_log 清理完成');
    }
  } catch (err) {
    logger.warn({ err }, 'notification_log 清理失败');
  }

  try {
    const reviewResult = await pool.query(
      `DELETE FROM memory.code_reviews
       WHERE reviewed_at < NOW() - INTERVAL '90 days'
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(findings) f
           WHERE f->>'severity' = 'P0'
         )
       RETURNING commit_hash`,
    );
    result.codeReviewsDeleted = reviewResult.rowCount ?? 0;

    if (result.codeReviewsDeleted > 0) {
      logger.info({ deleted: result.codeReviewsDeleted }, 'code_reviews 清理完成（P0 记录已保留）');
    }
  } catch (err) {
    logger.warn({ err }, 'code_reviews 清理失败');
  }

  return result;
}

const INTERVAL_MS = 24 * 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startRetentionScheduler(): void {
  if (timer) return;
  logger.info('数据保留策略定时任务已启动（每 24h 执行一次）');
  runRetentionCleanup().catch(err => logger.error({ err }, '首次清理执行失败'));
  timer = setInterval(() => {
    runRetentionCleanup().catch(err => logger.error({ err }, '定时清理执行失败'));
  }, INTERVAL_MS);
}

export function stopRetentionScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('数据保留策略定时任务已停止');
  }
}
