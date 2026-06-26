import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import { enqueueReview } from '../review/pipeline.js';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:review-commit');

export function registerReviewCommit(server: McpServer, _ctx: ToolContext): void {
  server.tool(
    'review_commit',
    '对单个 Git commit 执行自动 Code Review 管道（上下文收集 → 静态扫描 → LLM 深度审查 → 结果处理 + 钉钉通知）',
    {
      commit_hash: z.string().describe('commit hash'),
      message: z.string().describe('commit message'),
      branch: z.string().optional().describe('分支名'),
      author: z.string().optional().describe('提交者'),
      repo_id: z.string().describe('仓库标识'),
      repo_path: z.string().optional().describe('仓库本地路径'),
      classification: z.string().describe('提交分类: feature/bugfix/refactor/security/performance/merge_request'),
      diff: z.string().optional().describe('diff 内容'),
      files: z.string().optional().describe('变更文件列表(逗号分隔)'),
      review_type: z.enum(['commit', 'merge_request']).optional().describe('审查类型'),
      mr_iid: z.number().optional().describe('MR 编号（仅 MR 审查时传入）'),
      mr_url: z.string().optional().describe('MR URL（仅 MR 审查时传入）'),
      gitlab_project_id: z.number().optional().describe('GitLab 项目 ID（仅 MR 审查时传入）'),
    },
    async (params) => {
      try {
        const files = params.files ? params.files.split(',').map(f => f.trim()).filter(Boolean) : [];

        const result = await enqueueReview({
          commitHash: params.commit_hash,
          message: params.message,
          branch: params.branch ?? 'unknown',
          author: params.author ?? 'unknown',
          repoId: params.repo_id,
          repoPath: params.repo_path ?? '',
          classification: params.classification,
          diff: params.diff ?? '',
          files,
          timestamp: Date.now(),
          reviewType: params.review_type,
          mrIid: params.mr_iid,
          mrUrl: params.mr_url,
          gitlabProjectId: params.gitlab_project_id,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              ...result,
            }),
          }],
        };
      } catch (err) {
        logger.error({ err }, 'review_commit 执行失败');
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
