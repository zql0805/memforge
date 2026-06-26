// Created by dev on 2026/05/21
import type { ApiEmbeddingService } from '@memforgeai/shared';
import type { Config } from '@memforgeai/shared';
import type { KnowledgePostgresStorage } from '../storage/postgres.js';

export interface KnowledgeToolContext {
  storage: KnowledgePostgresStorage;
  embedding: ApiEmbeddingService | null;
  config: Config;
  userId: string | null;
  orgId: string | null;
  teamId: string | null;
  userRole: string | null;
  deviceId: string | null;
  isSuperAdmin: boolean;
  projectId?: string;
}
