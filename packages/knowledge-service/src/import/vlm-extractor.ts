// Created by dev on 2026/06/02

import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { getLogger } from '@memforgeai/shared';

const logger = getLogger('knowledge:vlm');

function isPrivateIPv4(a: number, b: number, _c: number, _d: number): boolean {
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
  if (h.startsWith('::ffff:')) {
    const v4 = h.slice(7);
    const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) return isPrivateIPv4(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
  }
  return false;
}

function assertHostNotPrivate(host: string): void {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    throw new Error('禁止访问内网地址');
  }

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    const m = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m && isPrivateIPv4(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]))) {
      throw new Error('禁止访问内网地址');
    }
    return;
  }
  if (ipVersion === 6 && isPrivateIPv6(normalized)) {
    throw new Error('禁止访问内网地址');
  }
}

async function assertResolvedHostSafe(hostname: string): Promise<void> {
  if (net.isIP(hostname)) return;
  const records = await lookup(hostname, { all: true });
  for (const { address } of records) {
    assertHostNotPrivate(address);
  }
}

async function assertSafeImageUrl(imageUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error('无效的图片 URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('图片 URL 必须使用 HTTPS');
  }

  const host = parsed.hostname.toLowerCase();
  assertHostNotPrivate(host);
  await assertResolvedHostSafe(host);
}

export interface VlmConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
}

export function loadVlmConfig(): VlmConfig | null {
  const enabled = process.env.VLM_ENABLED === 'true';
  if (!enabled) return null;

  const baseUrl = process.env.VLM_BASE_URL;
  const apiKey = process.env.VLM_API_KEY;
  const model = process.env.VLM_MODEL;

  if (!baseUrl || !apiKey || !model) {
    logger.warn('VLM_ENABLED=true 但缺少 VLM_BASE_URL/VLM_API_KEY/VLM_MODEL，已禁用');
    return null;
  }

  return {
    enabled: true,
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    model,
    maxTokens: parseInt(process.env.VLM_MAX_TOKENS ?? '300', 10),
    timeoutMs: parseInt(process.env.VLM_TIMEOUT_MS ?? '30000', 10),
  };
}

export class VlmExtractor {
  private readonly config: VlmConfig;

  constructor(config: VlmConfig) {
    this.config = config;
  }

  get isAvailable(): boolean {
    return this.config.enabled;
  }

  async extractText(imageUrl: string): Promise<string | null> {
    try {
      await assertSafeImageUrl(imageUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '请描述这张图片的内容，用于知识库搜索索引。用简洁的中文描述，不超过200字。' },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          }],
          max_tokens: this.config.maxTokens,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        logger.warn({ status: response.status, errText, imageUrl }, 'VLM API 调用失败');
        return null;
      }

      const json = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = json.choices?.[0]?.message?.content?.trim();
      if (!content) {
        logger.warn({ imageUrl }, 'VLM 返回空内容');
        return null;
      }

      logger.debug({ imageUrl, contentLength: content.length }, 'VLM 图片描述提取成功');
      return content;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        logger.warn({ imageUrl, timeoutMs: this.config.timeoutMs }, 'VLM 调用超时');
      } else {
        logger.warn({ err, imageUrl }, 'VLM 提取异常');
      }
      return null;
    }
  }

  /**
   * 批量提取多张图片描述，合并为单个文本。
   * 异步执行，单张失败不影响其他。
   */
  async extractBatch(imageUrls: string[]): Promise<string> {
    if (imageUrls.length === 0) return '';

    const safeUrls: string[] = [];
    for (const url of imageUrls) {
      try {
        await assertSafeImageUrl(url);
        safeUrls.push(url);
      } catch (err) {
        logger.warn({ url, err: err instanceof Error ? err.message : String(err) }, '跳过不安全的图片 URL');
      }
    }

    const results = await Promise.allSettled(
      safeUrls.map(url => this.extractText(url)),
    );

    return results
      .map(r => r.status === 'fulfilled' ? r.value : null)
      .filter(Boolean)
      .join(' ');
  }
}
