// Created by dev on 2026/04/04
// Copyright © 2026

import type { PostgresStorage } from '../storage/postgres.js';
import type { SensitiveDataScanner } from '../services/scanner.js';
import type { ApiEmbeddingService } from '@memforgeai/shared';
import type { Config, GitContext } from '@memforgeai/shared';

export interface ToolContext {
  storage: PostgresStorage;
  scanner: SensitiveDataScanner;
  embedding: ApiEmbeddingService;
  config: Config;
  gitContext: GitContext | null;
  userId: string | null;
  orgId: string | null;
  /** 用户主团队 ID（从 Gateway 传入），用于记忆的团队归属和 recall 过滤 */
  teamId: string | null;
  /** 用户角色（从 Gateway 传入），用于 IDOR 防护和 export 限制 */
  userRole: string | null;
  /** 设备标识（从 Gateway 传入），用于多设备路径隔离 */
  deviceId: string | null;
  /** 是否为超级管理员（从 Gateway 传入） */
  isSuperAdmin: boolean;
  /** 会话级追踪：get_system_rules 最近一次加载时间（null 表示本会话从未加载） */
  rulesLoadedAt: Date | null;
}
