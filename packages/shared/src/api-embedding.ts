// Created by dev on 2026/04/21
// Copyright © 2026
// API Embedding 服务 — 支持 OpenAI 兼容接口（OpenAI / 硅基流动 / Ollama 等）

import { getLogger } from './logger.js';
import { EmbeddingVectorCache, type EmbeddingCacheKind, type EmbeddingCacheStats } from './embedding-cache.js';

const logger = getLogger('api-embedding');
const FETCH_TIMEOUT_MS = 30_000;

export interface ApiEmbeddingOptions {
  /** API 基础 URL，例如 https://api.siliconflow.cn/v1 或 https://api.openai.com/v1 */
  baseUrl: string;
  /** API 密钥 */
  apiKey: string;
  /** 嵌入模型名称，例如 BAAI/bge-m3 或 text-embedding-3-small */
  model: string;
  /** 向量维度（用于校验，不传则信任 API 返回） */
  dimensions?: number;
  /** 查询前缀（E5/BGE 指令前缀） */
  queryPrefix?: string;
  /** 段落前缀 */
  passagePrefix?: string;
  /** 单批次最大文本数 */
  batchSize?: number;
  /** 向量缓存（默认按 model 自动创建） */
  vectorCache?: EmbeddingVectorCache;
  /** 是否启用向量缓存，默认 true */
  cacheEnabled?: boolean;
}

/**
 * 基于 OpenAI 兼容 API 的嵌入服务。
 * 接口与本地 EmbeddingService 完全兼容，可直接替换。
 * query / passage / raw 向量支持 L1+L2 缓存，减少重复计费。
 */
export class ApiEmbeddingService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly queryPrefix: string;
  private readonly passagePrefix: string;
  private readonly batchSize: number;
  private readonly vectorCache: EmbeddingVectorCache;
  readonly dimensions: number;
  readonly modelName: string;
  private initialized = false;

  constructor(opts: ApiEmbeddingOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.queryPrefix = opts.queryPrefix ?? '';
    this.passagePrefix = opts.passagePrefix ?? '';
    this.batchSize = opts.batchSize ?? 32;
    this.dimensions = opts.dimensions ?? 1024;
    this.modelName = opts.model;
    this.vectorCache = opts.vectorCache ?? new EmbeddingVectorCache(opts.model, {
      enabled: opts.cacheEnabled,
    });
  }

  /** 初始化（兼容接口，API 模式无需加载本地文件） */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const vec = await this.embedUncached('raw', 'test');
      if (vec.length === 0) {
        throw new Error('API 返回空向量');
      }
      const actualDim = vec.length;
      if (actualDim !== this.dimensions) {
        logger.warn(
          { expected: this.dimensions, actual: actualDim },
          'API 返回维度与配置不符，建议检查 OPENAI_EMBEDDING_MODEL 和数据库向量列维度',
        );
      }
      logger.info(
        { model: this.model, dimensions: actualDim, baseUrl: this.baseUrl },
        'API Embedding 服务初始化完成（含 query/passage 向量缓存）',
      );
    } catch (err) {
      throw new Error(
        `API Embedding 初始化失败: ${String(err)}\n请检查 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_EMBEDDING_MODEL 配置`,
      );
    }

    this.initialized = true;
  }

  /** 嵌入查询文本（加 query 前缀） */
  async embedQuery(text: string): Promise<number[]> {
    const input = this.queryPrefix ? `${this.queryPrefix}${text}` : text;
    return this.embedCached('query', input);
  }

  /** 嵌入段落文本（加 passage 前缀） */
  async embedPassage(text: string): Promise<number[]> {
    const input = this.passagePrefix ? `${this.passagePrefix}${text}` : text;
    return this.embedCached('passage', input);
  }

  /** 嵌入单条文本（无前缀） */
  async embed(text: string): Promise<number[]> {
    return this.embedCached('raw', text);
  }

  /** 批量嵌入段落文本（加 passage 前缀）；已缓存项跳过 API */
  async embedPassageBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const inputs = texts.map((t) => (this.passagePrefix ? `${this.passagePrefix}${t}` : t));
    const results: number[][] = new Array(inputs.length);
    const pending: Array<{ index: number; text: string; input: string }> = [];

    for (let i = 0; i < inputs.length; i++) {
      const cached = await this.vectorCache.get('passage', inputs[i]);
      if (cached) {
        results[i] = cached;
      } else {
        pending.push({ index: i, text: texts[i], input: inputs[i] });
      }
    }

    for (let i = 0; i < pending.length; i += this.batchSize) {
      const slice = pending.slice(i, i + this.batchSize);
      const vecs = await this.callApi(slice.map((p) => p.input));
      for (let j = 0; j < slice.length; j++) {
        const { index, input } = slice[j];
        results[index] = vecs[j];
        await this.vectorCache.set('passage', input, vecs[j]);
      }
    }

    this.vectorCache.logStatsIfNeeded();
    return results;
  }

  /** 批量嵌入文本（自动分批，无前缀）；已缓存项跳过 API */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = new Array(texts.length);
    const pending: Array<{ index: number; text: string }> = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = await this.vectorCache.get('raw', texts[i]);
      if (cached) {
        results[i] = cached;
      } else {
        pending.push({ index: i, text: texts[i] });
      }
    }

    for (let i = 0; i < pending.length; i += this.batchSize) {
      const slice = pending.slice(i, i + this.batchSize);
      const vecs = await this.callApi(slice.map((p) => p.text));
      for (let j = 0; j < slice.length; j++) {
        const { index, text } = slice[j];
        results[index] = vecs[j];
        await this.vectorCache.set('raw', text, vecs[j]);
      }
    }

    this.vectorCache.logStatsIfNeeded();
    return results;
  }

  getCacheStats(): EmbeddingCacheStats {
    return this.vectorCache.getStats();
  }

  private async embedCached(kind: EmbeddingCacheKind, input: string): Promise<number[]> {
    const cached = await this.vectorCache.get(kind, input);
    if (cached) {
      this.vectorCache.logStatsIfNeeded();
      return cached;
    }
    const vec = await this.embedUncached(kind, input);
    await this.vectorCache.set(kind, input, vec);
    this.vectorCache.logStatsIfNeeded();
    return vec;
  }

  private async embedUncached(kind: EmbeddingCacheKind, input: string): Promise<number[]> {
    const result = await this.callApi([input]);
    return result[0];
  }

  /** 调用 OpenAI 兼容 /v1/embeddings 接口 */
  private async callApi(inputs: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/embeddings`;
    const body = JSON.stringify({
      model: this.model,
      input: inputs,
      encoding_format: 'float',
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error && err.name === 'AbortError'
        ? `请求超时 (${FETCH_TIMEOUT_MS}ms)`
        : String(err);
      throw new Error(`HTTP 请求失败 (${url}): ${msg}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`API 错误 ${res.status}: ${errText}`);
    }

    const json = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      usage?: { prompt_tokens: number; total_tokens: number };
    };

    if (!json.data || json.data.length !== inputs.length) {
      throw new Error(`API 返回数量不匹配: 期望 ${inputs.length}，实际 ${json.data?.length ?? 0}`);
    }

    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
