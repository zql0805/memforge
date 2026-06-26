// Created by dev on 2026/04/05
// Copyright © 2026
// MCP Gateway HTTP 服务器

import { randomUUID, createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getLogger, initPool, getPool, loadDbConfig,
  registry, mcpRequestTotal, mcpRequestDuration, mcpRequestErrors,
  authAttempts, rateLimitHits, activeConnections,
  loadRedisConfig, initRedis, CacheManager,
  getIdeConfig, detectIdeFromUA, isValidIdeType, createRulesAdapter, convertRule,
} from '@memforgeai/shared';
import type { IdeType } from '@memforgeai/shared';
import type { GatewayConfig } from './config.js';
import { OAuthProvider, OAuthError } from './auth/oauth.js';
import { RBACEnforcer } from './auth/rbac.js';
import { ProductLineACL } from './auth/product-line-acl.js';
import { RateLimiter } from './middleware/rate-limiter.js';
import { LoginRateLimiter } from './middleware/login-rate-limiter.js';
import { LoginLock } from './middleware/login-lock.js';
import { AuditLogger } from './middleware/audit-logger.js';
import { McpRouter, RouterError } from './router.js';
import { UserStore } from './storage/user-store.js';
import type { TokenPayload } from './auth/types.js';
import { validatePassword, PASSWORD_POLICY_HINT } from './auth/password-policy.js';
import { McpClientManager } from './ws/mcp-client-manager.js';
import { ApiKeyStore, parseApiKeyScope } from './storage/api-key-store.js';
import { DeviceStore } from './storage/device-store.js';
import { createGatewayMcpServer, type GatewayMcpContext } from './mcp/mcp-server.js';

const logger = getLogger('gateway');

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB

class BodyTooLargeError extends Error {
  readonly statusCode = 413;
  constructor() {
    super('请求体超过 1MB 大小限制');
    this.name = 'BodyTooLargeError';
  }
}

const sseTickets = new Map<string, { userId: string; expiresAt: number }>();

export interface GatewayContext {
  config: GatewayConfig;
  oauth: OAuthProvider;
  rbac: RBACEnforcer;
  plAcl: ProductLineACL;
  rateLimiter: RateLimiter;
  loginRateLimiter: LoginRateLimiter;
  loginLock: LoginLock;
  auditLogger: AuditLogger;
  router: McpRouter;
  userStore: UserStore;
  deviceStore: DeviceStore;
  cache: CacheManager;
  mcpClients: McpClientManager;
  apiKeyStore: ApiKeyStore;
}

export async function createGateway(config: GatewayConfig): Promise<{
  server: ReturnType<typeof createServer>;
  ctx: GatewayContext;
}> {
  // 初始化数据库连接
  initPool(loadDbConfig());

  // 初始化 Redis 缓存（可选，未配置 REDIS_URL 时仅用 L1 进程内缓存）
  const redisConfig = loadRedisConfig();
  if (redisConfig) {
    const redis = initRedis(redisConfig);
    await redis.connect().catch((err: Error) => {
      logger.warn({ err: err.message }, 'Redis 连接失败，降级为进程内缓存');
    });
  }

  const oauth = new OAuthProvider(config);
  await oauth.loadClientsFromDb();

  const apiKeyStore = new ApiKeyStore();
  const userStore = new UserStore();
  const mcpClients = new McpClientManager(async (token: string) => {
    // JWT 认证
    try {
      const payload = await oauth.verifyAccessToken(token);
      return { userId: payload.sub, role: payload.role };
    } catch (err) {
      logger.debug({ err }, 'JWT 认证失败，尝试 API Key');
    }

    // API Key 认证
    if (token.startsWith('mfk_')) {
      try {
        const verified = await apiKeyStore.verify(token);
        if (verified) {
          const user = await userStore.findById(verified.userId);
          if (user) return { userId: user.id, role: user.role };
        }
      } catch (err) {
        logger.debug({ err }, 'API Key 认证失败');
      }
    }

    return null;
  });

  const ctx: GatewayContext = {
    config,
    oauth,
    rbac: new RBACEnforcer(),
    plAcl: new ProductLineACL(),
    rateLimiter: new RateLimiter(config.rateLimitGlobalRpm, config.rateLimitPerUserRpm, config.rateLimitPerToolRpm),
    loginRateLimiter: new LoginRateLimiter({
      perIpRpm: config.loginRateLimitPerIpRpm,
      perAccountRpm: config.loginRateLimitPerAccountRpm,
      globalRpm: config.loginRateLimitGlobalRpm,
    }),
    loginLock: new LoginLock({
      maxAttempts: config.loginLockMaxAttempts,
      lockDurationMs: config.loginLockDurationMs,
    }),
    auditLogger: new AuditLogger(),
    router: new McpRouter(config),
    userStore,
    deviceStore: new DeviceStore(),
    cache: new CacheManager({ l1MaxSize: 2000, l1TtlMs: 5 * 60 * 1000 }),
    mcpClients,
    apiKeyStore,
  };

  const server = createServer((req, res) => {
    handleRequest(req, res, ctx).catch(err => {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: 'payload_too_large', message: err.message });
        return;
      }
      logger.error({ error: err, url: req.url }, '未处理的请求异常');
      sendJson(res, 500, { error: 'internal_server_error', message: '服务器内部错误' });
    });
  });

  // WebSocket upgrade: MCP 客户端长连接
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/ws/mcp-client') {
      mcpClients.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  // 定期清理过期的 SSE ticket，防止 Map 无限增长
  const sseCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ticket, entry] of sseTickets) {
      if (entry.expiresAt <= now) sseTickets.delete(ticket);
    }
  }, 300_000);
  sseCleanupTimer.unref();

  // 数据保留定时清理（每 6 小时执行一次）
  const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const RETENTION_INITIAL_DELAY_MS = 30_000;
  type DeleteQueryResult = { rowCount: number | null };
  const emptyDeleteResult: DeleteQueryResult = { rowCount: 0 };

  async function runDataRetention(): Promise<void> {
    try {
      const pool = getPool();
      // code_reviews: 90 天
      const cr = await pool.query(
        `DELETE FROM memory.code_reviews WHERE created_at < NOW() - INTERVAL '90 days'`,
      );
      // notification_log: 30 天
      const nl: DeleteQueryResult = await pool.query(
        `DELETE FROM memory.notification_log WHERE created_at < NOW() - INTERVAL '30 days'`,
      ).catch(() => emptyDeleteResult);
      // 过期 hook_tokens: 非活跃且 180 天未使用
      const ht: DeleteQueryResult = await pool.query(
        `DELETE FROM memory.hook_tokens WHERE is_active = FALSE AND last_used < NOW() - INTERVAL '180 days'`,
      ).catch(() => emptyDeleteResult);
      const total = (cr.rowCount ?? 0) + (nl.rowCount ?? 0) + (ht.rowCount ?? 0);
      if (total > 0) {
        logger.info(
          { code_reviews: cr.rowCount, notification_log: nl.rowCount, hook_tokens: ht.rowCount },
          '数据保留清理完成',
        );
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '数据保留清理失败');
    }
  }
  // 启动后延迟首次执行，之后按间隔定时运行
  setTimeout(() => {
    runDataRetention();
    setInterval(runDataRetention, RETENTION_INTERVAL_MS);
  }, RETENTION_INITIAL_DELAY_MS);

  return { server, ctx };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';

  // CORS 预检
  setCorsHeaders(res, ctx.config, req);
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 路由分发
  const path = url.pathname;

  // ─── 健康检查 ────────────────────────────
  if (path === '/health' && method === 'GET') {
    return sendJson(res, 200, { status: 'ok', service: 'memforge-gateway', timestamp: new Date().toISOString() });
  }

  // ─── Prometheus 指标端点 ────────────────
  if (path === '/metrics' && method === 'GET') {
    const metricsToken = process.env.METRICS_TOKEN;
    if (metricsToken) {
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${metricsToken}`) {
        const clientIp = getClientIp(req);
        if (clientIp !== '127.0.0.1' && clientIp !== '::1' && clientIp !== '::ffff:127.0.0.1') {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(registry.serialize());
    return;
  }

  // ─── OAuth 发现 ────────────────────────────
  if (path === '/.well-known/oauth-authorization-server' && method === 'GET') {
    const baseUrl = `http://${req.headers.host ?? `${ctx.config.host}:${ctx.config.port}`}`;
    return sendJson(res, 200, ctx.oauth.getDiscoveryMetadata(baseUrl));
  }

  // ─── OAuth 授权端点 ────────────────────────
  if (path === '/oauth/authorize' && method === 'POST') {
    return handleAuthorize(req, res, ctx);
  }

  // ─── OAuth Token 端点 ──────────────────────
  if (path === '/oauth/token' && method === 'POST') {
    return handleToken(req, res, ctx);
  }

  // ─── OAuth Token 撤销 ─────────────────────
  if (path === '/oauth/revoke' && method === 'POST') {
    return handleRevoke(req, res, ctx);
  }

  // ─── MCP 原生端点（Streamable HTTP，方案 C）──────
  if (path === '/mcp' && (method === 'POST' || method === 'GET')) {
    return handleNativeMcp(req, res, ctx);
  }

  // ─── MCP 代理端点（向后兼容，将逐步废弃）────────
  if (path === '/mcp/legacy' && method === 'POST') {
    return handleMcpProxy(req, res, ctx);
  }

  // ─── 用户信息（需认证）─────────────────────
  if (path === '/api/userinfo' && method === 'GET') {
    return handleUserInfo(req, res, ctx);
  }

  // ─── 审计日志查询（admin 专用）────────────
  if (path === '/api/audit-logs' && method === 'GET') {
    return handleAuditLogs(req, res, ctx, url);
  }

  // ─── 用户管理 API（admin 专用）─────────
  if (path.startsWith('/api/users')) {
    return handleUserManagementApi(req, res, ctx, url);
  }

  // ─── 团队管理 API ─────────────────────
  if (path.startsWith('/api/teams')) {
    return handleTeamsApi(req, res, ctx, url);
  }

  // ─── 产品线 API ────────────────────────
  if (path.startsWith('/api/product-lines')) {
    return handleProductLineApi(req, res, ctx, url);
  }

  // ─── API Key 管理 ──────────────────────
  if (path.startsWith('/api/api-keys')) {
    return handleApiKeyApi(req, res, ctx, url);
  }

  // ─── 设备管理 API ──────────────────────
  if (path.startsWith('/api/devices')) {
    return handleDeviceApi(req, res, ctx, url);
  }

  // ─── MCP 客户端在线状态 API ───────────
  if (path === '/api/mcp-clients' && method === 'GET') {
    return handleMcpClients(req, res, ctx);
  }

  // ─── 远程扫描触发 API ──────────────────
  if (path === '/api/topology/scan-remote' && method === 'POST') {
    return handleRemoteScan(req, res, ctx);
  }

  // ─── SSE 一次性 ticket（需认证）──────────
  if (path === '/api/sse-ticket' && method === 'POST') {
    return handleSseTicket(req, res, ctx);
  }

  // ─── 扫描进度 SSE 端点 ─────────────────
  if (path.startsWith('/api/topology/scan-progress/') && method === 'GET') {
    return handleScanProgressSSE(req, res, ctx);
  }

  // ─── 拓扑 REST API 代理（需认证 + 产品线 ACL）───
  // Knowledge Service REST API 代理
  if (path.startsWith('/api/knowledge/')) {
    return handleKnowledgeProxy(req, res, ctx);
  }

  if (path.startsWith('/api/topology/')) {
    return handleTopologyProxy(req, res, ctx);
  }

  // ─── Memory Service REST API 代理 ───
  if (path.startsWith('/api/memory/')) {
    return handleMemoryProxy(req, res, ctx);
  }

  // ─── 记忆数据辅助查询（需认证，无产品线 ACL）───
  if (path === '/api/memories/distinct-projects' && method === 'GET') {
    return handleDistinctProjectsProxy(req, res, ctx);
  }
  if (path.match(/^\/api\/memories\/[^/]+\/visibility$/) && method === 'PUT') {
    return handleTeamsApi(req, res, ctx, url);
  }

  // ─── Setup API（公开端点，用于自动化客户端配置）───
  if (path === '/api/setup/ide-rules' && method === 'GET') {
    return handleSetupIdeRules(req, res);
  }
  if (path === '/api/setup/ide-hooks' && method === 'GET') {
    return handleSetupIdeHooks(req, res);
  }
  if (path === '/api/setup/cursor-rules' && method === 'GET') {
    return handleSetupIdeRules(req, res, 'cursor');
  }
  if (path === '/api/setup/proxy-script' && method === 'GET') {
    return handleSetupProxyScript(req, res);
  }
  if (path === '/api/setup/install-script' && method === 'GET') {
    return handleInstallScript(req, res);
  }
  if (path === '/api/setup/cursor-hooks' && method === 'GET') {
    return handleSetupIdeHooks(req, res, 'cursor');
  }

  // ─── Reviews API（需认证）───
  if (path.startsWith('/api/reviews')) {
    const tokenPayload = await authenticateRequest(req, ctx);
    if (!tokenPayload) {
      return sendJson(res, 401, { error: 'unauthorized', message: '需要登录后访问' });
    }
    const { handleReviewsApi } = await import('./api/reviews-api.js');
    return handleReviewsApi(req, res, url, sendJson, tokenPayload.role);
  }

  // ─── Webhooks 管理 API（需认证 + admin）───
  if (path.startsWith('/api/webhooks')) {
    const tokenPayload = await authenticateRequest(req, ctx);
    if (!tokenPayload) {
      return sendJson(res, 401, { error: 'unauthorized', message: '需要登录后访问' });
    }
    const { handleWebhooksApi } = await import('./api/webhooks-api.js');
    return handleWebhooksApi(req, res, url, sendJson, tokenPayload.role);
  }

  // ─── Hook Token 管理 API（需认证 + admin 权限）───
  if (path === '/api/hooks/tokens' && ['GET', 'POST', 'DELETE'].includes(method)) {
    const tokenPayload = await authenticateRequest(req, ctx);
    if (!tokenPayload) {
      return sendJson(res, 401, { error: 'unauthorized', message: '需要登录后访问' });
    }
    if (tokenPayload.role !== 'admin' && !tokenPayload.isSuperAdmin) {
      return sendJson(res, 403, { error: 'forbidden', message: '仅管理员可管理 Hook Token' });
    }
    const { handleTokenApi } = await import('./hooks/token-api.js');
    const body = method !== 'GET' ? await readJsonBody(req) : null;
    return handleTokenApi(method, body as Record<string, unknown> | null, sendJson, res);
  }

  // ─── Setup: test-dingtalk ───
  if (path === '/api/setup/test-dingtalk' && method === 'POST') {
    const tokenPayload = await authenticateRequest(req, ctx);
    if (!tokenPayload) {
      return sendJson(res, 401, { error: 'unauthorized', message: '需要登录后访问' });
    }
    if (tokenPayload.role !== 'admin' && !tokenPayload.isSuperAdmin) {
      return sendJson(res, 403, { error: 'forbidden', message: '仅管理员可测试钉钉通知' });
    }
    return handleTestDingtalk(req, res);
  }

  // ─── Git Hook API（Token 认证，不走 OAuth）───
  if (path.startsWith('/api/hooks/')) {
    return handleHooksApi(req, res, url, ctx);
  }
  if (path === '/api/setup/git-hooks' && method === 'GET') {
    return handleSetupGitHooks(req, res);
  }
  if (path === '/api/setup/git-hooks-template' && method === 'GET') {
    return handleSetupGitHooksTemplate(req, res);
  }

  sendJson(res, 404, { error: 'not_found', message: `路径 ${path} 不存在` });
}

// ═══════════════════════════════════════════════
//  OAuth 端点实现
// ═══════════════════════════════════════════════

async function handleAuthorize(req: IncomingMessage, res: ServerResponse, ctx: GatewayContext): Promise<void> {
  const body = await readJsonBody(req);
  if (!body) {
    return sendJson(res, 400, { error: 'invalid_request', message: '请求体必须为 JSON' });
  }

  const { client_id, code_challenge, code_challenge_method, redirect_uri, external_id, org_slug, password } = body as Record<string, string>;

  if (!client_id || !code_challenge || !redirect_uri) {
    return sendJson(res, 400, { error: 'invalid_request', message: '缺少必填参数' });
  }
  if (code_challenge_method && code_challenge_method !== 'S256') {
    return sendJson(res, 400, { error: 'invalid_request', message: '仅支持 S256 PKCE' });
  }

  const client = ctx.oauth.getClient(client_id);
  if (!client) {
    return sendJson(res, 400, { error: 'invalid_client', message: '未知的客户端 ID' });
  }

  if (client.redirectUris.length > 0 && !client.redirectUris.includes(redirect_uri)) {
    return sendJson(res, 400, { error: 'invalid_request', message: 'redirect_uri 不在白名单中' });
  }

  let user: { id: string };
  const tokenPayload = await authenticateRequest(req, ctx);

  if (tokenPayload) {
    const existingUser = await ctx.userStore.findById(tokenPayload.sub);
    if (!existingUser) {
      return sendJson(res, 401, { error: 'invalid_token', message: '用户不存在' });
    }
    user = existingUser;
  } else if (password && external_id) {
    const clientIp = getClientIp(req) ?? 'unknown';
    const loginLimit = ctx.loginRateLimiter.check(clientIp, external_id);
    if (loginLimit) {
      ctx.auditLogger.logAuthEvent({
        action: 'AUTH_RATE_LIMITED',
        userId: null,
        details: { externalId: external_id, reason: loginLimit.reason, retryAfterMs: loginLimit.retryAfterMs },
        ipAddress: clientIp,
        userAgent: req.headers['user-agent'] ?? null,
      });
      res.setHeader('Retry-After', Math.ceil(loginLimit.retryAfterMs / 1000).toString());
      return sendJson(res, 429, {
        error: 'rate_limit',
        message: '登录尝试过于频繁，请稍后重试',
        retry_after_ms: loginLimit.retryAfterMs,
      });
    }

    const lockStatus = ctx.loginLock.check(external_id);
    if (lockStatus.locked) {
      ctx.auditLogger.logAuthEvent({
        action: 'AUTH_LOCKED',
        userId: null,
        details: { externalId: external_id, retryAfterMs: lockStatus.retryAfterMs },
        ipAddress: clientIp,
        userAgent: req.headers['user-agent'] ?? null,
      });
      res.setHeader('Retry-After', Math.ceil(lockStatus.retryAfterMs / 1000).toString());
      return sendJson(res, 423, {
        error: 'account_locked',
        message: '账号因连续登录失败被临时锁定，请稍后重试',
        retry_after_ms: lockStatus.retryAfterMs,
      });
    }

    const orgId = '00000000-0000-0000-0000-000000000001';
    // 与 handleToken 一致：关闭开放注册时禁止自动注册
    const authResult = ctx.config.openRegistration
      ? await ctx.userStore.authenticateWithPassword?.({ orgId, externalId: external_id, password })
      : await ctx.userStore.authenticateOnly?.({ orgId, externalId: external_id, password });
    if (!authResult) {
      const lockResult = ctx.loginLock.recordFailure(external_id);
      ctx.auditLogger.logAuthEvent({
        action: 'AUTH_FAILED',
        userId: null,
        details: { clientId: client_id, reason: 'invalid_credentials', externalId: external_id, remainingAttempts: lockResult.remainingAttempts },
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      const msg = lockResult.locked
        ? `密码错误，账号已锁定 ${Math.ceil(lockResult.retryAfterMs / 60_000)} 分钟`
        : `密码错误（剩余 ${lockResult.remainingAttempts} 次尝试机会）`;
      return sendJson(res, 401, { error: 'invalid_credentials', message: msg, remaining_attempts: lockResult.remainingAttempts });
    }
    if ('error' in authResult) {
      return sendJson(res, 400, { error: authResult.error, message: authResult.message });
    }
    ctx.loginLock.clearOnSuccess(external_id);
    user = authResult.user;
  } else if (external_id && ctx.config.openRegistration) {
    const orgId = '00000000-0000-0000-0000-000000000001';
    user = await ctx.userStore.findOrCreateByExternalId({
      orgId,
      externalId: external_id,
      displayName: (body as Record<string, string>).display_name,
      email: (body as Record<string, string>).email,
    });
  } else {
    return sendJson(res, 401, { error: 'login_required', message: '需要 Bearer Token 或密码认证' });
  }

  const code = ctx.oauth.createAuthorizationCode(
    client_id, user.id, code_challenge, 'S256', redirect_uri,
  );

  ctx.auditLogger.logAuthEvent({
    action: 'LOGIN',
    userId: user.id,
    details: { clientId: client_id, method: tokenPayload ? 'token_refresh' : password ? 'password' : 'open_registration' },
    ipAddress: getClientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
  });

  sendJson(res, 200, { code, redirect_uri });
}

async function checkUserHasTeam(userId: string): Promise<boolean> {
  try {
    const pool = (await import('@memforgeai/shared')).getPool();
    const { rows } = await pool.query(
      `SELECT 1 FROM memory.team_members WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    return rows.length > 0;
  } catch (err) {
    // 数据库不可用时拒绝 MCP 访问，避免 fail-open 绕过团队校验
    logger.error({ userId, err }, 'checkUserHasTeam 查询失败，拒绝 MCP 访问');
    return false;
  }
}

async function handleToken(req: IncomingMessage, res: ServerResponse, ctx: GatewayContext): Promise<void> {
  const body = await readJsonBody(req);
  if (!body) {
    return sendJson(res, 400, { error: 'invalid_request' });
  }

  const params = body as Record<string, string>;

  try {
    if (params.grant_type === 'authorization_code') {
      const { code, client_id, code_verifier, redirect_uri } = params;
      if (!code || !client_id || !code_verifier || !redirect_uri) {
        return sendJson(res, 400, { error: 'invalid_request', message: '缺少必填参数' });
      }

      // 需要从 code 对应的 userId 获取用户信息
      // 简化实现：先 exchange 验证 PKCE，再查 user
      // 实际上 exchangeCode 需要 user，这里通过 code 中存储的 userId 查找
      const user = await findUserFromAuthCode(ctx, code);
      if (!user) {
        return sendJson(res, 400, { error: 'invalid_grant', message: '授权码对应的用户不存在' });
      }

      const tokens = await ctx.oauth.exchangeCode(code, client_id, code_verifier, redirect_uri, user);

      ctx.auditLogger.logAuthEvent({
        action: 'TOKEN_ISSUED',
        userId: user.id,
        details: { clientId: client_id, grantType: 'authorization_code' },
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });

      return sendJson(res, 200, {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
      });
    }

    if (params.grant_type === 'refresh_token') {
      const { refresh_token, client_id } = params;
      if (!refresh_token || !client_id) {
        return sendJson(res, 400, { error: 'invalid_request' });
      }

      // 从 refresh token 获取 userId 并查找用户
      const tokenPayload = await extractRefreshTokenUser(ctx, refresh_token);
      if (!tokenPayload) {
        return sendJson(res, 400, { error: 'invalid_grant' });
      }

      const user = await ctx.userStore.findById(tokenPayload);
      if (!user) {
        return sendJson(res, 400, { error: 'invalid_grant' });
      }

      const tokens = await ctx.oauth.refreshAccessToken(refresh_token, client_id, user);

      ctx.auditLogger.logAuthEvent({
        action: 'TOKEN_REFRESHED',
        userId: user.id,
        details: { clientId: client_id },
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });

      return sendJson(res, 200, {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
      });
    }

    // 简化模式：client_credentials（WebUI 登录 / MCP 客户端认证）
    if (params.grant_type === 'client_credentials') {
      const { client_id, external_id, password } = params;
      if (!client_id || !external_id) {
        return sendJson(res, 400, { error: 'invalid_request', message: '需要 client_id 和 external_id' });
      }
      if (!password) {
        return sendJson(res, 400, { error: 'invalid_request', message: '需要 password' });
      }

      // 登录限流检查（仅 client_credentials + password）
      const clientIp = getClientIp(req) ?? 'unknown';
      const loginLimit = ctx.loginRateLimiter.check(clientIp, external_id);
      if (loginLimit) {
        ctx.auditLogger.logAuthEvent({
          action: 'AUTH_RATE_LIMITED',
          userId: null,
          details: { externalId: external_id, reason: loginLimit.reason, retryAfterMs: loginLimit.retryAfterMs },
          ipAddress: clientIp,
          userAgent: req.headers['user-agent'] ?? null,
        });
        res.setHeader('Retry-After', Math.ceil(loginLimit.retryAfterMs / 1000).toString());
        return sendJson(res, 429, {
          error: 'rate_limit',
          message: '登录尝试过于频繁，请稍后重试',
          retry_after_ms: loginLimit.retryAfterMs,
        });
      }

      // 登录锁定检查
      const lockStatus = ctx.loginLock.check(external_id);
      if (lockStatus.locked) {
        ctx.auditLogger.logAuthEvent({
          action: 'AUTH_LOCKED',
          userId: null,
          details: { externalId: external_id, retryAfterMs: lockStatus.retryAfterMs },
          ipAddress: clientIp,
          userAgent: req.headers['user-agent'] ?? null,
        });
        res.setHeader('Retry-After', Math.ceil(lockStatus.retryAfterMs / 1000).toString());
        return sendJson(res, 423, {
          error: 'account_locked',
          message: '账号因连续登录失败被临时锁定，请稍后重试',
          retry_after_ms: lockStatus.retryAfterMs,
        });
      }

      const orgId = '00000000-0000-0000-0000-000000000001';

      let user: import('./auth/types.js').AuthUser;
      let isNewUser = false;

      if (ctx.config.openRegistration) {
        // 开放注册模式：首次登录自动注册（密码策略由 userStore 内部按场景校验）
        const authResult = await ctx.userStore.authenticateWithPassword({
          orgId,
          externalId: external_id,
          password,
          displayName: params.display_name,
        });

        if (!authResult) {
          const lockResult = ctx.loginLock.recordFailure(external_id);
          ctx.auditLogger.logAuthEvent({
            action: 'AUTH_FAILED',
            userId: null,
            details: { externalId: external_id, reason: 'invalid_password', remainingAttempts: lockResult.remainingAttempts },
            ipAddress: clientIp,
            userAgent: req.headers['user-agent'] ?? null,
          });
          const msg = lockResult.locked
            ? `密码错误，账号已锁定 ${Math.ceil(lockResult.retryAfterMs / 60_000)} 分钟`
            : `密码错误（剩余 ${lockResult.remainingAttempts} 次尝试机会）`;
          return sendJson(res, 401, { error: 'invalid_credentials', message: msg, remaining_attempts: lockResult.remainingAttempts });
        }

        if ('error' in authResult) {
          return sendJson(res, 400, { error: authResult.error, message: authResult.message });
        }

        user = authResult.user;
        isNewUser = authResult.isNewUser;
      } else {
        // 关闭注册模式：仅验证已有用户
        const authResult = await ctx.userStore.authenticateOnly({
          orgId,
          externalId: external_id,
          password,
        });

        if (!authResult) {
          const lockResult = ctx.loginLock.recordFailure(external_id);
          ctx.auditLogger.logAuthEvent({
            action: 'AUTH_FAILED',
            userId: null,
            details: { externalId: external_id, reason: 'invalid_credentials', remainingAttempts: lockResult.remainingAttempts },
            ipAddress: clientIp,
            userAgent: req.headers['user-agent'] ?? null,
          });
          const msg = lockResult.locked
            ? `用户名或密码错误，账号已锁定 ${Math.ceil(lockResult.retryAfterMs / 60_000)} 分钟`
            : `用户名或密码错误（剩余 ${lockResult.remainingAttempts} 次尝试机会）`;
          return sendJson(res, 401, { error: 'invalid_credentials', message: msg, remaining_attempts: lockResult.remainingAttempts });
        }
        if ('error' in authResult) {
          return sendJson(res, 400, { error: authResult.error, message: authResult.message });
        }

        user = authResult.user;
      }

      // 登录成功，清除失败计数
      ctx.loginLock.clearOnSuccess(external_id);

      // 设备验证逻辑
      if (ctx.config.deviceVerification) {
        const deviceId = params.device_id;
        if (!deviceId) {
          return sendJson(res, 400, { error: 'device_id_required', message: '需要提供 device_id' });
        }

        const existing = await ctx.deviceStore.findByUserAndDevice(user.id, deviceId);
        if (!existing) {
          const isBootstrap = await ctx.deviceStore.isBootstrapScenario(user.id);
          const shouldAutoApprove = isBootstrap;
          const status = shouldAutoApprove ? 'approved' as const : 'pending' as const;
          await ctx.deviceStore.register({
            userId: user.id,
            deviceId,
            deviceName: params.device_name ?? parseDeviceName(req.headers['user-agent']),
            deviceType: params.device_type ?? 'web',
            userAgent: req.headers['user-agent'],
            ip: getClientIp(req) ?? undefined,
            status,
            approvedBy: shouldAutoApprove ? user.id : undefined,
          });

          if (!shouldAutoApprove) {
            ctx.auditLogger.logAuthEvent({
              action: 'DEVICE_PENDING',
              userId: user.id,
              details: { deviceId, isNewUser },
              ipAddress: getClientIp(req),
              userAgent: req.headers['user-agent'] ?? null,
            });
            return sendJson(res, 403, {
              error: 'device_pending_approval',
              message: '新设备等待管理员审批',
              device_id: deviceId,
            });
          }
          logger.info({ userId: user.id, deviceId, isBootstrap }, '设备自动批准（仅 bootstrap 场景）');
        } else if (existing.status === 'pending') {
          return sendJson(res, 403, {
            error: 'device_pending_approval',
            message: '设备等待管理员审批',
            device_id: deviceId,
          });
        } else if (existing.status === 'revoked') {
          return sendJson(res, 403, {
            error: 'device_revoked',
            message: '该设备已被吊销，请联系管理员',
            device_id: deviceId,
          });
        }

        await ctx.deviceStore.updateLastSeen(user.id, deviceId, getClientIp(req) ?? undefined);
      }

      const deviceId = ctx.config.deviceVerification ? params.device_id : undefined;
      const tokens = await ctx.oauth.issueTokenPair(user, client_id, deviceId);

      ctx.auditLogger.logAuthEvent({
        action: isNewUser ? 'USER_REGISTERED' : 'TOKEN_ISSUED',
        userId: user.id,
        details: { clientId: client_id, grantType: 'client_credentials', isNewUser },
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });

      // 检查用户团队状态
      let teamStatus: 'active' | 'needs_team_selection' | 'pending_approval' = 'active';
      try {
        const sharedPool = (await import('@memforgeai/shared')).getPool();
        const { rows: membership } = await sharedPool.query(
          `SELECT tm.team_id FROM memory.team_members tm WHERE tm.user_id = $1 LIMIT 1`,
          [user.id],
        );
        if (membership.length === 0) {
          const { rows: pendingReqs } = await sharedPool.query(
            `SELECT id FROM memory.team_join_requests WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
            [user.id],
          );
          teamStatus = pendingReqs.length > 0 ? 'pending_approval' : 'needs_team_selection';
        }
      } catch {
        // team_join_requests 表可能还未创建
      }

      return sendJson(res, 200, {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        is_new_user: isNewUser,
        team_status: teamStatus,
      });
    }

    sendJson(res, 400, { error: 'unsupported_grant_type' });
  } catch (err) {
    if (err instanceof OAuthError) {
      ctx.auditLogger.logAuthEvent({
        action: 'AUTH_FAILED',
        userId: null,
        details: { error: err.errorCode, message: err.message },
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      return sendJson(res, 400, { error: err.errorCode, error_description: err.message });
    }
    throw err;
  }
}

async function handleRevoke(req: IncomingMessage, res: ServerResponse, ctx: GatewayContext): Promise<void> {
  const body = await readJsonBody(req);
  if (!body) {
    return sendJson(res, 400, { error: 'invalid_request' });
  }
  const { token } = body as Record<string, string>;
  if (token) {
    ctx.oauth.revokeRefreshToken(token);

    ctx.auditLogger.logAuthEvent({
      action: 'TOKEN_REVOKED',
      userId: null,
      details: {},
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
  }
  sendJson(res, 200, {});
}

// ═══════════════════════════════════════════════
//  MCP 原生端点（方案 C：Gateway 作为 MCP Server）
// ═══════════════════════════════════════════════

async function handleNativeMcp(req: IncomingMessage, res: ServerResponse, ctx: GatewayContext): Promise<void> {
  mcpRequestTotal.inc();
  activeConnections.inc();

  try {
    const tokenPayload = await authenticateRequest(req, ctx);
    if (!tokenPayload) {
      ctx.auditLogger.logAuthEvent({
        action: 'AUTH_FAILED',
        userId: null,
        details: { path: '/mcp' },
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      return sendJson(res, 401, {
        jsonrpc: '2.0',
        error: { code: -32000, message: '未提供有效的 Bearer Token' },
        id: null,
      });
    }

    // 未加入任何团队的用户不能使用 MCP 功能
    if (!tokenPayload.teamId) {
      const hasTeam = await checkUserHasTeam(tokenPayload.sub);
      if (!hasTeam) {
        return sendJson(res, 403, {
          jsonrpc: '2.0',
          error: { code: -32000, message: '请先加入一个团队并等待审批通过后再使用' },
          id: null,
        });
      }
    }

    const bodyStr = await readRawBody(req);
    let mcpBody: Record<string, unknown> = {};
    if (bodyStr) {
      try {
        mcpBody = JSON.parse(bodyStr) as Record<string, unknown>;
      } catch {
        return sendJson(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32700, message: '请求体不是有效 JSON' },
          id: null,
        });
      }
    }

    const mcpMethod = mcpBody.method as string | undefined;
    const tool = ctx.router.extractToolName(mcpBody);

    if (mcpMethod === 'tools/call' && tool) {
      const rateLimitResult = ctx.rateLimiter.check(tokenPayload.sub, tool);
      if (rateLimitResult) {
        rateLimitHits.inc({ reason: rateLimitResult.reason });
        return sendJson(res, 429, {
          jsonrpc: '2.0',
          error: { code: -32000, message: `速率限制: ${rateLimitResult.reason}` },
          id: mcpBody.id ?? null,
        });
      }

      const scopeDenied = ctx.rbac.checkApiKeyScope(tokenPayload.apiKeyScope, tool);
      if (scopeDenied) {
        return sendJson(res, 403, {
          jsonrpc: '2.0',
          error: { code: -32000, message: scopeDenied },
          id: mcpBody.id ?? null,
        });
      }

      const plDenied = await checkTopologyProductLineAcl(ctx, tokenPayload, tool, mcpBody);
      if (plDenied) {
        return sendJson(res, 403, {
          jsonrpc: '2.0',
          error: { code: -32000, message: plDenied },
          id: mcpBody.id ?? null,
        });
      }
    }

    const mcpCtx: GatewayMcpContext = {
      userId: tokenPayload.sub,
      orgId: tokenPayload.org,
      teamId: tokenPayload.teamId ?? null,
      userRole: tokenPayload.role,
      deviceId: tokenPayload.did ?? (req.headers['x-device-id'] as string) ?? (req.headers['x-memforge-device-id'] as string) ?? null,
      router: ctx.router,
      memoryServiceUrl: ctx.config.memoryServiceUrl,
      rulesServiceUrl: ctx.config.rulesServiceUrl,
      knowledgeServiceUrl: ctx.config.knowledgeServiceUrl,
      mcpClients: ctx.mcpClients,
      rbac: ctx.rbac,
      auditLogger: ctx.auditLogger,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
      apiKeyScope: tokenPayload.apiKeyScope,
    };

    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const mcpServer = createGatewayMcpServer(mcpCtx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    const patchedReq = incomingMessageWithBody(req, bodyStr);
    await transport.handleRequest(patchedReq, res);
    res.on('close', () => {
      transport.close();
      mcpServer.close();
    });
  } catch (err) {
    logger.error({ error: err }, 'MCP 原生端点处理失败');
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: '服务器内部错误' },
        id: null,
      });
    }
  } finally {
    activeConnections.dec();
  }
}

// ═══════════════════════════════════════════════
//  MCP 代理端点（向后兼容，将逐步废弃）
// ═══════════════════════════════════════════════

async function handleMcpProxy(req: IncomingMessage, res: ServerResponse, ctx: GatewayContext): Promise<void> {
  const startMs = Date.now();
  mcpRequestTotal.inc();
  activeConnections.inc();

  try {
    await handleMcpProxyInner(req, res, ctx, startMs);
  } finally {
    activeConnections.dec();
  }
}

async function handleMcpProxyInner(req: IncomingMessage, res: ServerResponse, ctx: GatewayContext, startMs: number): Promise<void> {
  // 1. 认证
  authAttempts.inc();
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) {
    ctx.auditLogger.logAuthEvent({
      action: 'AUTH_FAILED',
      userId: null,
      details: { path: '/mcp' },
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    return sendJson(res, 401, { error: 'unauthorized', message: '未提供有效的 Bearer Token' });
  }

  // 1.5 未加入团队的用户不能使用 MCP
  if (!tokenPayload.teamId) {
    const hasTeam = await checkUserHasTeam(tokenPayload.sub);
    if (!hasTeam) {
      return sendJson(res, 403, { error: 'team_required', message: '请先加入一个团队并等待审批通过后再使用' });
    }
  }

  // 2. 读取请求体
  const bodyStr = await readRawBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyStr);
  } catch {
    return sendJson(res, 400, { error: 'invalid_request', message: '请求体不是有效 JSON' });
  }

  const method = body.method as string | undefined;
  const tool = ctx.router.extractToolName(body);

  // 3. MCP 元信息请求（tools/list 等）直接代理到两个服务并合并
  if (method && ctx.router.isReadOnlyMethod(method)) {
    return handleMcpMetaRequest(req, res, ctx, bodyStr, tokenPayload, method);
  }

  // 4. 工具调用需要 RBAC 检查
  if (method === 'tools/call' && tool) {
    // 速率限制
    const rateLimitResult = ctx.rateLimiter.check(tokenPayload.sub, tool);
    if (rateLimitResult) {
      rateLimitHits.inc({ reason: rateLimitResult.reason });
      return sendJson(res, 429, {
        error: 'rate_limited',
        message: `速率限制: ${rateLimitResult.reason}`,
        retry_after_ms: rateLimitResult.retryAfterMs,
      });
    }

    // RBAC 检查
    const denied = ctx.rbac.checkPermission(tokenPayload.role, tool);
    if (denied) {
      ctx.auditLogger.logToolCall({
        orgId: tokenPayload.org,
        userId: tokenPayload.sub,
        tool,
        args: ((body.params as Record<string, unknown>)?.arguments as Record<string, unknown>) ?? {},
        success: false,
        durationMs: Date.now() - startMs,
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      return sendJson(res, 403, { error: 'forbidden', message: denied });
    }

    const scopeDenied = ctx.rbac.checkApiKeyScope(tokenPayload.apiKeyScope, tool);
    if (scopeDenied) {
      ctx.auditLogger.logToolCall({
        orgId: tokenPayload.org,
        userId: tokenPayload.sub,
        tool,
        args: ((body.params as Record<string, unknown>)?.arguments as Record<string, unknown>) ?? {},
        success: false,
        durationMs: Date.now() - startMs,
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      return sendJson(res, 403, { error: 'forbidden', message: scopeDenied });
    }

    // 产品线 ACL 检查（对拓扑类工具生效）
    const PL_AWARE_TOOLS: Record<string, 'read' | 'write' | 'manage'> = {
      query_topology: 'read',
      get_topology_release_order: 'read',
      get_topology_change_impact: 'read',
      resolve_service_path: 'read',
      scan_topology: 'manage',
      import_topology: 'write',
    };
    const plRequiredLevel = PL_AWARE_TOOLS[tool];
    if (plRequiredLevel) {
      const toolArgs = (body.params as Record<string, unknown>)?.arguments as Record<string, unknown> | undefined;
      const productLine = (toolArgs?.product_line as string) ?? null;
      if (productLine) {
        const plExists = await ctx.plAcl.isProductLineExists(productLine);

        if (!plExists && (tool === 'scan_topology' || tool === 'import_topology')) {
          // 新产品线：仅 admin/lead 可创建
          if (!ctx.rbac.hasRole(tokenPayload.role, 'lead')) {
            return sendJson(res, 403, {
              error: 'forbidden',
              message: `产品线「${productLine}」不存在，仅 lead/admin 角色可创建新产品线。请联系管理员。`,
            });
          }
        } else if (plExists) {
          const plAllowed = await ctx.plAcl.checkAccess(tokenPayload.sub, productLine, plRequiredLevel);
          if (!plAllowed) {
            return sendJson(res, 403, {
              error: 'forbidden',
              message: `无权访问产品线「${productLine}」（需要 ${plRequiredLevel} 权限）`,
            });
          }
        }
      }
    }

    // 路由到后端服务
    const serviceUrl = ctx.router.resolveServiceUrl(tool);
    if (!serviceUrl) {
      return sendJson(res, 400, { error: 'unknown_tool', message: `未知工具: ${tool}` });
    }

    try {
      const result = await ctx.router.proxyRequest(serviceUrl, bodyStr, {
        'x-memforge-user-id': tokenPayload.sub,
        'x-memforge-org-id': tokenPayload.org,
        'x-memforge-team-id': tokenPayload.teamId ?? '',
        'x-memforge-user-role': tokenPayload.role,
        ...(tokenPayload.isSuperAdmin ? { 'x-memforge-super-admin': 'true' } : {}),
      });
      mcpRequestDuration.observe({ tool }, result.durationMs);

      if (result.status >= 400) {
        mcpRequestErrors.inc({ tool });
      }

      ctx.auditLogger.logToolCall({
        orgId: tokenPayload.org,
        userId: tokenPayload.sub,
        tool,
        args: ((body.params as Record<string, unknown>)?.arguments as Record<string, unknown>) ?? {},
        success: result.status < 400,
        durationMs: result.durationMs,
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });

      // scan_topology / import_topology 成功后自动授予扫描者产品线 manage 权限
      if (result.status < 400 && (tool === 'scan_topology' || tool === 'import_topology')) {
        const toolArgs = (body.params as Record<string, unknown>)?.arguments as Record<string, unknown> | undefined;
        const pl = (toolArgs?.product_line as string) ?? null;
        if (pl) {
          const hasAccess = await ctx.plAcl.checkAccess(tokenPayload.sub, pl, 'manage');
          if (!hasAccess) {
            await ctx.plAcl.grantAccess(tokenPayload.sub, pl, 'manage', tokenPayload.sub);
            logger.info({ userId: tokenPayload.sub, productLine: pl }, '扫描成功，自动授予产品线 manage 权限');
          }
        }
      }

      res.writeHead(result.status, {
        'Content-Type': 'application/json',
      });
      res.end(result.body);
    } catch (err) {
      if (err instanceof RouterError) {
        return sendJson(res, 502, { error: 'bad_gateway', message: err.message });
      }
      throw err;
    }
    return;
  }

  // 未知 MCP 方法，直接代理到 memory service
  try {
    const result = await ctx.router.proxyRequest(ctx.config.memoryServiceUrl, bodyStr, {
      'x-memforge-user-id': tokenPayload.sub,
      'x-memforge-org-id': tokenPayload.org,
      'x-memforge-team-id': tokenPayload.teamId ?? '',
      'x-memforge-user-role': tokenPayload.role,
      ...(tokenPayload.isSuperAdmin ? { 'x-memforge-super-admin': 'true' } : {}),
    });
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.body);
  } catch {
    sendJson(res, 502, { error: 'bad_gateway', message: '后端服务不可用' });
  }
}

/**
 * tools/list 缓存：合并后的工具列表（按角色缓存），TTL 60s
 */
const toolsListCache = new Map<string, { data: unknown[]; ts: number }>();
const TOOLS_LIST_CACHE_TTL = 60_000;

/**
 * 处理 MCP 元信息请求（tools/list 等），合并两个后端服务的结果
 */
async function handleMcpMetaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
  bodyStr: string,
  tokenPayload: TokenPayload,
  method: string,
): Promise<void> {
  const toolsCacheKey = `role:${tokenPayload.role}:scope:${tokenPayload.apiKeyScope ?? 'jwt'}`;
  try {
    if (method === 'tools/list') {
      const cacheKey = toolsCacheKey;
      const cached = toolsListCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < TOOLS_LIST_CACHE_TTL) {
        return sendJson(res, 200, {
          jsonrpc: '2.0',
          id: null,
          result: { tools: cached.data },
        });
      }
    }

    const userHeaders: Record<string, string> = {
      'x-memforge-user-id': tokenPayload.sub,
      'x-memforge-org-id': tokenPayload.org,
      'x-memforge-team-id': tokenPayload.teamId ?? '',
      'x-memforge-user-role': tokenPayload.role,
    };
    if (tokenPayload.isSuperAdmin) userHeaders['x-memforge-super-admin'] = 'true';
    const [memoryResult, rulesResult, knowledgeResult] = await Promise.allSettled([
      ctx.router.proxyRequest(ctx.config.memoryServiceUrl, bodyStr, userHeaders),
      ctx.router.proxyRequest(ctx.config.rulesServiceUrl, bodyStr, userHeaders),
      ctx.router.proxyRequest(ctx.config.knowledgeServiceUrl, bodyStr, userHeaders),
    ]);

    if (method === 'tools/list') {
      const tools: unknown[] = [];

      if (memoryResult.status === 'fulfilled') {
        const memBody = JSON.parse(memoryResult.value.body) as Record<string, unknown>;
        const memTools = ((memBody.result as Record<string, unknown>)?.tools as unknown[]) ?? [];
        tools.push(...memTools);
      }
      if (rulesResult.status === 'fulfilled') {
        const rulesBody = JSON.parse(rulesResult.value.body) as Record<string, unknown>;
        const ruleTools = ((rulesBody.result as Record<string, unknown>)?.tools as unknown[]) ?? [];
        tools.push(...ruleTools);
      }
      if (knowledgeResult.status === 'fulfilled') {
        const knowledgeBody = JSON.parse(knowledgeResult.value.body) as Record<string, unknown>;
        const knowledgeTools = ((knowledgeBody.result as Record<string, unknown>)?.tools as unknown[]) ?? [];
        tools.push(...knowledgeTools);
      }

      const accessibleTools = ctx.rbac.getAccessibleTools(tokenPayload.role);
      const accessibleNames = new Set(accessibleTools.map(t => t.tool));
      const filteredTools = tools.filter(t => {
        const name = (t as Record<string, unknown>).name as string;
        if (!accessibleNames.has(name)) return false;
        if (tokenPayload.apiKeyScope) {
          return ctx.rbac.checkApiKeyScope(tokenPayload.apiKeyScope, name) === null;
        }
        return true;
      });

      toolsListCache.set(toolsCacheKey, { data: filteredTools, ts: Date.now() });

      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id: null,
        result: { tools: filteredTools },
      });
    }

    // 其他元请求直接代理到 memory service
    if (memoryResult.status === 'fulfilled') {
      res.writeHead(memoryResult.value.status, { 'Content-Type': 'application/json' });
      res.end(memoryResult.value.body);
    } else {
      sendJson(res, 502, { error: 'bad_gateway' });
    }
  } catch {
    sendJson(res, 502, { error: 'bad_gateway', message: '后端服务不可用' });
  }
}

// ═══════════════════════════════════════════════
//  API 端点
// ═══════════════════════════════════════════════

async function handleUserInfo(req: IncomingMessage, res: ServerResponse, ctx: GatewayContext): Promise<void> {
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  const user = await ctx.userStore.findFullById(tokenPayload.sub);
  if (!user) {
    return sendJson(res, 404, { error: 'user_not_found' });
  }

  const accessibleTools = ctx.rbac.getAccessibleTools(user.role);
  const productLines = await ctx.plAcl.getAccessibleProductLines(user.id);

  // 查询用户主团队和团队状态
  let primaryTeam: { id: string; name: string; slug: string } | null = null;
  let teamStatus: 'active' | 'needs_team_selection' | 'pending_approval' = 'active';
  try {
    const pool = (await import('@memforgeai/shared')).getPool();
    const { rows } = await pool.query<{ id: string; name: string; slug: string }>(
      `SELECT t.id, t.name, t.slug FROM memory.team_members tm
       JOIN memory.teams t ON tm.team_id = t.id
       WHERE tm.user_id = $1 AND tm.is_primary = TRUE LIMIT 1`,
      [user.id],
    );
    if (rows.length > 0) {
      primaryTeam = rows[0];
    } else {
      const { rows: pendingReqs } = await pool.query(
        `SELECT id FROM memory.team_join_requests WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
        [user.id],
      );
      teamStatus = pendingReqs.length > 0 ? 'pending_approval' : 'needs_team_selection';
    }
  } catch { /* migration 未执行时静默跳过 */ }

  sendJson(res, 200, {
    id: user.id,
    org_id: user.orgId,
    email: user.email,
    display_name: user.displayName,
    role: user.role,
    is_super_admin: user.isSuperAdmin,
    product_lines: productLines,
    primary_team: primaryTeam,
    team_status: teamStatus,
    accessible_tools: accessibleTools.map(t => ({
      tool: t.tool,
      permission: t.permission,
      auto_approve: t.autoApprove,
    })),
  });
}

async function handleAuditLogs(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
  url: URL,
): Promise<void> {
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  if (rejectIfApiKeyLimited(res, tokenPayload)) return;

  if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
    return sendJson(res, 403, { error: 'forbidden', message: '仅 admin 角色可查看审计日志' });
  }

  const page = parseInt(url.searchParams.get('page') ?? '1', 10);
  const pageSize = Math.min(parseInt(url.searchParams.get('page_size') ?? '50', 10), 200);
  const offset = (page - 1) * pageSize;

  const { query: dbQuery } = await import('@memforgeai/shared');
  const [result, countResult] = await Promise.all([
    dbQuery(
      `SELECT id, org_id, user_id, action, resource_type, resource_id, details, ip_address, user_agent, created_at
       FROM memory.audit_logs
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    ),
    dbQuery('SELECT COUNT(*)::int AS total FROM memory.audit_logs'),
  ]);

  sendJson(res, 200, {
    logs: result.rows,
    total: countResult.rows[0]?.total ?? 0,
    page,
    page_size: pageSize,
  });
}

// ═══════════════════════════════════════════════
//  辅助函数
// ═══════════════════════════════════════════════

/** 同一 HTTP 请求内复用认证结果，避免重复 JWT 校验 / DB 查询 */
const requestAuthCache = new WeakMap<IncomingMessage, Promise<TokenPayload | null>>();

async function authenticateRequest(req: IncomingMessage, ctx: GatewayContext): Promise<TokenPayload | null> {
  const cached = requestAuthCache.get(req);
  if (cached) return cached;

  const authPromise = authenticateRequestInner(req, ctx);
  requestAuthCache.set(req, authPromise);
  return authPromise;
}

async function authenticateRequestInner(req: IncomingMessage, ctx: GatewayContext): Promise<TokenPayload | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);

  const cacheKey = `auth:${token.slice(-16)}`;
  const cached = await ctx.cache.get<TokenPayload>(cacheKey);
  if (cached) {
    if (ctx.config.deviceVerification && !await verifyDeviceForPayload(req, cached, ctx)) return null;
    return cached;
  }

  // 尝试 JWT 验证
  try {
    const payload = await ctx.oauth.verifyAccessToken(token);
    if (!payload.teamId) {
      payload.teamId = (await resolvePrimaryTeamId(payload.sub, payload.org, ctx)) ?? undefined;
    }
    // JWT 中的 role 可能已过期（admin 在 DB 改了角色后，旧 JWT 仍携带旧角色），
    // 从 DB 刷新实时角色，避免权限判断不一致
    const freshUser = await ctx.userStore.findFullById(payload.sub);
    if (freshUser) {
      if (freshUser.role !== payload.role) payload.role = freshUser.role;
      payload.isSuperAdmin = freshUser.isSuperAdmin;
    }
    if (ctx.config.deviceVerification && !await verifyDeviceForPayload(req, payload, ctx)) return null;
    // TTL 60s：缩短降权生效窗口；命中缓存时仍不实时刷新角色，需权衡 DB 负载
    await ctx.cache.set(cacheKey, payload, 60);
    return payload;
  } catch {
    // JWT 验证失败，尝试 API Key
  }

  // 尝试 API Key 验证
  if (token.startsWith('mfk_')) {
    try {
      const verified = await ctx.apiKeyStore.verify(token);
      if (verified) {
        const user = await ctx.userStore.findFullById(verified.userId);
        if (user) {
          const deviceId = (req.headers['x-device-id'] ?? req.headers['x-memforge-device-id']) as string | undefined;
          const primaryTeamId = await resolvePrimaryTeamId(user.id, user.orgId, ctx);
          const payload: TokenPayload = {
            sub: user.id,
            org: user.orgId,
            role: user.role,
            email: user.email ?? undefined,
            name: user.displayName ?? undefined,
            did: deviceId,
            teamId: primaryTeamId ?? undefined,
            isSuperAdmin: user.isSuperAdmin,
            apiKeyScope: verified.scope,
          };
          if (ctx.config.deviceVerification && !await verifyDeviceForPayload(req, payload, ctx)) return null;
          await ctx.cache.set(cacheKey, payload, 60);
          return payload;
        }
      }
    } catch {
      // API Key 验证异常，返回 null
    }
  }

  return null;
}

/**
 * 查询用户在指定 org 内的主团队 ID（带缓存）。
 * 表不存在时静默返回 null（兼容 migration 未执行的场景）。
 */

/** API Key 认证时 apiKeyScope 有值，禁止执行需 JWT 的 REST 管理操作 */
function rejectIfApiKeyLimited(res: ServerResponse, payload: TokenPayload): boolean {
  if (payload.apiKeyScope != null) {
    sendJson(res, 403, {
      error: 'forbidden',
      message: '此操作需要完整账号认证（JWT），API Key 权限不足',
    });
    return true;
  }
  return false;
}

async function resolvePrimaryTeamId(userId: string, orgId: string, ctx: GatewayContext): Promise<string | null> {
  const teamCacheKey = `team:primary:${userId}:${orgId}`;
  const cached = await ctx.cache.get<string>(teamCacheKey);
  if (cached) return cached === '_none_' ? null : cached;

  try {
    const pool = (await import('@memforgeai/shared')).getPool();
    const { rows } = await pool.query<{ team_id: string }>(
      `SELECT tm.team_id FROM memory.team_members tm
       JOIN memory.teams t ON tm.team_id = t.id
       WHERE tm.user_id = $1 AND t.org_id = $2 AND tm.is_primary = TRUE
       LIMIT 1`,
      [userId, orgId],
    );
    const teamId = rows[0]?.team_id ?? null;
    await ctx.cache.set(teamCacheKey, teamId ?? '_none_', 300);
    return teamId;
  } catch (err) {
    logger.warn({ err, userId, orgId }, '查询主团队失败（可能 migration 未执行或数据库不可达）');
    return null;
  }
}

/**
 * 验证请求中的设备是否已批准。
 * 使用缓存避免每次查库，TTL 5 分钟。
 */
async function verifyDeviceForPayload(req: IncomingMessage, payload: TokenPayload, ctx: GatewayContext): Promise<boolean> {
  const deviceId = payload.did ?? (req.headers['x-device-id'] as string | undefined) ?? (req.headers['x-memforge-device-id'] as string | undefined);
  if (!deviceId) return false;

  const deviceCacheKey = `device:${payload.sub}:${deviceId}`;
  const cachedStatus = await ctx.cache.get<string>(deviceCacheKey);
  if (cachedStatus === 'approved') return true;
  if (cachedStatus) return false;

  const approved = await ctx.deviceStore.isDeviceApproved(payload.sub, deviceId);
  await ctx.cache.set(deviceCacheKey, approved ? 'approved' : 'denied', 300);
  return approved;
}

/**
 * 从授权码内部状态查找 userId 并获取用户。
 */
async function findUserFromAuthCode(ctx: GatewayContext, code: string): Promise<import('./auth/types.js').AuthUser | null> {
  const userId = ctx.oauth.getUserIdFromCode(code);
  if (!userId) return null;
  return ctx.userStore.findById(userId);
}

const TOPOLOGY_PL_AWARE_TOOLS: Record<string, 'read' | 'write' | 'manage'> = {
  query_topology: 'read',
  get_topology_release_order: 'read',
  get_topology_change_impact: 'read',
  resolve_service_path: 'read',
  scan_topology: 'manage',
  import_topology: 'write',
};

async function checkTopologyProductLineAcl(
  ctx: GatewayContext,
  tokenPayload: TokenPayload,
  tool: string,
  body: Record<string, unknown>,
): Promise<string | null> {
  const plRequiredLevel = TOPOLOGY_PL_AWARE_TOOLS[tool];
  if (!plRequiredLevel) return null;

  const toolArgs = (body.params as Record<string, unknown>)?.arguments as Record<string, unknown> | undefined;
  const nestedArgs = toolArgs?.args as Record<string, unknown> | undefined;
  const productLine = (toolArgs?.product_line as string)
    ?? (nestedArgs?.product_line as string)
    ?? null;
  if (!productLine) return null;

  const plExists = await ctx.plAcl.isProductLineExists(productLine);
  if (!plExists && (tool === 'scan_topology' || tool === 'import_topology')) {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'lead')) {
      return `产品线「${productLine}」不存在，仅 lead/admin 角色可创建新产品线。请联系管理员。`;
    }
    return null;
  }

  if (plExists) {
    const plAllowed = await ctx.plAcl.checkAccess(tokenPayload.sub, productLine, plRequiredLevel);
    if (!plAllowed) {
      return `无权访问产品线「${productLine}」（需要 ${plRequiredLevel} 权限）`;
    }
  }

  return null;
}

function incomingMessageWithBody(req: IncomingMessage, body: string): IncomingMessage {
  const readable = Readable.from([Buffer.from(body, 'utf8')]) as IncomingMessage;
  readable.method = req.method;
  readable.url = req.url;
  readable.headers = req.headers;
  readable.rawHeaders = req.rawHeaders ?? [];
  readable.httpVersion = req.httpVersion ?? '1.1';
  readable.httpVersionMajor = req.httpVersionMajor ?? 1;
  readable.httpVersionMinor = req.httpVersionMinor ?? 1;
  return readable;
}

async function extractRefreshTokenUser(ctx: GatewayContext, token: string): Promise<string | null> {
  return ctx.oauth.getRefreshTokenUserId(token);
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', chunk => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}


async function handleKnowledgeProxy(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  ctx: GatewayContext,
): Promise<void> {
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'unauthorized', message: 'Knowledge API 需要认证' });
  }

  const targetUrl = `${ctx.config.knowledgeServiceUrl}${req.url}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-memforge-user-id': tokenPayload.sub,
    'x-memforge-org-id': tokenPayload.org,
    'x-memforge-user-role': tokenPayload.role,
  };
  if (tokenPayload.teamId) headers['x-memforge-team-id'] = tokenPayload.teamId;

  const internalSecret = process.env.MEMFORGE_INTERNAL_SECRET;
  if (internalSecret) {
    const { getInternalHeaders } = await import('@memforgeai/shared');
    Object.assign(headers, getInternalHeaders(internalSecret));
  }

  try {
    let body: string | undefined;
    if (req.method === 'POST' || req.method === 'PUT') {
      body = await readRawBody(req);
    }

    const resp = await fetch(targetUrl, {
      method: req.method ?? 'GET',
      headers,
      body,
    });

    const respBody = await resp.text();
    res.writeHead(resp.status, { 'Content-Type': 'application/json' });
    res.end(respBody);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Knowledge service unavailable' }));
  }
}

async function handleMemoryProxy(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  ctx: GatewayContext,
): Promise<void> {
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'unauthorized', message: 'Memory API 需要认证' });
  }

  const targetUrl = `${ctx.config.memoryServiceUrl}${req.url}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-memforge-user-id': tokenPayload.sub,
    'x-memforge-org-id': tokenPayload.org,
    'x-memforge-user-role': tokenPayload.role,
  };
  if (tokenPayload.teamId) headers['x-memforge-team-id'] = tokenPayload.teamId;

  const internalSecret = process.env.MEMFORGE_INTERNAL_SECRET;
  if (internalSecret) {
    const { getInternalHeaders } = await import('@memforgeai/shared');
    Object.assign(headers, getInternalHeaders(internalSecret));
  }

  try {
    let body: string | undefined;
    if (req.method === 'POST' || req.method === 'PUT') {
      body = await readRawBody(req);
    }

    const resp = await fetch(targetUrl, { method: req.method ?? 'GET', headers, body });
    const respBody = await resp.text();
    res.writeHead(resp.status, { 'Content-Type': 'application/json' });
    res.end(respBody);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Memory service unavailable' }));
  }
}

async function handleTopologyProxy(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
): Promise<void> {
  // 认证检查
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'unauthorized', message: '拓扑 API 需要认证' });
  }

  const urlPath = (req.url ?? '').replace('/api/topology/', '').split('?')[0];
  const pathParts = urlPath.split('/').filter(Boolean);

  // 产品线 ACL：从 URL 中提取 product_line 并检查权限
  // product-lines 列表端点不需要特定产品线权限（会在 memory-service 侧按权限过滤）
  if (pathParts.length >= 1 && pathParts[0] !== 'product-lines') {
    const productLine = pathParts[0];
    const method = req.method ?? 'GET';
    const isWrite = method === 'POST' || method === 'PUT' || method === 'DELETE';
    const requiredLevel = isWrite
      ? (method === 'DELETE' && pathParts.length === 1 ? 'manage' : 'write')
      : 'read';

    // admin/lead 角色隐式拥有所有产品线的读写权限，跳过 ACL 检查
    const isPrivilegedRole = ctx.rbac.hasRole(tokenPayload.role, 'lead');
    if (!isPrivilegedRole) {
      const allowed = await ctx.plAcl.checkAccess(
        tokenPayload.sub, productLine, requiredLevel as 'read' | 'write' | 'manage',
      );
      if (!allowed) {
        return sendJson(res, 403, { error: 'forbidden', message: `无权访问产品线: ${productLine}` });
      }
    }

    // 删除整个产品线（DELETE /:productLine）仅限 admin/lead
    if (method === 'DELETE' && pathParts.length === 1 && !isPrivilegedRole) {
      return sendJson(res, 403, {
        error: 'role_insufficient',
        message: '删除产品线仅允许管理员和 Leader 角色',
      });
    }
  }

  const targetUrl = `${ctx.config.memoryServiceUrl}${req.url}`;
  try {
    let body = '';
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = await readRawBody(req);
    }

    const deviceId = (req.headers['x-device-id'] as string) || '';
    const fetchOpts: RequestInit = {
      method: req.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-memforge-user-id': tokenPayload.sub,
        'x-memforge-org-id': tokenPayload.org,
        'x-memforge-team-id': tokenPayload.teamId ?? '',
        'x-memforge-user-role': tokenPayload.role,
        ...(deviceId ? { 'x-memforge-device-id': deviceId } : {}),
        ...(tokenPayload.isSuperAdmin ? { 'x-memforge-super-admin': 'true' } : {}),
      },
    };
    if (body.length > 0 && req.method !== 'GET') {
      fetchOpts.body = body;
    }
    const response = await fetch(targetUrl, fetchOpts);
    const text = await response.text();

    // product-lines 列表需要按用户权限过滤
    if (pathParts.length === 1 && pathParts[0] === 'product-lines' && response.ok) {
      try {
        const data = JSON.parse(text);
        const accessiblePLs = await ctx.plAcl.getAccessibleProductLineNames(tokenPayload.sub);
        data.productLines = (data.productLines as string[]).filter(
          (pl: string) => accessiblePLs.includes(pl),
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      } catch { /* 解析失败则返回原始响应 */ }
    }

    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(text);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    logger.error({ err: (err as Error).message, url: targetUrl }, '拓扑 API 代理失败');
    sendJson(res, 502, { error: 'proxy_error', message: '拓扑 API 代理失败' });
  }
}

async function handleDistinctProjectsProxy(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
): Promise<void> {
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'unauthorized', message: '此接口需要认证' });
  }
  const targetUrl = `${ctx.config.memoryServiceUrl}/api/memories/distinct-projects`;
  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-memforge-user-id': tokenPayload.sub,
        'x-memforge-org-id': tokenPayload.org,
        'x-memforge-team-id': tokenPayload.teamId ?? '',
        'x-memforge-user-role': tokenPayload.role,
      },
    });
    const text = await response.text();

    // 按用户可访问的产品线过滤
    try {
      const data = JSON.parse(text);
      if (data.projectIds && Array.isArray(data.projectIds)) {
        const accessiblePLs = await ctx.plAcl.getAccessibleProductLineNames(tokenPayload.sub);
        data.projectIds = (data.projectIds as string[]).filter(
          (pid: string) => accessiblePLs.includes(pid) || pid === '_global_',
        );
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(text);
    }
  } catch (err) {
    logger.error({ err: (err as Error).message, url: targetUrl }, '记忆辅助查询代理失败');
    sendJson(res, 502, { error: 'proxy_error', message: '记忆辅助查询代理失败' });
  }
}

// ═══════════════════════════════════════════════
//  用户管理 API
// ═══════════════════════════════════════════════

async function handleUserManagementApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
  url: URL,
): Promise<void> {
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  const method = req.method ?? 'GET';
  const path = url.pathname;

  const isSelfServicePath = path.startsWith('/api/users/me/');
  if (!isSelfServicePath && rejectIfApiKeyLimited(res, tokenPayload)) return;

  // PUT /api/users/me/profile — 修改自己的昵称
  if (path === '/api/users/me/profile' && method === 'PUT') {
    const body = await readJsonBody(req);
    const displayName = (body?.display_name as string ?? '').trim();
    if (!displayName || displayName.length > 50) {
      return sendJson(res, 400, { error: 'invalid_request', message: '昵称不能为空且不超过 50 字符' });
    }
    const ok = await ctx.userStore.updateDisplayName(tokenPayload.sub, displayName);
    if (!ok) {
      return sendJson(res, 404, { error: 'not_found', message: '用户不存在' });
    }
    return sendJson(res, 200, { success: true, display_name: displayName });
  }

  // PUT /api/users/me/password — 修改自己的密码（任何已登录用户）
  if (path === '/api/users/me/password' && method === 'PUT') {
    const body = await readJsonBody(req);
    const oldPassword = body?.old_password as string;
    const newPassword = body?.new_password as string;
    if (!oldPassword || !newPassword) {
      return sendJson(res, 400, { error: 'invalid_request', message: '需要 old_password 和 new_password' });
    }
    const pwCheck = validatePassword(newPassword);
    if (!pwCheck.valid) {
      return sendJson(res, 400, { error: 'invalid_request', message: pwCheck.message });
    }
    const ok = await ctx.userStore.changePassword(tokenPayload.sub, oldPassword, newPassword);
    if (!ok) {
      return sendJson(res, 401, { error: 'invalid_password', message: '旧密码错误' });
    }
    ctx.auditLogger.logAuthEvent({
      action: 'PASSWORD_CHANGED',
      userId: tokenPayload.sub,
      details: {},
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    return sendJson(res, 200, { success: true, message: '密码已修改' });
  }

  // PUT /api/users/:id/reset-password — admin 重置他人密码
  const resetPwMatch = path.match(/^\/api\/users\/([^/]+)\/reset-password$/);
  if (resetPwMatch && method === 'PUT') {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      return sendJson(res, 403, { error: 'forbidden', message: '仅管理员可重置密码' });
    }
    const body = await readJsonBody(req);
    const newPassword = body?.new_password as string;
    if (!newPassword) {
      return sendJson(res, 400, { error: 'invalid_request', message: '需要 new_password' });
    }
    const resetPwCheck = validatePassword(newPassword);
    if (!resetPwCheck.valid) {
      return sendJson(res, 400, { error: 'invalid_request', message: resetPwCheck.message });
    }
    const ok = await ctx.userStore.resetPassword(resetPwMatch[1], newPassword);
    if (!ok) {
      return sendJson(res, 404, { error: 'not_found', message: '用户不存在' });
    }
    ctx.auditLogger.logAuthEvent({
      action: 'PASSWORD_RESET',
      userId: tokenPayload.sub,
      details: { targetUserId: resetPwMatch[1] },
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    return sendJson(res, 200, { success: true, message: '密码已重置' });
  }

  // DELETE /api/users/:id/lock — admin 解除登录锁定
  const unlockMatch = path.match(/^\/api\/users\/([^/]+)\/lock$/);
  if (unlockMatch && method === 'DELETE') {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      return sendJson(res, 403, { error: 'forbidden', message: '仅管理员可解除锁定' });
    }
    const targetUser = await ctx.userStore.findById(unlockMatch[1]);
    if (!targetUser) {
      return sendJson(res, 404, { error: 'not_found', message: '用户不存在' });
    }
    const cleared = ctx.loginLock.clearLock(targetUser.externalId);
    ctx.auditLogger.logAuthEvent({
      action: 'ACCOUNT_UNLOCKED',
      userId: tokenPayload.sub,
      details: { targetUserId: unlockMatch[1], wasLocked: cleared },
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    return sendJson(res, 200, { success: true, was_locked: cleared, message: cleared ? '锁定已解除' : '账号未处于锁定状态' });
  }

  // GET /api/users — 列出所有用户（lead 和 admin 可用）
  if (path === '/api/users' && method === 'GET') {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'lead')) {
      return sendJson(res, 403, { error: 'forbidden', message: '需要 lead 或 admin 角色' });
    }
    const users = await ctx.userStore.listAll();
    // 附加产品线权限信息
    const usersWithPl = await Promise.all(users.map(async u => {
      const pls = await ctx.plAcl.getAccessibleProductLines(u.id);
      return { ...u, productLines: pls };
    }));
    return sendJson(res, 200, { users: usersWithPl });
  }

  // PUT /api/users/:id/role — 修改角色
  const roleMatch = path.match(/^\/api\/users\/([^/]+)\/role$/);
  if (roleMatch && method === 'PUT') {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const body = await readJsonBody(req);
    const role = body?.role as string;
    if (!role || !['viewer', 'developer', 'lead', 'admin'].includes(role)) {
      return sendJson(res, 400, { error: 'invalid_role', message: '角色必须为 viewer/developer/lead/admin' });
    }
    await ctx.userStore.updateRole(roleMatch[1], role as 'admin' | 'lead' | 'developer' | 'viewer');
    return sendJson(res, 200, { success: true });
  }

  // DELETE /api/users/:id — 停用用户
  const deactivateMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (deactivateMatch && method === 'DELETE') {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    if (deactivateMatch[1] === tokenPayload.sub) {
      return sendJson(res, 400, { error: 'invalid_request', message: '不能停用自己的账号' });
    }
    const done = await ctx.userStore.deactivate(deactivateMatch[1]);
    return sendJson(res, done ? 200 : 404, { success: done });
  }

  // GET /api/users/:id/product-lines — 查看用户产品线权限
  const plListMatch = path.match(/^\/api\/users\/([^/]+)\/product-lines$/);
  if (plListMatch && method === 'GET') {
    // 自己可以查看自己的，admin 可以查看任何人的
    if (plListMatch[1] !== tokenPayload.sub && !ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const pls = await ctx.plAcl.getAccessibleProductLines(plListMatch[1]);
    return sendJson(res, 200, { productLines: pls });
  }

  // POST /api/users/:id/product-lines — 授予产品线权限
  if (plListMatch && method === 'POST') {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const body = await readJsonBody(req);
    const productLine = body?.product_line as string;
    const accessLevel = (body?.access_level as string) ?? 'read';
    if (!productLine) {
      return sendJson(res, 400, { error: 'invalid_request', message: '缺少 product_line' });
    }
    if (!['read', 'write', 'manage'].includes(accessLevel)) {
      return sendJson(res, 400, { error: 'invalid_request', message: 'access_level 必须为 read/write/manage' });
    }
    await ctx.plAcl.grantAccess(
      plListMatch[1], productLine, accessLevel as 'read' | 'write' | 'manage', tokenPayload.sub,
    );
    return sendJson(res, 200, { success: true });
  }

  // DELETE /api/users/:id/product-lines/:pl — 撤销产品线权限
  const plRevokeMatch = path.match(/^\/api\/users\/([^/]+)\/product-lines\/(.+)$/);
  if (plRevokeMatch && method === 'DELETE') {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const done = await ctx.plAcl.revokeAccess(plRevokeMatch[1], plRevokeMatch[2]);
    return sendJson(res, done ? 200 : 404, { success: done });
  }

  sendJson(res, 404, { error: 'not_found' });
}

// ═══════════════════════════════════════════════
//  团队管理 API
// ═══════════════════════════════════════════════

async function handleTeamsApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
  url: URL,
): Promise<void> {
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) return sendJson(res, 401, { error: 'unauthorized' });

  const method = req.method ?? 'GET';
  const path = url.pathname;
  const pool = (await import('@memforgeai/shared')).getPool();

  // GET /api/teams — 列出团队
  // admin 看全部；未加入任何团队的用户也看全部（团队选择流程）；其余只看自己所在的团队
  if (path === '/api/teams' && method === 'GET') {
    const isAdmin = ctx.rbac.hasRole(tokenPayload.role, 'admin');
    let showAll = isAdmin;
    if (!showAll) {
      const { rows: myTeams } = await pool.query(
        `SELECT 1 FROM memory.team_members WHERE user_id = $1 LIMIT 1`,
        [tokenPayload.sub],
      );
      showAll = myTeams.length === 0;
    }
    const query = showAll
      ? `SELECT t.id, t.name, t.slug, t.description, t.created_at,
                (SELECT COUNT(*) FROM memory.team_members tm WHERE tm.team_id = t.id) AS member_count
         FROM memory.teams t WHERE t.org_id = $1 ORDER BY t.created_at`
      : `SELECT t.id, t.name, t.slug, t.description, t.created_at,
                (SELECT COUNT(*) FROM memory.team_members tm WHERE tm.team_id = t.id) AS member_count
         FROM memory.teams t
         WHERE t.org_id = $1
           AND t.id IN (SELECT team_id FROM memory.team_members WHERE user_id = $2)
         ORDER BY t.created_at`;
    const params = showAll ? [tokenPayload.org] : [tokenPayload.org, tokenPayload.sub];
    const { rows } = await pool.query(query, params);
    return sendJson(res, 200, rows);
  }

  // POST /api/teams — 创建团队（admin/lead）
  if (path === '/api/teams' && method === 'POST') {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'lead')) {
      return sendJson(res, 403, { error: 'forbidden', message: '仅 lead/admin 可创建团队' });
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readRawBody(req));
    } catch {
      return sendJson(res, 400, { error: 'invalid_json' });
    }
    const { name, slug, description } = body as { name?: string; slug?: string; description?: string };
    if (!name || !slug) return sendJson(res, 400, { error: 'name 和 slug 必填' });

    try {
      const { rows } = await pool.query(
        `INSERT INTO memory.teams (org_id, name, slug, description)
         VALUES ($1, $2, $3, $4) RETURNING id, name, slug, description, created_at`,
        [tokenPayload.org, name, slug, description ?? null],
      );
      return sendJson(res, 201, rows[0]);
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') return sendJson(res, 409, { error: 'slug 已存在' });
      throw err;
    }
  }

  // PUT /api/teams/:id — 编辑团队（admin 任意团队 / lead 所在团队 / 团队 owner/admin）
  const editTeamMatch = path.match(/^\/api\/teams\/([^/]+)$/);
  if (editTeamMatch && method === 'PUT') {
    const teamId = editTeamMatch[1];
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      const { rows: callerMembership } = await pool.query(
        `SELECT role FROM memory.team_members WHERE team_id = $1 AND user_id = $2`,
        [teamId, tokenPayload.sub],
      );
      if (!callerMembership.length) {
        return sendJson(res, 403, { error: 'forbidden', message: '你不是该团队成员' });
      }
      if (!ctx.rbac.hasRole(tokenPayload.role, 'lead') && !['owner', 'admin'].includes(callerMembership[0].role)) {
        return sendJson(res, 403, { error: 'forbidden', message: '需要团队 owner/admin 角色' });
      }
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readRawBody(req));
    } catch {
      return sendJson(res, 400, { error: 'invalid_json' });
    }
    const { name, description } = body as { name?: string; description?: string };
    if (!name) return sendJson(res, 400, { error: 'name 必填' });
    const { rows } = await pool.query(
      `UPDATE memory.teams SET name = $1, description = $2, updated_at = NOW()
       WHERE id = $3 RETURNING id, name, slug, description, created_at`,
      [name, description ?? null, teamId],
    );
    if (rows.length === 0) return sendJson(res, 404, { error: '团队不存在' });
    return sendJson(res, 200, rows[0]);
  }

  // GET /api/teams/:id/members — 查看团队成员
  const memberMatch = path.match(/^\/api\/teams\/([^/]+)\/members$/);
  if (memberMatch && method === 'GET') {
    const teamId = memberMatch[1];
    // lead/admin 可查看任意团队；其余用户须为该团队成员
    if (!ctx.rbac.hasRole(tokenPayload.role, 'lead')) {
      const { rows: callerMembership } = await pool.query(
        `SELECT 1 FROM memory.team_members WHERE team_id = $1 AND user_id = $2`,
        [teamId, tokenPayload.sub],
      );
      if (!callerMembership.length) {
        return sendJson(res, 403, { error: 'forbidden', message: '你不是该团队成员' });
      }
    }
    const { rows } = await pool.query(
      `SELECT tm.user_id, tm.role, tm.is_primary, tm.joined_at,
              u.external_id, u.display_name, u.email
       FROM memory.team_members tm
       JOIN memory.users u ON tm.user_id = u.id
       WHERE tm.team_id = $1
       ORDER BY tm.role DESC, tm.joined_at`,
      [teamId],
    );
    return sendJson(res, 200, rows);
  }

  // POST /api/teams/:id/members — 添加成员（admin 任意团队 / lead 所在团队 / 团队 owner/admin）
  if (memberMatch && method === 'POST') {
    const teamId = memberMatch[1];
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      const { rows: callerMembership } = await pool.query(
        `SELECT role FROM memory.team_members WHERE team_id = $1 AND user_id = $2`,
        [teamId, tokenPayload.sub],
      );
      if (!callerMembership.length) {
        return sendJson(res, 403, { error: 'forbidden', message: '你不是该团队成员' });
      }
      if (!ctx.rbac.hasRole(tokenPayload.role, 'lead') && !['owner', 'admin'].includes(callerMembership[0].role)) {
        return sendJson(res, 403, { error: 'forbidden', message: '需要团队 owner/admin 角色' });
      }
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readRawBody(req));
    } catch {
      return sendJson(res, 400, { error: 'invalid_json' });
    }
    const { userId, role: memberRole, isPrimary } = body as {
      userId?: string;
      role?: string;
      isPrimary?: boolean;
    };
    if (!userId) return sendJson(res, 400, { error: 'userId 必填' });
    const allowedMemberRoles = ['owner', 'admin', 'member', 'viewer'] as const;
    const resolvedRole = memberRole ?? 'member';
    if (!allowedMemberRoles.includes(resolvedRole as typeof allowedMemberRoles[number])) {
      return sendJson(res, 400, { error: 'invalid_role', message: 'role 必须为 owner/admin/member/viewer 之一' });
    }

    try {
      await pool.query(
        `INSERT INTO memory.team_members (team_id, user_id, role, is_primary)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id, user_id) DO UPDATE SET role = $3, is_primary = $4`,
        [teamId, userId, resolvedRole, isPrimary ?? false],
      );
      return sendJson(res, 200, { success: true });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23503') return sendJson(res, 404, { error: '用户或团队不存在' });
      throw err;
    }
  }

  // DELETE /api/teams/:id/members/:userId — 移除成员（admin 任意团队 / lead 所在团队 / 团队 owner/admin）
  const removeMemberMatch = path.match(/^\/api\/teams\/([^/]+)\/members\/([^/]+)$/);
  if (removeMemberMatch && method === 'DELETE') {
    const [, teamId, userId] = removeMemberMatch;
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      const { rows: callerMembership } = await pool.query(
        `SELECT role FROM memory.team_members WHERE team_id = $1 AND user_id = $2`,
        [teamId, tokenPayload.sub],
      );
      if (!callerMembership.length) {
        return sendJson(res, 403, { error: 'forbidden', message: '你不是该团队成员' });
      }
      if (!ctx.rbac.hasRole(tokenPayload.role, 'lead') && !['owner', 'admin'].includes(callerMembership[0].role)) {
        return sendJson(res, 403, { error: 'forbidden', message: '需要团队 owner/admin 角色' });
      }
    }
    await pool.query(
      `DELETE FROM memory.team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId],
    );
    return sendJson(res, 200, { success: true });
  }

  // POST /api/teams/:id/join-requests — 申请加入团队
  const joinReqMatch = path.match(/^\/api\/teams\/([^/]+)\/join-requests$/);
  if (joinReqMatch && method === 'POST') {
    const teamId = joinReqMatch[1];
    const body = JSON.parse(await readRawBody(req));
    const message = body.message ?? null;

    // 检查用户是否已是成员
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM memory.team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, tokenPayload.sub],
    );
    if (existing.length > 0) {
      return sendJson(res, 409, { error: 'already_member', message: '你已经是该团队的成员' });
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO memory.team_join_requests (team_id, user_id, message)
         VALUES ($1, $2, $3)
         RETURNING id, team_id, user_id, status, message, created_at`,
        [teamId, tokenPayload.sub, message],
      );
      return sendJson(res, 201, rows[0]);
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        return sendJson(res, 409, { error: 'duplicate_request', message: '你已有一个待审批的申请' });
      }
      if (pgErr.code === '23503') {
        return sendJson(res, 404, { error: '团队不存在' });
      }
      throw err;
    }
  }

  // GET /api/teams/:id/join-requests — 查看待审批列表（admin 任意团队 / lead 所在团队 / 团队 owner/admin）
  if (joinReqMatch && method === 'GET') {
    const teamId = joinReqMatch[1];
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      const { rows: callerMembership } = await pool.query(
        `SELECT role FROM memory.team_members WHERE team_id = $1 AND user_id = $2`,
        [teamId, tokenPayload.sub],
      );
      if (!callerMembership.length) {
        return sendJson(res, 403, { error: 'forbidden', message: '你不是该团队成员' });
      }
      if (!ctx.rbac.hasRole(tokenPayload.role, 'lead') && !['owner', 'admin'].includes(callerMembership[0].role)) {
        return sendJson(res, 403, { error: 'forbidden', message: '需要团队 owner/admin 角色' });
      }
    }
    const statusFilter = url.searchParams.get('status') ?? 'pending';
    const { rows } = await pool.query(
      `SELECT jr.id, jr.team_id, jr.user_id, jr.status, jr.message, jr.created_at,
              jr.reviewed_by, jr.reviewed_at,
              u.external_id, u.display_name, u.email
       FROM memory.team_join_requests jr
       JOIN memory.users u ON jr.user_id = u.id
       WHERE jr.team_id = $1 AND jr.status = $2
       ORDER BY jr.created_at DESC`,
      [teamId, statusFilter],
    );
    return sendJson(res, 200, rows);
  }

  // PUT /api/teams/join-requests/:id/approve — 批准申请
  const approveMatch = path.match(/^\/api\/teams\/join-requests\/([^/]+)\/(approve|reject)$/);
  if (approveMatch && method === 'PUT') {
    const [, requestId, action] = approveMatch;

    const { rows: reqRows } = await pool.query(
      `SELECT jr.id, jr.team_id, jr.user_id, jr.status, t.org_id
       FROM memory.team_join_requests jr
       JOIN memory.teams t ON jr.team_id = t.id
       WHERE jr.id = $1`,
      [requestId],
    );
    if (reqRows.length === 0) return sendJson(res, 404, { error: '申请不存在' });
    const joinReq = reqRows[0];
    if (joinReq.status !== 'pending') {
      return sendJson(res, 409, { error: 'already_processed', message: '该申请已被处理' });
    }

    // 权限检查：admin 任意团队 / lead 所在团队 / 团队 owner/admin
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      const { rows: callerMembership } = await pool.query(
        `SELECT role FROM memory.team_members WHERE team_id = $1 AND user_id = $2`,
        [joinReq.team_id, tokenPayload.sub],
      );
      if (!callerMembership.length) {
        return sendJson(res, 403, { error: 'forbidden', message: '你不是该团队成员' });
      }
      if (!ctx.rbac.hasRole(tokenPayload.role, 'lead') && !['owner', 'admin'].includes(callerMembership[0].role)) {
        return sendJson(res, 403, { error: 'forbidden', message: '需要团队 owner/admin 角色' });
      }
    }

    if (action === 'approve') {
      // 检查用户是否已有主团队
      const { rows: existingPrimary } = await pool.query(
        `SELECT 1 FROM memory.team_members WHERE user_id = $1 AND is_primary = TRUE LIMIT 1`,
        [joinReq.user_id],
      );
      const isPrimary = existingPrimary.length === 0;

      await pool.query(
        `INSERT INTO memory.team_members (team_id, user_id, role, is_primary)
         VALUES ($1, $2, 'member', $3)
         ON CONFLICT (team_id, user_id) DO NOTHING`,
        [joinReq.team_id, joinReq.user_id, isPrimary],
      );
      await pool.query(
        `UPDATE memory.team_join_requests SET status = 'approved', reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
        [tokenPayload.sub, requestId],
      );

      // 自动同步团队关联的产品线到新成员的 user_product_lines
      try {
        await pool.query(
          `INSERT INTO memory.user_product_lines (user_id, product_line, access_level, granted_by)
           SELECT $1, tpl.product_line, 'read', $2
           FROM memory.team_product_lines tpl
           WHERE tpl.team_id = $3
           ON CONFLICT (user_id, product_line) DO NOTHING`,
          [joinReq.user_id, tokenPayload.sub, joinReq.team_id],
        );
      } catch (plErr) {
        logger.warn({ err: (plErr as Error).message }, '同步团队产品线到用户失败（非阻塞）');
      }

      logger.info({ requestId, userId: joinReq.user_id, teamId: joinReq.team_id }, '团队加入申请已批准');
      return sendJson(res, 200, { success: true, action: 'approved' });
    } else {
      await pool.query(
        `UPDATE memory.team_join_requests SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
        [tokenPayload.sub, requestId],
      );
      logger.info({ requestId, userId: joinReq.user_id }, '团队加入申请已拒绝');
      return sendJson(res, 200, { success: true, action: 'rejected' });
    }
  }

  // GET /api/teams/my-requests — 用户自己的申请列表
  if (path === '/api/teams/my-requests' && method === 'GET') {
    const { rows } = await pool.query(
      `SELECT jr.id, jr.team_id, jr.status, jr.message, jr.created_at, jr.reviewed_at,
              t.name AS team_name, t.slug AS team_slug
       FROM memory.team_join_requests jr
       JOIN memory.teams t ON jr.team_id = t.id
       WHERE jr.user_id = $1
       ORDER BY jr.created_at DESC`,
      [tokenPayload.sub],
    );
    return sendJson(res, 200, rows);
  }

  // PUT /api/memories/:id/visibility — 修改记忆可见性
  const visMatch = path.match(/^\/api\/memories\/([^/]+)\/visibility$/);
  if (visMatch && method === 'PUT') {
    const entryId = visMatch[1];
    const body = JSON.parse(await readRawBody(req));
    const { visibility } = body;
    if (!['personal', 'team', 'product_line', 'global'].includes(visibility)) {
      return sendJson(res, 400, { error: 'visibility 必须是 personal/team/product_line/global' });
    }

    // 仅创建者或 admin 可修改
    const { rows: entryRows } = await pool.query(
      `SELECT created_by, org_id FROM memory.entries WHERE id = $1`, [entryId],
    );
    if (entryRows.length === 0) return sendJson(res, 404, { error: '记忆不存在' });
    const entry = entryRows[0];
    if (entry.created_by !== tokenPayload.sub && !ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      return sendJson(res, 403, { error: '仅创建者或 admin 可修改可见性' });
    }

    const teamId = visibility === 'team' ? (tokenPayload.teamId ?? null) : null;
    await pool.query(
      `UPDATE memory.entries SET visibility = $1, team_id = $2, updated_at = NOW() WHERE id = $3`,
      [visibility, teamId, entryId],
    );
    return sendJson(res, 200, { success: true, visibility });
  }

  // ─── 团队产品线关联管理 ────────────────────
  const teamPlMatch = path.match(/^\/api\/teams\/([^/]+)\/product-lines(?:\/([^/]+))?$/);
  if (teamPlMatch) {
    const teamId = teamPlMatch[1];
    const plSlug = teamPlMatch[2] ?? null;

    // 权限检查：admin 任意团队 / lead 所在团队 / 团队 owner/admin
    async function checkTeamAdmin(): Promise<boolean> {
      if (ctx.rbac.hasRole(tokenPayload!.role, 'admin')) return true;
      const { rows } = await pool.query(
        `SELECT role FROM memory.team_members WHERE team_id = $1 AND user_id = $2`,
        [teamId, tokenPayload!.sub],
      );
      if (!rows.length) return false;
      if (ctx.rbac.hasRole(tokenPayload!.role, 'lead')) return true;
      return ['owner', 'admin'].includes(rows[0].role);
    }

    // GET /api/teams/:id/product-lines — 列出团队关联的产品线
    if (method === 'GET' && !plSlug) {
      const { rows } = await pool.query(
        `SELECT tpl.id, tpl.product_line, tpl.access_level, tpl.created_at
         FROM memory.team_product_lines tpl
         WHERE tpl.team_id = $1
         ORDER BY tpl.product_line`,
        [teamId],
      );
      return sendJson(res, 200, rows);
    }

    // POST /api/teams/:id/product-lines — 关联产品线
    if (method === 'POST' && !plSlug) {
      if (!await checkTeamAdmin()) {
        return sendJson(res, 403, { error: 'forbidden', message: '仅系统 admin 或团队 owner/admin 可管理产品线关联' });
      }
      const body = JSON.parse(await readRawBody(req));
      const { product_line, access_level } = body;
      if (!product_line) return sendJson(res, 400, { error: 'product_line 必填' });
      if (access_level && !['read', 'write', 'manage'].includes(access_level)) {
        return sendJson(res, 400, { error: 'access_level 必须是 read/write/manage' });
      }
      try {
        const { rows } = await pool.query(
          `INSERT INTO memory.team_product_lines (team_id, product_line, access_level)
           VALUES ($1, $2, $3)
           RETURNING id, team_id, product_line, access_level, created_at`,
          [teamId, product_line.toLowerCase(), access_level ?? 'read'],
        );
        return sendJson(res, 201, rows[0]);
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505') return sendJson(res, 409, { error: '该产品线已关联' });
        if (pgErr.code === '23503') return sendJson(res, 404, { error: '团队不存在' });
        throw err;
      }
    }

    // PUT /api/teams/:id/product-lines/:pl — 修改权限级别
    if (method === 'PUT' && plSlug) {
      if (!await checkTeamAdmin()) {
        return sendJson(res, 403, { error: 'forbidden', message: '仅系统 admin 或团队 owner/admin 可管理产品线关联' });
      }
      const body = JSON.parse(await readRawBody(req));
      const { access_level } = body;
      if (!access_level || !['read', 'write', 'manage'].includes(access_level)) {
        return sendJson(res, 400, { error: 'access_level 必须是 read/write/manage' });
      }
      const { rowCount } = await pool.query(
        `UPDATE memory.team_product_lines SET access_level = $1
         WHERE team_id = $2 AND product_line = $3`,
        [access_level, teamId, plSlug.toLowerCase()],
      );
      if (rowCount === 0) return sendJson(res, 404, { error: '未找到该关联' });
      return sendJson(res, 200, { success: true });
    }

    // DELETE /api/teams/:id/product-lines/:pl — 取消关联
    if (method === 'DELETE' && plSlug) {
      if (!await checkTeamAdmin()) {
        return sendJson(res, 403, { error: 'forbidden', message: '仅系统 admin 或团队 owner/admin 可管理产品线关联' });
      }
      const { rowCount } = await pool.query(
        `DELETE FROM memory.team_product_lines WHERE team_id = $1 AND product_line = $2`,
        [teamId, plSlug.toLowerCase()],
      );
      if (rowCount === 0) return sendJson(res, 404, { error: '未找到该关联' });
      return sendJson(res, 200, { success: true });
    }
  }

  sendJson(res, 404, { error: 'not_found' });
}

// ═══════════════════════════════════════════════
//  产品线 API
// ═══════════════════════════════════════════════

async function handleProductLineApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
  url: URL,
): Promise<void> {
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  const method = req.method ?? 'GET';
  const path = url.pathname;

  // GET /api/product-lines — 列出当前用户可访问的产品线
  // 加 ?all=true 时返回组织内所有产品线（admin/lead 限定，用于团队管理选择器）
  if (path === '/api/product-lines' && method === 'GET') {
    const allFlag = url.searchParams.get('all');
    if (allFlag === 'true' && ctx.rbac.hasRole(tokenPayload.role, 'lead')) {
      const pool = (await import('@memforgeai/shared')).getPool();
      const { rows } = await pool.query(
        `SELECT DISTINCT product_line FROM memory.topology_nodes
         WHERE product_line != '_default_' ORDER BY product_line`,
      );
      return sendJson(res, 200, { productLines: rows.map(r => r.product_line) });
    }
    const pls = await ctx.plAcl.getAccessibleProductLines(tokenPayload.sub);
    return sendJson(res, 200, { productLines: pls });
  }

  // GET /api/product-lines/:pl/members — 列出产品线成员
  const membersMatch = path.match(/^\/api\/product-lines\/([^/]+)\/members$/);
  if (membersMatch && method === 'GET') {
    const pl = membersMatch[1];
    const hasAccess = await ctx.plAcl.checkAccess(tokenPayload.sub, pl, 'read');
    if (!hasAccess) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const members = await ctx.plAcl.getProductLineMembers(pl);
    return sendJson(res, 200, { members });
  }

  sendJson(res, 404, { error: 'not_found' });
}

// ═══════════════════════════════════════════════
//  API Key 管理
// ═══════════════════════════════════════════════

async function handleApiKeyApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
  url: URL,
): Promise<void> {
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  if (rejectIfApiKeyLimited(res, tokenPayload)) return;

  const method = req.method ?? 'GET';
  const path = url.pathname;

  // GET /api/api-keys — 列出我的 API Key
  if (path === '/api/api-keys' && method === 'GET') {
    const keys = await ctx.apiKeyStore.listByUser(tokenPayload.sub);
    return sendJson(res, 200, { keys });
  }

  // POST /api/api-keys — 生成新的 API Key
  if (path === '/api/api-keys' && method === 'POST') {
    const body = await readJsonBody(req);
    const rawName = (body?.name as string) ?? 'default';
    const name = rawName.slice(0, 100).trim() || 'default';
    const expiresInDays = body?.expires_in_days as number | undefined;
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86400000)
      : undefined;

    try {
      const scope = parseApiKeyScope(body?.scope);
      const { key, record } = await ctx.apiKeyStore.generate(tokenPayload.sub, name, expiresAt, scope);

      ctx.auditLogger.logAuthEvent({
        action: 'API_KEY_CREATED',
        userId: tokenPayload.sub,
        details: { keyName: name, keyPrefix: record.keyPrefix, scope },
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });

      return sendJson(res, 201, {
        key,
        record,
        message: '请立即保存此 API Key，关闭后将无法再次查看完整密钥。',
      });
    } catch (err) {
      return sendJson(res, 400, {
        error: 'invalid_scope',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // DELETE /api/api-keys/:id — 撤销 API Key
  const revokeMatch = path.match(/^\/api\/api-keys\/([^/]+)$/);
  if (revokeMatch && method === 'DELETE') {
    const keyId = revokeMatch[1];
    const done = await ctx.apiKeyStore.revoke(keyId, tokenPayload.sub);
    if (!done) {
      return sendJson(res, 404, { error: 'not_found', message: 'API Key 不存在或已撤销' });
    }

    ctx.auditLogger.logAuthEvent({
      action: 'API_KEY_REVOKED',
      userId: tokenPayload.sub,
      details: { keyId },
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    return sendJson(res, 200, { success: true });
  }

  sendJson(res, 404, { error: 'not_found' });
}

// ═══════════════════════════════════════════════
//  MCP 客户端 + 远程扫描 API
// ═══════════════════════════════════════════════

async function handleMcpClients(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
): Promise<void> {
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  const clients = ctx.mcpClients.getOnlineClients();

  // 非管理员只能看到自己的客户端
  const visible = ctx.rbac.hasRole(tokenPayload.role, 'admin')
    ? clients
    : clients.filter(c => c.userId === tokenPayload.sub);

  sendJson(res, 200, { clients: visible });
}

async function handleRemoteScan(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
): Promise<void> {
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  const body = await readJsonBody(req);
  if (!body) {
    return sendJson(res, 400, { error: 'invalid_request', message: '请求体必须为 JSON' });
  }

  const targetUserId = (body.user_id as string) ?? tokenPayload.sub;
  const productLine = body.product_line as string;

  if (!productLine) {
    return sendJson(res, 400, { error: 'invalid_request', message: '缺少 product_line' });
  }

  // 只有管理员可以触发他人的扫描，普通用户只能触发自己的
  if (targetUserId !== tokenPayload.sub && !ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
    return sendJson(res, 403, { error: 'forbidden', message: '无权触发他人的远程扫描' });
  }

  // 产品线 ACL（admin/lead 隐式有权，跳过检查）
  const isPrivilegedRole = ctx.rbac.hasRole(tokenPayload.role, 'lead');
  if (!isPrivilegedRole) {
    const plAllowed = await ctx.plAcl.checkAccess(tokenPayload.sub, productLine, 'write');
    if (!plAllowed) {
      return sendJson(res, 403, { error: 'forbidden', message: `无权访问产品线: ${productLine}` });
    }
  }

  if (!ctx.mcpClients.isClientOnline(targetUserId)) {
    return sendJson(res, 409, { error: 'client_offline', message: 'MCP 客户端未连接，请确认 Cursor 已启动并配置了 MEMFORGE_GATEWAY_URL' });
  }

  const useForce = body.force === true && isPrivilegedRole;
  const scanParams: Record<string, unknown> = { product_line: productLine, force: useForce };

  let scanRoots = body.scan_roots as string[] | undefined;
  let gitPatterns = body.git_patterns as string[] | undefined;

  if (!scanRoots?.length || !gitPatterns?.length) {
    try {
      const settingsResp = await fetch(`${ctx.config.memoryServiceUrl}/api/topology/${productLine}/settings`, {
        headers: { 'x-memforge-user-id': tokenPayload.sub, 'x-memforge-org-id': tokenPayload.org },
      });
      if (settingsResp.ok) {
        const { settings } = await settingsResp.json() as { settings: Record<string, unknown> };
        if (!scanRoots?.length && Array.isArray(settings.scan_roots)) scanRoots = settings.scan_roots as string[];
        if (!gitPatterns?.length && Array.isArray(settings.git_patterns)) gitPatterns = settings.git_patterns as string[];
      }
    } catch { /* 读取失败时继续，用请求体中的值 */ }
  }

  if (scanRoots?.length) scanParams.scan_roots = scanRoots;
  if (gitPatterns?.length) scanParams.git_patterns = gitPatterns;

  try {
    const result = await ctx.mcpClients.triggerRemoteScan(targetUserId, productLine, scanParams);

    ctx.auditLogger.logToolCall({
      orgId: tokenPayload.org,
      userId: tokenPayload.sub,
      tool: 'remote_scan_topology',
      args: { productLine, targetUserId },
      success: true,
      durationMs: 0,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    sendJson(res, 200, { success: true, data: result });
  } catch (err) {
    sendJson(res, 500, { error: 'scan_failed', message: (err as Error).message });
  }
}

async function handleSseTicket(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
): Promise<void> {
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  const ticket = randomUUID();
  sseTickets.set(ticket, { userId: tokenPayload.sub, expiresAt: Date.now() + 30_000 });
  sendJson(res, 200, { ticket });
}

async function handleScanProgressSSE(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
): Promise<void> {
  const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const ticket = reqUrl.searchParams.get('ticket');
  let tokenPayload: TokenPayload | null = null;
  if (ticket) {
    const entry = sseTickets.get(ticket);
    if (!entry || entry.expiresAt < Date.now()) {
      return sendJson(res, 401, { error: 'invalid_ticket' });
    }
    sseTickets.delete(ticket);
    const user = await ctx.userStore.findFullById(entry.userId);
    if (!user) {
      return sendJson(res, 401, { error: 'invalid_ticket' });
    }
    tokenPayload = {
      sub: user.id,
      org: user.orgId,
      role: user.role,
      isSuperAdmin: user.isSuperAdmin,
    };
  }
  if (!tokenPayload) {
    tokenPayload = await authenticateRequest(req, ctx);
  }
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  const urlPath = (req.url ?? '').split('?')[0];
  const targetUserId = urlPath.replace('/api/topology/scan-progress/', '');

  if (targetUserId !== tokenPayload.sub && !ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  // SSE 响应
  setCorsHeaders(res, ctx.config, req);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('data: {"type":"connected"}\n\n');

  const unsubscribe = ctx.mcpClients.subscribeScanProgress(targetUserId, (progress) => {
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
  });

  req.on('close', () => {
    unsubscribe();
  });
}

// ═══════════════════════════════════════════════
//  设备管理 API
// ═══════════════════════════════════════════════

async function handleDeviceApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
  url: URL,
): Promise<void> {
  const tokenPayload = await authenticateRequest(req, ctx);
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  if (rejectIfApiKeyLimited(res, tokenPayload)) return;

  const method = req.method ?? 'GET';
  const path = url.pathname;

  // GET /api/devices — 列出所有设备（admin 专用，支持 status 过滤）
  if (path === '/api/devices' && method === 'GET') {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      return sendJson(res, 403, { error: 'forbidden', message: '仅管理员可查看设备列表' });
    }
    const statusFilter = url.searchParams.get('status') as 'pending' | 'approved' | 'revoked' | null;
    const devices = await ctx.deviceStore.listAll(statusFilter ?? undefined);
    const pendingCount = await ctx.deviceStore.getPendingCount();
    return sendJson(res, 200, { devices, pending_count: pendingCount });
  }

  // GET /api/devices/pending — 待审批设备列表（admin 专用）
  if (path === '/api/devices/pending' && method === 'GET') {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const devices = await ctx.deviceStore.listAll('pending');
    return sendJson(res, 200, { devices });
  }

  // GET /api/devices/pending-count — 待审批数量（admin 专用，轻量级轮询）
  if (path === '/api/devices/pending-count' && method === 'GET') {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const count = await ctx.deviceStore.getPendingCount();
    return sendJson(res, 200, { count });
  }

  // GET /api/devices/status — 查询设备验证是否启用
  if (path === '/api/devices/status' && method === 'GET') {
    return sendJson(res, 200, { enabled: ctx.config.deviceVerification });
  }

  // PUT /api/devices/:id/approve — 批准设备
  const approveMatch = path.match(/^\/api\/devices\/([^/]+)\/approve$/);
  if (approveMatch && method === 'PUT') {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const done = await ctx.deviceStore.approve(approveMatch[1], tokenPayload.sub);
    if (!done) {
      return sendJson(res, 404, { error: 'not_found', message: '设备不存在或状态不是 pending' });
    }
    // 清除该设备的缓存，使其立即生效
    await invalidateDeviceCache(ctx, approveMatch[1]);
    ctx.auditLogger.logAuthEvent({
      action: 'DEVICE_APPROVED',
      userId: tokenPayload.sub,
      details: { deviceId: approveMatch[1] },
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    return sendJson(res, 200, { success: true });
  }

  // PUT /api/devices/:id/revoke — 吊销设备
  const revokeMatch = path.match(/^\/api\/devices\/([^/]+)\/revoke$/);
  if (revokeMatch && method === 'PUT') {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const done = await ctx.deviceStore.revoke(revokeMatch[1]);
    if (!done) {
      return sendJson(res, 404, { error: 'not_found', message: '设备不存在或状态不是 approved' });
    }
    await invalidateDeviceCache(ctx, revokeMatch[1]);
    ctx.auditLogger.logAuthEvent({
      action: 'DEVICE_REVOKED',
      userId: tokenPayload.sub,
      details: { deviceId: revokeMatch[1] },
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    return sendJson(res, 200, { success: true });
  }

  // DELETE /api/devices/:id — 删除设备
  const deleteMatch = path.match(/^\/api\/devices\/([^/]+)$/);
  if (deleteMatch && method === 'DELETE') {
    if (!ctx.rbac.hasRole(tokenPayload.role, 'admin')) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const done = await ctx.deviceStore.remove(deleteMatch[1]);
    if (!done) {
      return sendJson(res, 404, { error: 'not_found' });
    }
    return sendJson(res, 200, { success: true });
  }

  // GET /api/devices/my — 当前用户的设备列表
  if (path === '/api/devices/my' && method === 'GET') {
    const devices = await ctx.deviceStore.listByUser(tokenPayload.sub);
    return sendJson(res, 200, { devices });
  }

  sendJson(res, 404, { error: 'not_found' });
}

async function invalidateDeviceCache(ctx: GatewayContext, deviceRecordId: string): Promise<void> {
  try {
    const { query: dbQuery } = await import('@memforgeai/shared');
    const result = await dbQuery<{ user_id: string; device_id: string }>(
      `SELECT user_id, device_id FROM memory.trusted_devices WHERE id = $1`,
      [deviceRecordId],
    );
    if (result.rows[0]) {
      const { user_id, device_id } = result.rows[0];
      await ctx.cache.del(`device:${user_id}:${device_id}`);
    }
  } catch {
    // 缓存清除失败不影响主流程，最多等 5 分钟过期
  }
}

function parseDeviceName(ua?: string): string {
  if (!ua) return '未知设备';
  const detectedIde = detectIdeFromUA(ua);
  if (detectedIde !== 'unknown') {
    const ideConfig = getIdeConfig(detectedIde);
    return `${ideConfig.displayName} IDE`;
  }
  if (ua.includes('VS Code') || ua.includes('vscode')) return 'VS Code';
  if (ua.includes('Claude')) return 'Claude Code';
  const match = ua.match(/(Chrome|Firefox|Safari|Edge|Opera|Brave)\/[\d.]+/);
  if (match) return match[1] + ' 浏览器';
  return '未知设备';
}

// ═══════════════════════════════════════════════
//  辅助函数
// ═══════════════════════════════════════════════

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readRawBody(req);
    return JSON.parse(raw);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function setCorsHeaders(res: ServerResponse, config: GatewayConfig, req: IncomingMessage): void {
  const reqOrigin = req.headers.origin;
  if (reqOrigin && config.corsOrigins.includes(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id, X-Memforge-Device-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const TRUSTED_PROXIES = new Set(
  (process.env.TRUSTED_PROXIES ?? '127.0.0.1,::1,::ffff:127.0.0.1').split(',').map(s => s.trim()).filter(Boolean)
);

function getClientIp(req: IncomingMessage): string | null {
  const remoteAddr = req.socket.remoteAddress ?? null;
  if (remoteAddr && TRUSTED_PROXIES.has(remoteAddr)) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  }
  return remoteAddr;
}

// ═══════════════════════════════════════════════
//  Setup API — 客户端自动配置
// ═══════════════════════════════════════════════

const __gatewayFilename = fileURLToPath(import.meta.url);
const __gatewayDirname = dirname(__gatewayFilename);

function findRulesTemplatesDir(): string | null {
  // gateway/src/server.ts → ../../memory-service/src/rules-templates
  const candidates = [
    join(__gatewayDirname, '..', '..', 'memory-service', 'src', 'rules-templates'),
    join(__gatewayDirname, '..', '..', 'memory-service', 'dist', 'rules-templates'),
    // 部署环境: /deploy-dir/packages/gateway/dist → /deploy-dir/packages/memory-service/src/rules-templates
    join(__gatewayDirname, '..', '..', '..', 'packages', 'memory-service', 'src', 'rules-templates'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

function getSetupIde(req: IncomingMessage, fallback: IdeType = 'cursor'): IdeType {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const ideParam = url.searchParams.get('ide')?.toLowerCase();
  if (ideParam && isValidIdeType(ideParam) && ideParam !== 'unknown') return ideParam;

  const uaIde = detectIdeFromUA(String(req.headers['user-agent'] ?? ''));
  if (uaIde !== 'unknown') return uaIde;

  return fallback;
}

function readMdcRuleTemplates(templatesDir: string) {
  const mdcAdapter = createRulesAdapter('mdc');
  return readdirSync(templatesDir)
    .filter(f => f.endsWith('.mdc'))
    .map(filename => {
      const content = readFileSync(join(templatesDir, filename), 'utf-8');
      return mdcAdapter.parseRule(content, filename);
    });
}

// ═══════════════════════════════════════════════
//  Git Hook 端点
// ═══════════════════════════════════════════════

async function handleHooksApi(req: IncomingMessage, res: ServerResponse, url: URL, ctx: GatewayContext): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // GitLab Webhook 使用独立认证（X-Gitlab-Token），跳过 hook token 流程
  if (path === '/api/hooks/gitlab-webhook' && method === 'POST') {
    const body = await readJsonBody(req);
    if (!body) {
      return sendJson(res, 400, { error: 'invalid_request', message: '请求体必须为 JSON' });
    }
    const { handleGitLabWebhook } = await import('./hooks/gitlab-webhook-handler.js');
    return handleGitLabWebhook(
      req, sendJson, res,
      body as unknown as import('./hooks/gitlab-webhook-handler.js').GitLabWebhookPayload,
      ctx.config.memoryServiceUrl,
    );
  }

  // 认证：优先 Authorization: Bearer（API_KEY），降级到 X-Hook-Token
  const authHeader = req.headers['authorization'] as string | undefined;
  const hookToken = req.headers['x-hook-token'] as string | undefined;
  let authenticatedViaApiKey = false;
  let tokenProductLine: string | null = null;
  let tokenUserId: string | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    const apiKey = authHeader.slice(7);
    try {
      const verified = await ctx.apiKeyStore.verify(apiKey);
      if (verified) {
        const user = await ctx.userStore.findFullById(verified.userId);
        // Hook 端点不接受 readwrite API Key，仅 admin 账号或专用 Hook Token
        if (user && (user.role === 'admin' || user.isSuperAdmin)) {
          authenticatedViaApiKey = true;
          tokenUserId = verified.userId;
        }
      }
    } catch {
      // ApiKeyStore 查询失败 — 回退到 hookToken 认证
    }
  }

  if (!authenticatedViaApiKey) {
    if (!hookToken || hookToken.length < 32) {
      return sendJson(res, 401, { error: 'unauthorized', message: '缺少有效的认证凭据（Authorization: Bearer 或 X-Hook-Token）' });
    }
  }
  if (!authenticatedViaApiKey && hookToken) {
    try {
      const pool = getPool();
      const { hashHookToken } = await import('./hooks/token-api.js');

      const activeCount = await pool.query<{ cnt: number }>(
        `SELECT count(*)::int as cnt FROM memory.hook_tokens WHERE is_active = TRUE`,
      );
      if ((activeCount.rows[0]?.cnt ?? 0) === 0) {
        return sendJson(res, 401, { error: 'unauthorized', message: '未配置有效的 Hook Token' });
      }

      const tokenPrefix = hookToken.slice(0, 10);
      const tokenHash = hashHookToken(hookToken);
      const tokenResult = await pool.query(
        `SELECT id, product_line, created_by FROM memory.hook_tokens
         WHERE is_active = TRUE AND token_prefix = $1 AND token = $2`,
        [tokenPrefix, tokenHash],
      );

      if (tokenResult.rows.length === 0) {
        return sendJson(res, 401, { error: 'unauthorized', message: 'Token 无效或已停用' });
      }

      tokenProductLine = (tokenResult.rows[0].product_line as string) ?? null;
      tokenUserId = (tokenResult.rows[0].created_by as string) ?? null;
      pool.query(
        `UPDATE memory.hook_tokens SET last_used = NOW() WHERE id = $1`,
        [tokenResult.rows[0].id],
      ).catch((err) => {
        logger.debug({ err }, '更新 hook_tokens last_used 失败（非阻塞）');
      });
    } catch {
      return sendJson(res, 401, { error: 'unauthorized', message: 'Hook Token 验证服务不可用' });
    }
  }

  const body = await readJsonBody(req);
  if (!body && method === 'POST') {
    return sendJson(res, 400, { error: 'invalid_request', message: '请求体必须为 JSON' });
  }

  if (path === '/api/hooks/commit' && method === 'POST') {
    const { handleCommitHook } = await import('./hooks/commit-handler.js');
    return handleCommitHook(
      body as unknown as import('./hooks/commit-handler.js').CommitPayload,
      sendJson, res, ctx.config.memoryServiceUrl,
      { productLine: tokenProductLine, userId: tokenUserId },
    );
  }

  if (path === '/api/hooks/batch' && method === 'POST') {
    const { handleBatchHook } = await import('./hooks/batch-handler.js');
    return handleBatchHook(
      body as unknown as import('./hooks/batch-handler.js').BatchCommitPayload,
      sendJson, res,
    );
  }

  if (path === '/api/hooks/branch' && method === 'POST') {
    const { handleBranchHook } = await import('./hooks/branch-handler.js');
    return handleBranchHook(
      body as unknown as import('./hooks/branch-handler.js').BranchPayload,
      sendJson, res,
      { productLine: tokenProductLine },
    );
  }

  sendJson(res, 404, { error: 'not_found', message: `Hook 端点 ${path} 不存在` });
}

function handleSetupGitHooks(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 410, {
    status: 'deprecated',
    message: 'Git hooks 现在由 MCP proxy 启动时自动安装。请使用 /api/setup/git-hooks-template 获取模板。',
    migration: '连接 Memforge MCP 后 hooks 会自动部署到 .git/hooks/，无需手动操作。',
  });
}

const GIT_HOOKS_VERSION = '1.4.0';

function generateGitHookTemplate(hookType: 'post-commit' | 'post-merge'): string {
  const lines = [
    '#!/bin/bash',
    `# [memforge-auto-installed] v${GIT_HOOKS_VERSION}`,
    `# Memforge Git Hook: ${hookType}`,
    '',
    '# 从共享配置读取 Gateway URL 和认证信息',
    'MEMFORGE_CONFIG="$HOME/.memforge/config"',
    'if [ ! -f "$MEMFORGE_CONFIG" ]; then exit 0; fi',
    'MEMFORGE_URL=$(grep \'^GATEWAY_URL=\' "$MEMFORGE_CONFIG" | cut -d= -f2-)',
    'HOOK_API_KEY=$(grep \'^HOOK_API_KEY=\' "$MEMFORGE_CONFIG" | cut -d= -f2-)',
    'if [ -z "$MEMFORGE_URL" ] || [ -z "$HOOK_API_KEY" ]; then exit 0; fi',
    '',
  ];

  if (hookType === 'post-commit') {
    lines.push(
      'COMMIT=$(git rev-parse HEAD 2>/dev/null)',
      "MESSAGE=$(git log -1 --format='%s' HEAD 2>/dev/null)",
      "AUTHOR=$(git log -1 --format='%an' HEAD 2>/dev/null)",
      'BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)',
      'STATS=$(git diff --shortstat HEAD~1..HEAD 2>/dev/null)',
      "FILES=$(git diff --name-only HEAD~1..HEAD 2>/dev/null | head -50 | tr '\\n' ',' | sed 's/,$//')",
      "DELETED_FILES=$(git diff --diff-filter=D --name-only HEAD~1..HEAD 2>/dev/null | head -20 | tr '\\n' ',' | sed 's/,$//')",
      'REPO=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null)',
      'REPO_PATH=$(git rev-parse --show-toplevel 2>/dev/null)',
      'IS_MERGE="false"',
      'if git rev-parse HEAD^2 >/dev/null 2>&1; then IS_MERGE="true"; fi',
      'DIFF=$(git diff HEAD~1..HEAD 2>/dev/null | head -c 51200)',
      "ej() { printf '%s' \"$1\" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()),end=\"\")' 2>/dev/null || printf '\"'\"'\"'%s'\"'\"'\"' \"$1\"; }",
      '',
      '(curl -s -X POST "$MEMFORGE_URL/api/hooks/commit" \\',
      '  -H "Authorization: Bearer $HOOK_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d "{\\"commit\\":\\"$COMMIT\\",\\"message\\":$(ej "$MESSAGE"),\\"author\\":$(ej "$AUTHOR"),\\"branch\\":\\"$BRANCH\\",\\"stats\\":$(ej "$STATS"),\\"files\\":\\"$FILES\\",\\"deleted_files\\":\\"$DELETED_FILES\\",\\"repo\\":\\"$REPO\\",\\"repo_path\\":$(ej "$REPO_PATH"),\\"diff\\":$(ej "$DIFF"),\\"is_merge\\":$IS_MERGE,\\"timestamp\\":$(date +%s)}" \\',
      '  --connect-timeout 5 --max-time 30 &) 2>/dev/null',
    );
  } else {
    lines.push(
      'BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)',
      'COMMIT=$(git rev-parse HEAD 2>/dev/null)',
      "AUTHOR=$(git log -1 --format='%an' HEAD 2>/dev/null)",
      'REPO=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null)',
      'REPO_PATH=$(git rev-parse --show-toplevel 2>/dev/null)',
      'IS_SQUASH="${1:-0}"',
      "MERGE_PARENTS=$(git log -1 --format='%P' HEAD 2>/dev/null | wc -w | tr -d ' ')",
      'MERGED_BRANCH=""',
      'if [ "$MERGE_PARENTS" -ge 2 ]; then',
      "  MERGED_BRANCH=$(git log -1 --format='%s' HEAD 2>/dev/null | sed -n \"s/.*Merge branch '\\([^']*\\)'.*/\\1/p\")",
      'fi',
      "ej() { printf '%s' \"$1\" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()),end=\"\")' 2>/dev/null || printf '\"'\"'\"'%s'\"'\"'\"' \"$1\"; }",
      '',
      '(curl -s -X POST "$MEMFORGE_URL/api/hooks/branch" \\',
      '  -H "Authorization: Bearer $HOOK_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d "{\\"repo\\":\\"$REPO\\",\\"from_branch\\":$(ej "$MERGED_BRANCH"),\\"to_branch\\":\\"$BRANCH\\",\\"commit\\":\\"$COMMIT\\",\\"user\\":$(ej "$AUTHOR"),\\"is_squash\\":$IS_SQUASH}" \\',
      '  --connect-timeout 5 --max-time 10 &) 2>/dev/null',
    );
  }

  lines.push('exit 0', '');
  return lines.join('\n');
}

function handleSetupGitHooksTemplate(req: IncomingMessage, res: ServerResponse): void {
  const clientVersion = req.headers['if-none-match'];
  if (clientVersion && clientVersion === GIT_HOOKS_VERSION) {
    res.writeHead(304);
    res.end();
    return;
  }

  const scripts = {
    'post-commit': generateGitHookTemplate('post-commit'),
    'post-merge': generateGitHookTemplate('post-merge'),
  };

  res.setHeader('ETag', GIT_HOOKS_VERSION);
  sendJson(res, 200, { version: GIT_HOOKS_VERSION, scripts });
}

async function handleTestDingtalk(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const webhookUrl = (body as Record<string, string>)?.webhook_url || process.env.DINGTALK_WEBHOOK_URL;
  const secret = (body as Record<string, string>)?.secret || process.env.DINGTALK_WEBHOOK_SECRET;

  if (!webhookUrl) {
    return sendJson(res, 400, { error: '未提供 webhook_url 且环境变量 DINGTALK_WEBHOOK_URL 未配置' });
  }

  if (!webhookUrl.startsWith('https://')) {
    return sendJson(res, 400, { error: 'invalid_request', message: 'webhook_url 必须为 https:// 开头' });
  }

  try {
    const crypto = await import('node:crypto');
    let url = webhookUrl;
    if (secret) {
      const timestamp = Date.now();
      const hmac = crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
      url += `&timestamp=${timestamp}&sign=${encodeURIComponent(hmac)}`;
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'text',
        text: { content: '[Memforge] 钉钉通知连接测试成功 ✅' },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const result = await resp.json() as { errcode: number; errmsg: string };
    if (result.errcode === 0) {
      sendJson(res, 200, { success: true, message: '钉钉通知发送成功' });
    } else {
      sendJson(res, 200, { success: false, errcode: result.errcode, errmsg: result.errmsg });
    }
  } catch (err) {
    sendJson(res, 500, { success: false, error: (err as Error).message });
  }
}

function handleSetupIdeRules(req: IncomingMessage, res: ServerResponse, ideOverride?: IdeType): void {
  const templatesDir = findRulesTemplatesDir();
  if (!templatesDir) {
    return sendJson(res, 500, { error: 'templates_not_found', message: '规则模板目录不存在' });
  }

  const ide = ideOverride ?? getSetupIde(req);
  const ideConfig = getIdeConfig(ide);
  const templates = readMdcRuleTemplates(templatesDir);

  let rules: Array<{ filename: string; content: string }>;
  if (ideConfig.ruleFormat === 'agents-md') {
    const body = templates
      .map(rule => convertRule(rule, 'mdc', 'agents-md').content.trim())
      .join('\n\n');
    rules = [{
      filename: 'AGENTS.md',
      content: [
        '# Memforge Rules',
        '',
        '> memforge_version: "2.4.0"',
        '',
        body,
        '',
      ].join('\n'),
    }];
  } else {
    rules = templates.map(rule => {
      const converted = convertRule(rule, 'mdc', ideConfig.ruleFormat);
      return { filename: converted.filename, content: converted.content };
    });
  }

  sendJson(res, 200, { ide, format: ideConfig.ruleFormat, rules, version: '2.4.0' });
}

function toHookArray(hooksConfig: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const hooks = (hooksConfig?.hooks ?? {}) as Record<string, unknown[]>;
  const result: Array<Record<string, unknown>> = [];
  for (const [event, items] of Object.entries(hooks)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (typeof item !== 'object' || !item) continue;
      result.push({ event, ...(item as Record<string, unknown>) });
    }
  }
  return result;
}

function mapHookEvent(event: string, ide: IdeType): string {
  const normalized = event.toLowerCase().replace(/[_-]/g, '');
  const codex: Record<string, string> = {
    sessionstart: 'SessionStart',
    pretooluse: 'PreToolUse',
    posttooluse: 'PostToolUse',
    stop: 'Stop',
  };
  const claude: Record<string, string> = {
    sessionstart: 'session_start',
    pretooluse: 'pre_tool_use',
    posttooluse: 'post_tool_use',
    stop: 'stop',
  };
  if (ide === 'codex') return codex[normalized] ?? event;
  if (ide === 'claude-code') return claude[normalized] ?? event;
  return event;
}

function buildHooksConfig(sourceConfig: Record<string, unknown> | null, ide: IdeType): Record<string, unknown> | null {
  if (ide === 'trae' || ide === 'trae-cn') return null;

  const entries = toHookArray(sourceConfig);
  const grouped: Record<string, unknown[]> = {};
  for (const entry of entries) {
    const event = mapHookEvent(String(entry.event ?? ''), ide);
    if (!event) continue;

    const command = String(entry.command ?? '');
    if (!command) continue;

    if (!grouped[event]) grouped[event] = [];
    const matcher = typeof entry.matcher === 'string' ? entry.matcher : undefined;
    const timeout = typeof entry.timeout === 'number' ? entry.timeout : undefined;

    if (ide === 'codex') {
      const hook: Record<string, unknown> = { type: 'command', command };
      if (timeout) hook.timeout = timeout;
      grouped[event].push({
        matcher: matcher ?? '',
        hooks: [hook],
      });
    } else if (ide === 'claude-code') {
      const hook: Record<string, unknown> = { type: 'command', command };
      if (matcher) hook.matcher = matcher;
      if (timeout) hook.timeout = timeout;
      grouped[event].push(hook);
    } else {
      const hook: Record<string, unknown> = { command };
      if (matcher) hook.matcher = matcher;
      if (timeout) hook.timeout = timeout;
      grouped[event].push(hook);
    }
  }

  return ide === 'cursor'
    ? { version: 1, hooks: grouped }
    : { hooks: grouped };
}

function handleSetupIdeHooks(req: IncomingMessage, res: ServerResponse, ideOverride?: IdeType): void {
  const candidates = [
    join(__gatewayDirname, '..', '..', '..', 'scripts', 'cursor-hooks'),
    join(__gatewayDirname, '..', '..', 'scripts', 'cursor-hooks'),
  ];

  let hooksDir: string | null = null;
  for (const dir of candidates) {
    if (existsSync(dir)) { hooksDir = dir; break; }
  }
  if (!hooksDir) {
    return sendJson(res, 404, { error: 'hooks_not_found', message: 'Hooks 目录不存在' });
  }

  const shellFiles = readdirSync(hooksDir).filter(f => f.endsWith('.sh'));
  const hooksJsonPath = join(hooksDir, 'hooks.json');
  const sourceHooksConfig = existsSync(hooksJsonPath)
    ? JSON.parse(readFileSync(hooksJsonPath, 'utf-8'))
    : null;
  const ide = ideOverride ?? getSetupIde(req);
  const hooksConfig = buildHooksConfig(sourceHooksConfig, ide);

  const scripts = shellFiles.map(filename => ({
    filename,
    content: readFileSync(join(hooksDir!, filename), 'utf-8'),
  }));

  const contentForHash = scripts.map(s => s.content).sort().join('\n');
  const version = createHash('md5').update(contentForHash).digest('hex').slice(0, 8);
  const clientVersion = req.headers['if-none-match'];
  if (clientVersion && clientVersion === version) {
    res.writeHead(304);
    res.end();
    return;
  }

  res.setHeader('ETag', version);
  sendJson(res, 200, { ide, scripts, hooksConfig, version });
}

function handleSetupProxyScript(req: IncomingMessage, res: ServerResponse): void {
  const candidates = [
    join(__gatewayDirname, '..', '..', '..', 'scripts', 'mcp-remote-proxy.mjs'),
    join(__gatewayDirname, '..', '..', 'scripts', 'mcp-remote-proxy.mjs'),
  ];

  for (const scriptPath of candidates) {
    if (existsSync(scriptPath)) {
      const content = readFileSync(scriptPath, 'utf-8');
      const version = content.match(/\/\/ @version (.+)/)?.[1]?.trim() ?? 'unknown';
      const clientVersion = req.headers['if-none-match'];
      if (clientVersion && clientVersion === version) {
        res.writeHead(304);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Disposition': 'attachment; filename="mcp-remote-proxy.mjs"',
        'ETag': version,
      });
      res.end(content);
      return;
    }
  }

  sendJson(res, 500, { error: 'script_not_found', message: 'proxy 脚本未找到' });
}

function handleInstallScript(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const apiKey = url.searchParams.get('key') ?? 'YOUR_API_KEY';
  const gatewayUrl = url.searchParams.get('url') ?? GATEWAY_URL_FOR_INSTALL;
  const ide = getSetupIde(req);
  const ideConfig = getIdeConfig(ide);

  const script = `#!/bin/bash
set -e

IDE="${ide}"
PROXY_DIR="$HOME/.memforge/bin"
PROXY_PATH="$PROXY_DIR/mcp-remote-proxy.mjs"
MCP_CONFIG="${ideConfig.mcpConfigPath.replace(process.env.HOME ?? '', '$HOME')}"
GATEWAY_URL="${gatewayUrl}"
API_KEY="${apiKey}"
DEVICE_ID="${ideConfig.deviceId}"

echo "🔧 Memforge MCP 一键安装"
echo "========================"

# 1. 下载代理脚本
mkdir -p "$PROXY_DIR"
echo "📥 下载代理脚本..."
curl -fsSL "$GATEWAY_URL/api/setup/proxy-script" -o "$PROXY_PATH"
chmod +x "$PROXY_PATH"
echo "   ✓ 已保存到 $PROXY_PATH"

# 2. 配置 IDE MCP
mkdir -p "$(dirname "$MCP_CONFIG")"
if [ "$IDE" = "codex" ]; then
  node -e "
    const fs = require('fs');
    const p = '$MCP_CONFIG';
    const block = [
      '[mcp_servers.memforge]',
      'command = \"node\"',
      'args = [\"$PROXY_PATH\"]',
      'startup_timeout_sec = 120',
      '',
      '[mcp_servers.memforge.env]',
      'MEMFORGE_GATEWAY_URL = \"$GATEWAY_URL\"',
      'MEMFORGE_API_KEY = \"$API_KEY\"',
      'MEMFORGE_IDE = \"codex\"',
      'MEMFORGE_DEVICE_ID = \"$DEVICE_ID\"'
    ].join('\\n');
    let s = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    const re = /\\n?\\[mcp_servers\\.memforge\\][\\s\\S]*?(?=\\n\\[[^\\]]+\\]|$)/;
    s = re.test(s) ? s.replace(re, '\\n' + block + '\\n') : (s.trimEnd() + '\\n\\n' + block + '\\n');
    fs.writeFileSync(p, s);
  "
else
  node -e "
    const fs = require('fs');
    const p = '$MCP_CONFIG';
    let cfg = {};
    if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    cfg.mcpServers ||= {};
    cfg.mcpServers.memforge = {
      command: 'node',
      args: ['$PROXY_PATH'],
      env: {
        MEMFORGE_GATEWAY_URL: '$GATEWAY_URL',
        MEMFORGE_API_KEY: '$API_KEY',
        MEMFORGE_IDE: '$IDE',
        MEMFORGE_DEVICE_ID: '$DEVICE_ID'
      }
    };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\\n');
  "
fi
echo "   ✓ 已配置 $MCP_CONFIG"

echo ""
echo "✅ 安装完成！请重启 IDE 使 MCP 生效。"
echo "   代理脚本支持自动更新，无需手动维护。"
`;

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(script);
}

const GATEWAY_URL_FOR_INSTALL = process.env.MEMFORGE_PUBLIC_URL
  ?? process.env.GATEWAY_URL
  ?? 'http://localhost:3000';
