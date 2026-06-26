// Created by dev on 2026/04/05
// Copyright © 2026
// MCP Gateway 配置

import { z } from 'zod';

const GatewayConfigSchema = z.object({
  port: z.number().default(3000),
  host: z.string().default('127.0.0.1'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // JWT 配置
  jwtSecret: z.string().min(32),
  jwtIssuer: z.string().default('memforge-gateway'),
  jwtAudience: z.string().default('memforge'),
  accessTokenTtlSeconds: z.number().default(86400),
  refreshTokenTtlSeconds: z.number().default(86400 * 30),

  // OAuth 2.1 外部 IdP（可选，不配置时使用内置认证）
  oauthIssuer: z.string().optional(),
  oauthJwksUri: z.string().optional(),

  // 后端服务地址
  memoryServiceUrl: z.string().default('http://127.0.0.1:3001'),
  rulesServiceUrl: z.string().default('http://127.0.0.1:3002'),
  knowledgeServiceUrl: z.string().default('http://127.0.0.1:3003'),

  // MCP 工具速率限制
  rateLimitGlobalRpm: z.number().default(600),
  rateLimitPerUserRpm: z.number().default(120),
  rateLimitPerToolRpm: z.number().default(60),

  // 登录端点限流
  loginRateLimitPerIpRpm: z.number().default(10),
  loginRateLimitPerAccountRpm: z.number().default(5),
  loginRateLimitGlobalRpm: z.number().default(100),

  // CORS（生产环境通过 CORS_ORIGINS 显式配置，禁止通配符）
  corsOrigins: z.array(z.string()).default(['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173']),

  // 开放注册（true: 首次登录自动注册；false: 需管理员预创建账号）
  openRegistration: z.boolean().default(false),

  // 登录失败锁定
  loginLockMaxAttempts: z.number().default(5),
  loginLockDurationMs: z.number().default(900_000),

  // 设备验证（开启后新设备需管理员审批）
  deviceVerification: z.boolean().default(false),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export function loadGatewayConfig(): GatewayConfig {
  if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须设置 JWT_SECRET 环境变量');
  }

  return GatewayConfigSchema.parse({
    port: parseIntEnv('PORT', 3000),
    host: process.env.GATEWAY_HOST ?? '127.0.0.1',
    logLevel: process.env.LOG_LEVEL ?? 'info',

    jwtSecret: process.env.JWT_SECRET ?? generateDevSecret(),
    jwtIssuer: process.env.JWT_ISSUER ?? 'memforge-gateway',
    jwtAudience: process.env.JWT_AUDIENCE ?? 'memforge',
    accessTokenTtlSeconds: parseIntEnv('ACCESS_TOKEN_TTL', 86400),
    refreshTokenTtlSeconds: parseIntEnv('REFRESH_TOKEN_TTL', 86400 * 30),

    oauthIssuer: process.env.OAUTH_ISSUER ?? undefined,
    oauthJwksUri: process.env.OAUTH_JWKS_URI ?? undefined,

    memoryServiceUrl: process.env.MEMORY_SERVICE_URL ?? 'http://127.0.0.1:3001',
    rulesServiceUrl: process.env.RULES_SERVICE_URL ?? 'http://127.0.0.1:3002',
    knowledgeServiceUrl: process.env.KNOWLEDGE_SERVICE_URL ?? 'http://127.0.0.1:3003',

    rateLimitGlobalRpm: parseIntEnv('RATE_LIMIT_GLOBAL_RPM', 600),
    rateLimitPerUserRpm: parseIntEnv('RATE_LIMIT_PER_USER_RPM', 120),
    rateLimitPerToolRpm: parseIntEnv('RATE_LIMIT_PER_TOOL_RPM', 60),

    loginRateLimitPerIpRpm: parseIntEnv('LOGIN_RATE_LIMIT_PER_IP_RPM', 10),
    loginRateLimitPerAccountRpm: parseIntEnv('LOGIN_RATE_LIMIT_PER_ACCOUNT_RPM', 5),
    loginRateLimitGlobalRpm: parseIntEnv('LOGIN_RATE_LIMIT_GLOBAL_RPM', 100),

    corsOrigins: process.env.CORS_ORIGINS?.split(',').map(s => s.trim()) ?? ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'],

    openRegistration: process.env.OPEN_REGISTRATION === 'true',

    loginLockMaxAttempts: parseIntEnv('LOGIN_LOCK_MAX_ATTEMPTS', 5),
    loginLockDurationMs: parseIntEnv('LOGIN_LOCK_DURATION_MS', 900_000),

    deviceVerification: process.env.DEVICE_VERIFICATION === 'true',
  });
}

function parseIntEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

import { randomBytes } from 'node:crypto';

let devSecret: string | null = null;
function generateDevSecret(): string {
  if (!devSecret) {
    devSecret = randomBytes(32).toString('hex');
    // 开发模式自动生成密钥：每次重启会变化，生产环境必须通过 JWT_SECRET 指定
  }
  return devSecret;
}
