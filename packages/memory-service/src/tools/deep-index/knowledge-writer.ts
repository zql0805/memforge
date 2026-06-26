// Created by dev on 2026/06/02
// deep-index 知识写入层 — 将 LLM 分析结果批量存入 knowledge_items

import { getLogger } from '@memforgeai/shared';
import type { KnowledgeItem } from './llm-analyzer.js';

const logger = getLogger('deep-index:writer');

const KNOWLEDGE_SERVICE_URL = process.env.KNOWLEDGE_SERVICE_URL || 'http://127.0.0.1:3003';

const SYSTEM_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'x-memforge-user-id': 'system:deep-index',
  'x-memforge-user-role': 'admin',
};

export interface WriteOptions {
  projectId: string;
  productLine?: string;
  teamId?: string;
  orgId?: string;
  visibility?: string;
  /** 写入前先按 source_ref 前缀清理旧条目 */
  cleanBefore?: boolean;
}

export interface WriteResult {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  errors: Array<{ title: string; error: string }>;
}

/**
 * 批量写入 knowledge_items。
 * 每个 KnowledgeItem 映射为一个 knowledge_items 行，
 * source_ref 使用 `deep_index:<level>:<category>` 格式，便于后续去重和生命周期管理。
 */
export async function writeKnowledgeItems(
  items: KnowledgeItem[],
  opts: WriteOptions,
): Promise<WriteResult> {
  const result: WriteResult = { total: items.length, success: 0, failed: 0, skipped: 0, errors: [] };

  // 默认写入前清理旧条目（通过 source_ref 前缀去重）
  if (opts.cleanBefore !== false) {
    await cleanStaleItems(opts);
  }

  // 并发限制：同时最多 5 个写入
  const concurrency = 5;
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        const ok = await writeOne(item, opts);
        if (ok) {
          result.success++;
        } else {
          result.failed++;
          result.errors.push({ title: item.title, error: 'HTTP 非 200' });
        }
      } catch (err) {
        result.failed++;
        result.errors.push({ title: item.title, error: (err as Error).message });
      }
    }
  });

  await Promise.all(workers);

  logger.info(
    { total: result.total, success: result.success, failed: result.failed },
    `知识写入完成: ${opts.projectId}`,
  );
  return result;
}

const MAX_SHORT = 120;
const MAX_REF = 200;
const MAX_TAG = 100;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

async function writeOne(item: KnowledgeItem, opts: WriteOptions): Promise<boolean> {
  const title = truncate(item.title, MAX_SHORT);
  const body = {
    project_id: opts.projectId,
    product_line: opts.productLine,
    team_id: opts.teamId,
    org_id: opts.orgId,
    knowledge_type: mapKnowledgeType(item),
    title,
    summary: item.summary ?? null,
    question: item.summary ? truncate(item.summary, MAX_SHORT) : title,
    answer: item.content,
    source_type: 'api_scan',
    source_ref: truncate(`deep_index:${item.level}:${item.category}`, MAX_REF),
    tags: (item.tags ?? []).map(t => truncate(t, MAX_TAG)),
    category: truncate(item.category ?? '', MAX_SHORT),
    visibility: opts.visibility ?? 'product_line',
    status: 'published',
    metadata: item.metadata,
  };

  const resp = await fetch(`${KNOWLEDGE_SERVICE_URL}/api/knowledge/store`, {
    method: 'POST',
    headers: SYSTEM_HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    let errBody = '';
    try { errBody = await resp.text(); } catch { /* ignore */ }
    logger.warn({ status: resp.status, title: item.title, errBody: errBody.slice(0, 500) }, '写入 knowledge_items 失败');
    return false;
  }
  return true;
}

/**
 * 清理旧的 deep_index 条目（按 project_id + source_ref 前缀过滤）。
 * 每次写入前自动调用，通过 source_ref 前缀 "deep_index:" 精确匹配。
 */
async function cleanStaleItems(opts: WriteOptions): Promise<void> {
  try {
    const resp = await fetch(`${KNOWLEDGE_SERVICE_URL}/api/knowledge/cleanup`, {
      method: 'POST',
      headers: SYSTEM_HEADERS,
      body: JSON.stringify({
        project_id: opts.projectId,
        source_type: 'api_scan',
        source_ref_prefix: `deep_index:`,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (resp.ok) {
      const data = await resp.json() as { deleted?: number };
      logger.info({ deleted: data.deleted ?? 0, projectId: opts.projectId }, '已清理旧知识条目');
    } else {
      logger.warn({ status: resp.status }, '清理旧知识条目失败，继续写入（可能产生重复）');
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '清理请求异常');
  }
}

function mapKnowledgeType(item: KnowledgeItem): string {
  switch (item.level) {
    case 'L0': return 'technical';
    case 'L1': return 'technical';
    case 'L2': return 'technical';
    case 'BIZ': return 'how_to';
    default: return 'technical';
  }
}
