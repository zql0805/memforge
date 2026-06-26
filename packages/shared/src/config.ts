// Created by dev on 2026/04/04
// Copyright © 2026

import { z } from 'zod';

const ConfigSchema = z.object({
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  similarityThreshold: z.number().default(0.5),
  deduplicationThreshold: z.number().default(0.85),
  openaiBaseUrl: z.string().optional(),
  openaiApiKey: z.string().optional(),
  openaiEmbeddingModel: z.string().optional(),
  openaiEmbeddingDimensions: z.number().optional(),
  /** 查询前缀（bge-m3 不需要，E5 系列需要 "query: "） */
  embeddingQueryPrefix: z.string().optional(),
  /** 文档前缀（bge-m3 不需要，E5 系列需要 "passage: "） */
  embeddingPassagePrefix: z.string().optional(),
});

export interface Config {
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  similarityThreshold: number;
  deduplicationThreshold: number;
  embeddingDimensions: number;
  /** 查询前缀（bge-m3 为 ""） */
  embeddingQueryPrefix: string;
  /** 文档前缀（bge-m3 为 ""） */
  embeddingPassagePrefix: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  openaiEmbeddingModel?: string;
  openaiEmbeddingDimensions?: number;
}

// ─── LLM 推理配置（DeepSeek / OpenAI 兼容） ───

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 加载 LLM 推理配置（与 Embedding 配置分离）。
 * 优先级：LLM_* > OPENAI_* > MEMFORGE_LLM_MODEL
 */
export function loadLlmConfig(): LlmConfig | null {
  const baseUrl = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL;
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.LLM_MODEL || process.env.MEMFORGE_LLM_MODEL || 'deepseek-chat';
  if (!baseUrl || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey, model };
}

// ─── Embedding 配置 ───

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  queryPrefix: string;
  passagePrefix: string;
}

/** 加载 Embedding API 配置；缺少 baseUrl 或 apiKey 时返回 null */
export function loadEmbeddingConfig(): EmbeddingConfig | null {
  const baseUrl = process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL;
  const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.EMBEDDING_MODEL || process.env.OPENAI_EMBEDDING_MODEL || 'BAAI/bge-m3';
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    model,
    dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || process.env.OPENAI_EMBEDDING_DIMENSIONS || '1024', 10),
    queryPrefix: process.env.EMBEDDING_QUERY_PREFIX || '',
    passagePrefix: process.env.EMBEDDING_PASSAGE_PREFIX || '',
  };
}

/** 加载全局运行时配置（日志级别、相似度阈值、OpenAI 嵌入参数等） */
export function loadConfig(): Config {
  const raw = ConfigSchema.parse({
    logLevel: process.env.LOG_LEVEL || 'info',
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
    similarityThreshold: raw.similarityThreshold,
    deduplicationThreshold: raw.deduplicationThreshold,
    embeddingDimensions: raw.openaiEmbeddingDimensions ?? 1024,
    embeddingQueryPrefix: raw.embeddingQueryPrefix ?? '',
    embeddingPassagePrefix: raw.embeddingPassagePrefix ?? '',
    openaiBaseUrl: raw.openaiBaseUrl,
    openaiApiKey: raw.openaiApiKey,
    openaiEmbeddingModel: raw.openaiEmbeddingModel,
    openaiEmbeddingDimensions: raw.openaiEmbeddingDimensions,
  };
}
