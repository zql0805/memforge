// Created by dev on 2026/04/04
// Copyright © 2026

import type { RulesPostgresStorage } from '../storage/postgres.js';
import type { ConflictDetector } from '../services/conflict-detector.js';
import type { VoteManager } from '../services/vote-manager.js';
import type { MetricsService } from '../services/metrics-service.js';
import type { DiscoveryService } from '../services/discovery-service.js';
import type { RulesConfig, SkillStore, ApiEmbeddingService } from '@memforgeai/shared';
import type { GitContext } from '@memforgeai/shared';

export interface RulesToolContext {
  storage: RulesPostgresStorage;
  embedding: ApiEmbeddingService;
  conflictDetector: ConflictDetector;
  voteManager: VoteManager;
  metrics: MetricsService;
  discovery: DiscoveryService;
  config: RulesConfig;
  gitContext: GitContext | null;
  skillStore: SkillStore;
  /** 当前请求的用户 ID（Gateway 透传） */
  userId: string | null;
  /** 当前请求的组织 ID（Gateway 透传） */
  orgId: string | null;
  /** 当前请求的用户角色（Gateway 透传），用于 auto_activate / vote 身份校验 */
  userRole: string | null;
  /** 当前请求的用户主团队 ID（Gateway 透传） */
  teamId: string | null;
}
