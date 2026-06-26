import { getLogger, getPool } from '@memforgeai/shared';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RBACEnforcer } from '../auth/rbac.js';
import type { UserRole } from '../auth/types.js';

const logger = getLogger('api:reviews');
const rbac = new RBACEnforcer();

export async function handleReviewsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sendJson: (res: ServerResponse, status: number, data: unknown) => void,
  userRole: string,
): Promise<void> {
  const path = url.pathname.replace('/api/reviews', '');
  const method = req.method ?? 'GET';

  if (!rbac.hasRole(userRole as UserRole, 'lead')) {
    return sendJson(res, 403, { error: 'forbidden', message: '仅 admin/lead 可查看 Code Review 记录' });
  }

  try {
    const pool = getPool();

    if ((path === '' || path === '/') && method === 'GET') {
      const repoId = url.searchParams.get('repo_id');
      const productLine = url.searchParams.get('product_line');
      const reviewType = url.searchParams.get('review_type');
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

      const conditions: string[] = [];
      const filterParams: unknown[] = [];
      if (repoId) { conditions.push(`repo_id = $${filterParams.length + 1}`); filterParams.push(repoId); }
      if (productLine) { conditions.push(`product_line = $${filterParams.length + 1}`); filterParams.push(productLine); }
      if (reviewType) { conditions.push(`review_type = $${filterParams.length + 1}`); filterParams.push(reviewType); }
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const result = await pool.query(
        `SELECT id, repo_id, commit_hash, branch, author, classification, summary,
                (findings::jsonb) as findings, llm_skipped, notified, reviewed_at, created_at,
                review_type, mr_iid, mr_url
         FROM memory.code_reviews ${whereClause}
         ORDER BY reviewed_at DESC
         LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
        [...filterParams, limit, offset],
      );

      const countResult = await pool.query(
        `SELECT count(*)::int as total FROM memory.code_reviews ${whereClause}`,
        filterParams,
      );

      return sendJson(res, 200, {
        reviews: result.rows,
        total: countResult.rows[0]?.total ?? 0,
        limit,
        offset,
      });
    }

    if (path === '/stats' && method === 'GET') {
      const repoId = url.searchParams.get('repo_id');
      const productLine = url.searchParams.get('product_line');
      const statsConditions: string[] = [];
      const queryParams: unknown[] = [];
      if (repoId) { statsConditions.push(`repo_id = $${queryParams.length + 1}`); queryParams.push(repoId); }
      if (productLine) { statsConditions.push(`product_line = $${queryParams.length + 1}`); queryParams.push(productLine); }
      const whereClause = statsConditions.length > 0 ? `WHERE ${statsConditions.join(' AND ')}` : '';

      const [totalRes, classRes, severityRes, recentRes, typeRes] = await Promise.all([
        pool.query(`SELECT count(*)::int as total FROM memory.code_reviews ${whereClause}`, queryParams),
        pool.query(
          `SELECT classification, count(*)::int as cnt FROM memory.code_reviews ${whereClause} GROUP BY classification ORDER BY cnt DESC`,
          queryParams,
        ),
        pool.query(
          `SELECT
             coalesce(sum(jsonb_array_length(findings)), 0)::int as total_findings,
             coalesce(sum((
               SELECT count(*)::int FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(findings) = 'array' AND jsonb_array_length(findings) > 0
                      THEN findings ELSE '[]'::jsonb END
               ) f WHERE f->>'severity' = 'P0'
             )), 0)::int as p0,
             coalesce(sum((
               SELECT count(*)::int FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(findings) = 'array' AND jsonb_array_length(findings) > 0
                      THEN findings ELSE '[]'::jsonb END
               ) f WHERE f->>'severity' = 'P1'
             )), 0)::int as p1,
             coalesce(sum((
               SELECT count(*)::int FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(findings) = 'array' AND jsonb_array_length(findings) > 0
                      THEN findings ELSE '[]'::jsonb END
               ) f WHERE f->>'severity' = 'P2'
             )), 0)::int as p2
           FROM memory.code_reviews ${whereClause}`,
          queryParams,
        ),
        pool.query(
          `SELECT repo_id, commit_hash, classification, summary, reviewed_at, review_type, mr_iid
           FROM memory.code_reviews ${whereClause} ORDER BY reviewed_at DESC LIMIT 10`,
          queryParams,
        ),
        pool.query(
          `SELECT review_type, count(*)::int as cnt
           FROM memory.code_reviews ${whereClause} GROUP BY review_type`,
          queryParams,
        ),
      ]);

      return sendJson(res, 200, {
        total: totalRes.rows[0]?.total ?? 0,
        byClassification: Object.fromEntries(classRes.rows.map(r => [r.classification, r.cnt])),
        findings: severityRes.rows[0] ?? { total_findings: 0, p0: 0, p1: 0, p2: 0 },
        recent: recentRes.rows,
        byReviewType: Object.fromEntries(typeRes.rows.map(r => [r.review_type, r.cnt])),
      });
    }

    const commitMatch = path.match(/^\/([a-f0-9]+)$/i);
    if (commitMatch && method === 'GET') {
      const commitHash = commitMatch[1].toLowerCase();
      const result = await pool.query(
        `SELECT * FROM memory.code_reviews WHERE commit_hash LIKE $1 ORDER BY reviewed_at DESC LIMIT 1`,
        [`${commitHash}%`],
      );
      if (result.rows.length === 0) {
        return sendJson(res, 404, { error: 'not_found', message: `未找到 commit ${commitHash} 的审查记录` });
      }
      return sendJson(res, 200, result.rows[0]);
    }

    sendJson(res, 404, { error: 'not_found', message: `Reviews 端点 ${path} 不存在` });
  } catch (err) {
    logger.error({ err }, 'reviews API 处理失败');
    sendJson(res, 500, { error: '内部错误' });
  }
}
