// Created by dev on 2026/04/05
// Copyright © 2026
// OAuth 2.1 + PKCE 认证提供者

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { getLogger, getPool } from '@memforgeai/shared';
import type { GatewayConfig } from '../config.js';
import type {
  AuthUser, TokenPayload, AuthorizationCode, RefreshToken, OAuthClient,
} from './types.js';

const logger = getLogger('oauth');

export class OAuthProvider {
  private readonly secret: Uint8Array;
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly refreshTokens = new Map<string, RefreshToken>();
  private readonly clients = new Map<string, OAuthClient>();
  private dbClientsLoaded = false;

  constructor(private readonly config: GatewayConfig) {
    this.secret = new TextEncoder().encode(config.jwtSecret);
    this.registerDefaultClients();
  }

  /**
   * 从数据库加载 OAuth 客户端注册信息。
   * 数据库中的客户端会覆盖内存中同 clientId 的默认值。
   * 加载失败时回退到内存默认客户端。
   */
  async loadClientsFromDb(): Promise<void> {
    if (this.dbClientsLoaded) return;
    try {
      const pool = getPool();
      const { rows } = await pool.query<{
        client_id: string;
        client_name: string;
        redirect_uris: string[];
        is_public: boolean;
        is_active: boolean;
      }>('SELECT client_id, client_name, redirect_uris, is_public, is_active FROM memory.oauth_clients WHERE is_active = TRUE');

      for (const row of rows) {
        this.clients.set(row.client_id, {
          clientId: row.client_id,
          clientName: row.client_name,
          redirectUris: row.redirect_uris,
          isPublic: row.is_public,
        });
      }
      this.dbClientsLoaded = true;
      logger.info({ count: rows.length }, '已从数据库加载 OAuth 客户端');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '从数据库加载 OAuth 客户端失败，使用内存默认值');
    }
  }

  private registerDefaultClients(): void {
    const defaultClients: OAuthClient[] = [
      {
        clientId: 'cursor-ide',
        clientName: 'Cursor IDE',
        redirectUris: ['http://localhost:0/callback'],
        isPublic: true,
      },
      {
        clientId: 'claude-code',
        clientName: 'Claude Code',
        redirectUris: ['http://localhost:0/callback'],
        isPublic: true,
      },
      {
        clientId: 'vscode-ext',
        clientName: 'VS Code Extension',
        redirectUris: ['http://localhost:0/callback'],
        isPublic: true,
      },
      {
        clientId: 'memforge-cli',
        clientName: 'Memforge CLI',
        redirectUris: ['http://localhost:0/callback'],
        isPublic: true,
      },
      {
        clientId: 'memforge-web',
        clientName: 'Memforge Web Dashboard',
        redirectUris: ['http://localhost:5173/callback', 'http://localhost:3000/callback'],
        isPublic: true,
      },
    ];

    for (const client of defaultClients) {
      this.clients.set(client.clientId, client);
    }
  }

  getClient(clientId: string): OAuthClient | undefined {
    return this.clients.get(clientId);
  }

  /**
   * 生成授权码（Authorization Code + PKCE）。
   * 实际生产中此步骤需要用户交互（登录页面），
   * 这里简化为直接发放（适配 MCP 场景的 CLI/IDE 流程）。
   */
  createAuthorizationCode(
    clientId: string,
    userId: string,
    codeChallenge: string,
    codeChallengeMethod: 'S256',
    redirectUri: string,
  ): string {
    const code = randomBytes(32).toString('base64url');

    this.codes.set(code, {
      code,
      clientId,
      userId,
      codeChallenge,
      codeChallengeMethod,
      redirectUri,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    // 10 分钟后自动清理
    setTimeout(() => this.codes.delete(code), 10 * 60 * 1000);

    logger.debug({ clientId, userId }, '已发放授权码');
    return code;
  }

  /** 从授权码查找 userId（不消费授权码，exchangeCode 负责删除） */
  getUserIdFromCode(code: string): string | null {
    const authCode = this.codes.get(code);
    if (!authCode || authCode.expiresAt < Date.now()) {
      return null;
    }
    return authCode.userId;
  }

  /**
   * 用授权码 + code_verifier 交换 Token。
   * 验证 PKCE: S256(code_verifier) === code_challenge
   */
  async exchangeCode(
    code: string,
    clientId: string,
    codeVerifier: string,
    redirectUri: string,
    user: AuthUser,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const authCode = this.codes.get(code);
    if (!authCode) {
      throw new OAuthError('invalid_grant', '授权码无效或已过期');
    }

    if (authCode.clientId !== clientId) {
      throw new OAuthError('invalid_grant', '客户端 ID 不匹配');
    }
    if (authCode.redirectUri !== redirectUri) {
      throw new OAuthError('invalid_grant', '重定向 URI 不匹配');
    }
    if (authCode.expiresAt < Date.now()) {
      this.codes.delete(code);
      throw new OAuthError('invalid_grant', '授权码已过期');
    }

    if (!this.verifyCodeChallenge(codeVerifier, authCode.codeChallenge)) {
      throw new OAuthError('invalid_grant', 'PKCE code_verifier 验证失败');
    }

    this.codes.delete(code);

    return this.issueTokenPair(user, clientId);
  }

  async issueTokenPair(
    user: AuthUser,
    clientId: string,
    deviceId?: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const payload: TokenPayload = {
      sub: user.id,
      org: user.orgId,
      role: user.role,
      email: user.email ?? undefined,
      name: user.displayName ?? undefined,
      did: deviceId,
    };

    const accessToken = await new SignJWT(payload as unknown as JWTPayload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.config.jwtIssuer)
      .setAudience(this.config.jwtAudience)
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTokenTtlSeconds}s`)
      .setJti(randomBytes(16).toString('hex'))
      .sign(this.secret);

    const refreshTokenStr = randomBytes(48).toString('base64url');
    this.refreshTokens.set(refreshTokenStr, {
      token: refreshTokenStr,
      userId: user.id,
      clientId,
      expiresAt: Date.now() + this.config.refreshTokenTtlSeconds * 1000,
    });

    logger.info({ userId: user.id, role: user.role }, '已发放 Token 对');

    return {
      accessToken,
      refreshToken: refreshTokenStr,
      expiresIn: this.config.accessTokenTtlSeconds,
    };
  }

  async refreshAccessToken(
    refreshTokenStr: string,
    clientId: string,
    user: AuthUser,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const rt = this.refreshTokens.get(refreshTokenStr);
    if (!rt || rt.clientId !== clientId || rt.expiresAt < Date.now()) {
      throw new OAuthError('invalid_grant', 'Refresh Token 无效或已过期');
    }

    // 旋转 Refresh Token
    this.refreshTokens.delete(refreshTokenStr);

    return this.issueTokenPair(user, clientId);
  }

  async verifyAccessToken(token: string): Promise<TokenPayload> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: this.config.jwtIssuer,
        audience: this.config.jwtAudience,
      });

      return {
        sub: payload.sub!,
        org: (payload as Record<string, unknown>).org as string,
        role: (payload as Record<string, unknown>).role as TokenPayload['role'],
        email: (payload as Record<string, unknown>).email as string | undefined,
        name: (payload as Record<string, unknown>).name as string | undefined,
      };
    } catch (err) {
      throw new OAuthError('invalid_token', 'Access Token 验证失败', err);
    }
  }

  getRefreshTokenUserId(token: string): string | null {
    const rt = this.refreshTokens.get(token);
    if (!rt || rt.expiresAt < Date.now()) return null;
    return rt.userId;
  }

  revokeRefreshToken(token: string): void {
    this.refreshTokens.delete(token);
  }

  private verifyCodeChallenge(verifier: string, challenge: string): boolean {
    const hash = createHash('sha256')
      .update(verifier)
      .digest('base64url');

    const a = Buffer.from(hash);
    const b = Buffer.from(challenge);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** 发现端点元数据（RFC 8414） */
  getDiscoveryMetadata(baseUrl: string): Record<string, unknown> {
    return {
      issuer: this.config.jwtIssuer,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['read', 'write', 'admin'],
    };
  }
}

export class OAuthError extends Error {
  constructor(
    public readonly errorCode: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}
