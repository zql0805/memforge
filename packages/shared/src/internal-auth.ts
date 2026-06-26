// Created by dev on 2026/05/20
// Gateway ↔ 后端服务内部通信 HMAC 签名验证

import { createHmac, timingSafeEqual } from 'node:crypto';

const INTERNAL_SECRET = process.env.MEMFORGE_INTERNAL_SECRET || '';
const MAX_AGE_MS = 30_000;

export interface InternalRequestContext {
  method?: string;
  path?: string;
  bodyHash?: string;
}

function isDevOrTest(): boolean {
  const env = process.env.NODE_ENV;
  return env === 'development' || env === 'test';
}

function buildSignaturePayload(ts: string, context?: InternalRequestContext): string {
  if (!context?.method && !context?.path && !context?.bodyHash) {
    return ts;
  }
  const method = context?.method ?? '';
  const path = context?.path ?? '';
  const bodyHash = context?.bodyHash ?? '';
  return `${ts}:${method}:${path}:${bodyHash}`;
}

/**
 * 生成 Gateway ↔ 后端服务的 HMAC 签名。
 * @param secret - 可选覆盖密钥，默认读 MEMFORGE_INTERNAL_SECRET
 * @param context - 可选请求上下文（method/path/bodyHash）增强签名
 */
export function signInternalRequest(secret?: string, context?: InternalRequestContext): { token: string; timestamp: string } {
  const s = secret || INTERNAL_SECRET;
  const ts = Date.now().toString();
  const payload = buildSignaturePayload(ts, context);
  const token = createHmac('sha256', s).update(payload).digest('hex');
  return { token, timestamp: ts };
}

/** 验证 HMAC 签名与时间戳（30s 窗口）；未配置密钥时 dev/test 放行 */
export function verifyInternalRequest(token: string, timestamp: string, secret?: string, context?: InternalRequestContext): boolean {
  const s = secret || INTERNAL_SECRET;
  if (!s) return isDevOrTest();
  const age = Date.now() - parseInt(timestamp, 10);
  if (isNaN(age) || age < 0 || age > MAX_AGE_MS) return false;
  const payload = buildSignaturePayload(timestamp, context);
  const expected = createHmac('sha256', s).update(payload).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/** 生成带 HMAC 签名的内部请求 HTTP 头 */
export function getInternalHeaders(secret?: string, context?: InternalRequestContext): Record<string, string> {
  const { token, timestamp } = signInternalRequest(secret, context);
  return {
    'x-memforge-internal-token': token,
    'x-memforge-internal-ts': timestamp,
  };
}

/** 从 HTTP 头验证内部请求签名 */
export function verifyInternalHeaders(
  headers: Record<string, string | string[] | undefined>,
  secret?: string,
  context?: InternalRequestContext,
): boolean {
  const token = (typeof headers['x-memforge-internal-token'] === 'string') ? headers['x-memforge-internal-token'] : '';
  const ts = (typeof headers['x-memforge-internal-ts'] === 'string') ? headers['x-memforge-internal-ts'] : '';
  if (!token || !ts) return false;
  return verifyInternalRequest(token, ts, secret, context);
}
