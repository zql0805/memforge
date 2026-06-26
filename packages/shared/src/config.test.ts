import { describe, it, expect, afterEach } from 'vitest';
import { loadLlmConfig, loadEmbeddingConfig } from './config.js';

describe('loadLlmConfig', () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('未配置时返回 null', () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(loadLlmConfig()).toBeNull();
  });

  it('LLM_* 优先级高于 OPENAI_*', () => {
    process.env.LLM_BASE_URL = 'https://llm.example.com';
    process.env.LLM_API_KEY = 'llm-key';
    process.env.OPENAI_BASE_URL = 'https://openai.example.com';
    process.env.OPENAI_API_KEY = 'openai-key';

    const cfg = loadLlmConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.baseUrl).toBe('https://llm.example.com');
    expect(cfg!.apiKey).toBe('llm-key');
  });

  it('仅有 OPENAI_* 时回退使用', () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    process.env.OPENAI_BASE_URL = 'https://openai.example.com/';
    process.env.OPENAI_API_KEY = 'openai-key';

    const cfg = loadLlmConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.baseUrl).toBe('https://openai.example.com');
    expect(cfg!.apiKey).toBe('openai-key');
  });

  it('默认 model 为 deepseek-chat', () => {
    process.env.LLM_BASE_URL = 'https://x.com';
    process.env.LLM_API_KEY = 'key';
    delete process.env.LLM_MODEL;
    delete process.env.MEMFORGE_LLM_MODEL;

    const cfg = loadLlmConfig();
    expect(cfg!.model).toBe('deepseek-chat');
  });

  it('LLM_MODEL 覆盖默认值', () => {
    process.env.LLM_BASE_URL = 'https://x.com';
    process.env.LLM_API_KEY = 'key';
    process.env.LLM_MODEL = 'gpt-4o';

    const cfg = loadLlmConfig();
    expect(cfg!.model).toBe('gpt-4o');
  });

  it('尾部斜杠被去除', () => {
    process.env.LLM_BASE_URL = 'https://api.example.com/v1/';
    process.env.LLM_API_KEY = 'key';

    const cfg = loadLlmConfig();
    expect(cfg!.baseUrl).toBe('https://api.example.com/v1');
  });
});

describe('loadEmbeddingConfig', () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('未配置时返回 null', () => {
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(loadEmbeddingConfig()).toBeNull();
  });

  it('EMBEDDING_* 优先级高于 OPENAI_*', () => {
    process.env.EMBEDDING_BASE_URL = 'https://embed.example.com';
    process.env.EMBEDDING_API_KEY = 'embed-key';
    process.env.OPENAI_BASE_URL = 'https://openai.example.com';
    process.env.OPENAI_API_KEY = 'openai-key';

    const cfg = loadEmbeddingConfig();
    expect(cfg!.baseUrl).toBe('https://embed.example.com');
    expect(cfg!.apiKey).toBe('embed-key');
  });

  it('默认 dimensions 为 1024', () => {
    process.env.EMBEDDING_BASE_URL = 'https://embed.example.com';
    process.env.EMBEDDING_API_KEY = 'embed-key';

    const cfg = loadEmbeddingConfig();
    expect(cfg!.dimensions).toBe(1024);
  });

  it('默认 model 为 BAAI/bge-m3', () => {
    process.env.EMBEDDING_BASE_URL = 'https://embed.example.com';
    process.env.EMBEDDING_API_KEY = 'embed-key';

    const cfg = loadEmbeddingConfig();
    expect(cfg!.model).toBe('BAAI/bge-m3');
  });
});
