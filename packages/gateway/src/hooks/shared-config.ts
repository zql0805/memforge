/**
 * 跨 handler 共享的审查配置。
 * commit-handler / mr-handler / gitlab-webhook-handler 共同使用。
 */

export function getReviewBranches(): Set<string> {
  return new Set(
    (process.env.MEMFORGE_REVIEW_BRANCHES || 'master,main')
      .split(',')
      .map(b => b.trim())
      .filter(Boolean),
  );
}
