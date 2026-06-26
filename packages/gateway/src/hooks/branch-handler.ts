import { getLogger, getPool } from '@memforgeai/shared';
import type { ServerResponse } from 'node:http';

const logger = getLogger('hooks:branch');

export interface BranchPayload {
  repo: string;
  repo_id?: string;
  from_branch: string;
  to_branch: string;
  timestamp: number;
  product_line?: string;
  user?: string;
}

export interface BranchHookContext {
  productLine?: string | null;
}

const NOTABLE_BRANCHES = /^(master|main|release|hotfix|staging|production)/;

export async function handleBranchHook(
  payload: BranchPayload,
  sendJson: (res: ServerResponse, status: number, data: unknown) => void,
  res: ServerResponse,
  hookCtx?: BranchHookContext,
): Promise<void> {
  try {
    if (!payload.repo || !payload.to_branch) {
      sendJson(res, 400, { error: '缺少必填字段: repo, to_branch' });
      return;
    }

    const repoId = payload.repo_id || payload.repo;
    const fromBranch = payload.from_branch || 'unknown';
    const toBranch = payload.to_branch;

    logger.info({ repo: repoId, from: fromBranch, to: toBranch }, 'Git Hook: branch 切换');

    recordBranchSwitch(repoId, fromBranch, toBranch, payload, hookCtx).catch(err => {
      logger.debug({ err: (err as Error).message }, '分支切换记录写入失败');
    });

    sendJson(res, 200, {
      status: 'accepted',
      repo: repoId,
      from_branch: fromBranch,
      to_branch: toBranch,
      notable: NOTABLE_BRANCHES.test(toBranch) || NOTABLE_BRANCHES.test(fromBranch),
    });
  } catch (err) {
    logger.error({ err }, 'branch hook 处理失败');
    sendJson(res, 500, { error: '内部错误' });
  }
}

async function recordBranchSwitch(
  repoId: string,
  fromBranch: string,
  toBranch: string,
  payload: BranchPayload,
  hookCtx?: BranchHookContext,
): Promise<void> {
  const pool = getPool();
  // Hook Token 绑定的 product_line 优先，防止客户端伪造
  const productLine = hookCtx?.productLine ?? payload.product_line ?? repoId;

  await pool.query(
    `INSERT INTO memory.entries
     (project_id, title, content, scope, source, tags, metadata, is_archived, created_by)
     VALUES ($1, $2, $3, 'convention', 'git_hook', $4, $5, false, 'system')`,
    [
      productLine,
      `[分支切换] ${repoId}: ${fromBranch} → ${toBranch}`,
      [
        `仓库 \`${repoId}\` 切换分支`,
        `- **From**: \`${fromBranch}\``,
        `- **To**: \`${toBranch}\``,
        payload.user ? `- **操作者**: ${payload.user}` : '',
        `- **时间**: ${new Date(payload.timestamp || Date.now()).toISOString()}`,
      ].filter(Boolean).join('\n'),
      JSON.stringify(['branch-switch', 'git-hook', `repo:${repoId}`, `branch:${toBranch}`]),
      JSON.stringify({
        repoId,
        fromBranch,
        toBranch,
        user: payload.user,
        timestamp: payload.timestamp || Date.now(),
        isNotable: NOTABLE_BRANCHES.test(toBranch) || NOTABLE_BRANCHES.test(fromBranch),
      }),
    ],
  );

  if (NOTABLE_BRANCHES.test(toBranch) || NOTABLE_BRANCHES.test(fromBranch)) {
    logger.info({ repo: repoId, from: fromBranch, to: toBranch }, '关键分支切换已记录');
  }
}
