// Created by dev on 2026/04/04
// Copyright © 2026

import { z } from 'zod';
import type { VotingConfig, VoterRole } from './types.js';

const RulesConfigSchema = z.object({
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  votingMinVoters: z.number().default(3),
  votingPassThreshold: z.number().default(5),
  votingTimeoutDays: z.number().default(14),
  conflictDuplicateThreshold: z.number().default(0.9),
  conflictRelatedThreshold: z.number().default(0.7),
  enforceRelevanceThreshold: z.number().default(0.3),
  enforceViolationThreshold: z.number().default(0.15),
  openaiBaseUrl: z.string().optional(),
  openaiApiKey: z.string().optional(),
  openaiEmbeddingModel: z.string().optional(),
  openaiEmbeddingDimensions: z.number().optional(),
  /** 查询前缀（bge-m3 不需要，E5 系列需要 "query: "） */
  embeddingQueryPrefix: z.string().optional(),
  /** 文档前缀（bge-m3 不需要，E5 系列需要 "passage: "） */
  embeddingPassagePrefix: z.string().optional(),
});

export interface RulesConfig {
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  embeddingDimensions: number;
  embeddingQueryPrefix: string;
  embeddingPassagePrefix: string;
  voting: VotingConfig;
  conflictDuplicateThreshold: number;
  conflictRelatedThreshold: number;
  enforceRelevanceThreshold: number;
  enforceViolationThreshold: number;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  openaiEmbeddingModel?: string;
  openaiEmbeddingDimensions?: number;
}

const DEFAULT_ROLE_WEIGHTS: Record<VoterRole, number> = {
  admin: 3,
  lead: 2,
  developer: 1,
};

/** 加载规则引擎配置（投票阈值、冲突检测、Embedding 参数等） */
export function loadRulesConfig(): RulesConfig {
  const raw = RulesConfigSchema.parse({
    logLevel: process.env.LOG_LEVEL || 'info',
    votingMinVoters: process.env.VOTING_MIN_VOTERS ? Number(process.env.VOTING_MIN_VOTERS) : undefined,
    votingPassThreshold: process.env.VOTING_PASS_THRESHOLD ? Number(process.env.VOTING_PASS_THRESHOLD) : undefined,
    votingTimeoutDays: process.env.VOTING_TIMEOUT_DAYS ? Number(process.env.VOTING_TIMEOUT_DAYS) : undefined,
    openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
    openaiApiKey: process.env.OPENAI_API_KEY || undefined,
    openaiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL || undefined,
    openaiEmbeddingDimensions: process.env.OPENAI_EMBEDDING_DIMENSIONS
      ? parseInt(process.env.OPENAI_EMBEDDING_DIMENSIONS, 10)
      : undefined,
    embeddingQueryPrefix: process.env.EMBEDDING_QUERY_PREFIX || undefined,
    embeddingPassagePrefix: process.env.EMBEDDING_PASSAGE_PREFIX || undefined,
  });

  return {
    logLevel: raw.logLevel,
    embeddingDimensions: raw.openaiEmbeddingDimensions ?? 1024,
    embeddingQueryPrefix: raw.embeddingQueryPrefix ?? '',
    embeddingPassagePrefix: raw.embeddingPassagePrefix ?? '',
    voting: {
      minVoters: raw.votingMinVoters,
      passThreshold: raw.votingPassThreshold,
      roleWeights: DEFAULT_ROLE_WEIGHTS,
      timeoutDays: raw.votingTimeoutDays,
    },
    conflictDuplicateThreshold: raw.conflictDuplicateThreshold,
    conflictRelatedThreshold: raw.conflictRelatedThreshold,
    enforceRelevanceThreshold: raw.enforceRelevanceThreshold,
    enforceViolationThreshold: raw.enforceViolationThreshold,
    openaiBaseUrl: raw.openaiBaseUrl,
    openaiApiKey: raw.openaiApiKey,
    openaiEmbeddingModel: raw.openaiEmbeddingModel,
    openaiEmbeddingDimensions: raw.openaiEmbeddingDimensions,
  };
}
