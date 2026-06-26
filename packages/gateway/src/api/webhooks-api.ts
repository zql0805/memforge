import { getLogger, getPool } from '@memforgeai/shared';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RBACEnforcer } from '../auth/rbac.js';
import type { UserRole } from '../auth/types.js';

const logger = getLogger('api:webhooks');
const rbac = new RBACEnforcer();

export async function handleWebhooksApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sendJson: (res: ServerResponse, status: number, data: unknown) => void,
  userRole: string,
): Promise<void> {
  const path = url.pathname.replace('/api/webhooks', '');
  const method = req.method ?? 'GET';

  if (!rbac.hasRole(userRole as UserRole, 'admin')) {
    return sendJson(res, 403, { error: 'forbidden', message: '仅 admin 可管理 Webhook 配置' });
  }

  try {
    const pool = getPool();

    if ((path === '' || path === '/') && method === 'GET') {
      const productLine = url.searchParams.get('product_line');
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (productLine) {
        conditions.push(`product_line = $${params.length + 1}`);
        params.push(productLine);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const result = await pool.query(
        `SELECT id, platform, instance_url, project_path, product_line,
                webhook_id, is_active, events, created_by, created_at, updated_at
         FROM memory.webhook_configs ${where}
         ORDER BY created_at DESC`,
        params,
      );
      return sendJson(res, 200, { configs: result.rows, total: result.rowCount });
    }

    if (path === '/stats' && method === 'GET') {
      const [totalRes, activeRes, plRes] = await Promise.all([
        pool.query('SELECT count(*)::int as total FROM memory.webhook_configs'),
        pool.query('SELECT count(*)::int as active FROM memory.webhook_configs WHERE is_active = TRUE'),
        pool.query(
          `SELECT product_line, count(*)::int as cnt
           FROM memory.webhook_configs WHERE is_active = TRUE
           GROUP BY product_line ORDER BY cnt DESC`,
        ),
      ]);
      return sendJson(res, 200, {
        total: totalRes.rows[0]?.total ?? 0,
        active: activeRes.rows[0]?.active ?? 0,
        byProductLine: Object.fromEntries(plRes.rows.map(r => [r.product_line ?? '_none', r.cnt])),
      });
    }

    const idMatch = path.match(/^\/([0-9a-f-]+)$/i);
    if (idMatch && method === 'DELETE') {
      const id = idMatch[1];
      await pool.query(
        'UPDATE memory.webhook_configs SET is_active = FALSE, updated_at = NOW() WHERE id = $1',
        [id],
      );
      return sendJson(res, 200, { status: 'deactivated', id });
    }

    sendJson(res, 404, { error: 'not_found', message: `Webhooks 端点 ${path} 不存在` });
  } catch (err) {
    logger.error({ err }, 'webhooks API 处理失败');
    sendJson(res, 500, { error: '内部错误' });
  }
}
