import { createHash, randomBytes } from 'node:crypto';
import { getLogger, getPool } from '@memforgeai/shared';
import type { ServerResponse } from 'node:http';

const logger = getLogger('hooks:token');

const HOOK_TOKEN_PREFIX = 'mfh_';

export interface TokenInfo {
  id: string;
  description: string;
  token_prefix: string;
  is_active: boolean;
  product_line: string | null;
  last_used: string | null;
  created_at: string;
}

function hashHookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function handleTokenApi(
  method: string,
  body: Record<string, unknown> | null,
  sendJson: (res: ServerResponse, status: number, data: unknown) => void,
  res: ServerResponse,
): Promise<void> {
  const pool = getPool();

  if (method === 'GET') {
    const { rows } = await pool.query<TokenInfo>(
      `SELECT id, description,
              COALESCE(token_prefix, substring(token, 1, 10) || '...') as token_prefix,
              is_active, product_line, last_used, created_at
       FROM memory.hook_tokens
       ORDER BY created_at DESC`,
    );
    return sendJson(res, 200, { tokens: rows });
  }

  if (method === 'POST') {
    const description = (body?.description as string) || (body?.label as string) || 'default';
    const productLine = (body?.product_line as string) || null;
    const createdBy = (body?.created_by as string) || null;
    const token = HOOK_TOKEN_PREFIX + randomBytes(24).toString('hex');
    const tokenPrefix = token.slice(0, 10);
    const tokenHash = hashHookToken(token);

    await pool.query(
      `INSERT INTO memory.hook_tokens (token, token_prefix, description, is_active, product_line, created_by)
       VALUES ($1, $2, $3, TRUE, $4, $5)`,
      [tokenHash, tokenPrefix, description, productLine, createdBy],
    );

    logger.info({ description, productLine, tokenPrefix }, 'Hook Token 已创建');
    return sendJson(res, 201, { token, description, product_line: productLine });
  }

  if (method === 'DELETE') {
    const tokenId = body?.id as string;
    if (!tokenId) {
      return sendJson(res, 400, { error: 'id 参数必填' });
    }

    const result = await pool.query(
      `UPDATE memory.hook_tokens SET is_active = FALSE WHERE id = $1 RETURNING id`,
      [tokenId],
    );
    if (result.rows.length === 0) {
      return sendJson(res, 404, { error: 'Token 不存在' });
    }

    logger.info({ tokenId }, 'Hook Token 已停用');
    return sendJson(res, 200, { status: 'deactivated', id: tokenId });
  }

  sendJson(res, 405, { error: `不支持的方法: ${method}` });
}

export { hashHookToken, HOOK_TOKEN_PREFIX };
