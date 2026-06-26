// Created by dev on 2026/04/05
// Copyright © 2026
// 认证授权类型定义

import type { ApiKeyCreationScope } from '@memforgeai/shared';

export type UserRole = 'admin' | 'lead' | 'developer' | 'viewer';

/** API Key 权限范围：read=只读 MCP；readwrite=读写 MCP；admin=含管理类工具 */
export type ApiKeyScope = ApiKeyCreationScope;

export interface AuthUser {
  id: string;
  orgId: string;
  externalId: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
}

export interface TokenPayload {
  sub: string;       // user id
  org: string;       // org id
  role: UserRole;
  email?: string;
  name?: string;
  did?: string;      // device id（设备验证启用时包含）
  teamId?: string;   // 主团队 id
  isSuperAdmin?: boolean;
  /** 仅 API Key 认证时存在；JWT 无此字段 */
  apiKeyScope?: ApiKeyScope;
}

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  isPublic: boolean;
}

export interface AuthorizationCode {
  code: string;
  clientId: string;
  userId: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  redirectUri: string;
  expiresAt: number;
}

export interface RefreshToken {
  token: string;
  userId: string;
  clientId: string;
  expiresAt: number;
}

/** 工具权限映射 */
export type ToolPermission = 'read' | 'write' | 'admin';

export interface ToolPermissionEntry {
  tool: string;
  permission: ToolPermission;
  autoApprove: boolean;
}

/** 产品线访问级别 */
export type ProductLineAccessLevel = 'read' | 'write' | 'manage';

export interface ProductLineAccess {
  productLine: string;
  accessLevel: ProductLineAccessLevel;
  grantedBy: string | null;
  createdAt: string;
}

export interface AuthUserFull extends AuthUser {
  isSuperAdmin: boolean;
}
