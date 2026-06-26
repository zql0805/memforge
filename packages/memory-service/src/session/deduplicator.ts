// Created by dev on 2026/05/25
// P4-B: 向量 + LLM 双重去重

import { getLogger } from '@memforgeai/shared';
import type { MemoryEntry, ApiEmbeddingService, VisibilityFilterParams } from '@memforgeai/shared';
import type { PostgresStorage } from '../storage/postgres.js';
import type { ExtractedMemory } from './extractor.js';
import { DEDUP_SYSTEM_PROMPT } from './prompts.js';

const logger = getLogger('session:deduplicator');

export type DeduplicateAction = 'SKIP' | 'CREATE' | 'MERGE' | 'DELETE';

export interface DeduplicateResult {
  action: DeduplicateAction;
  reason: string;
  mergeWithId?: string;
  mergedContent?: string;
}

interface LLMProvider {
  chat(messages: Array<{ role: string; content: string }>, options?: { signal?: AbortSignal }): Promise<string>;
}

export class MemoryDeduplicator {
  constructor(
    private readonly storage: PostgresStorage,
    private readonly embedding: ApiEmbeddingService,
    private readonly llm: LLMProvider,
    private readonly vectorThreshold = 0.85,
  ) {}

  async deduplicate(
    memory: ExtractedMemory,
    projectId: string,
    visibility?: VisibilityFilterParams,
  ): Promise<DeduplicateResult> {
    const queryEmbedding = await this.embedding.embedQuery(
      `${memory.title}\n${memory.content}`,
    );

    const similar = await this.storage.searchByEmbedding(
      queryEmbedding, [projectId], null, 3, this.vectorThreshold,
      {
        scopeFilter: [memory.scope],
        orgId: visibility?.orgId,
        userId: visibility?.userId,
        teamIds: visibility?.teamIds,
        accessibleProductLines: visibility?.accessibleProductLines,
      },
    );

    if (similar.length === 0) {
      return { action: 'CREATE', reason: '无相似记忆' };
    }

    const existingEntries: MemoryEntry[] = [];
    for (const hit of similar) {
      const entry = await this.storage.getById(hit.id);
      if (entry) existingEntries.push(entry);
    }

    if (existingEntries.length === 0) {
      return { action: 'CREATE', reason: '相似结果已被删除' };
    }

    try {
      const prompt = buildDedupPrompt(memory, existingEntries);
      const response = await this.llm.chat([
        { role: 'system', content: DEDUP_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ]);
      return parseDedupResponse(response, existingEntries);
    } catch (err) {
      logger.warn({ err }, 'LLM 去重失败，回退到向量去重');
      const topSimilarity = similar[0].similarity;
      if (topSimilarity > 0.95) {
        return { action: 'SKIP', reason: `向量相似度 ${topSimilarity.toFixed(3)} > 0.95` };
      }
      return { action: 'CREATE', reason: `向量相似度 ${topSimilarity.toFixed(3)} 不够高，保留` };
    }
  }
}

function buildDedupPrompt(newMemory: ExtractedMemory, existing: MemoryEntry[]): string {
  const existingDesc = existing.map((e, i) =>
    `### 已有记忆 ${i + 1} (ID: ${e.id})\n- 标题: ${e.title}\n- 内容: ${e.content.slice(0, 1000)}\n- Scope: ${e.scope}`,
  ).join('\n\n');

  return `## 新记忆\n- 标题: ${newMemory.title}\n- 内容: ${newMemory.content}\n- Scope: ${newMemory.scope}\n\n## 已有相似记忆\n\n${existingDesc}\n\n请判断新记忆的处理方式。`;
}

function parseDedupResponse(response: string, existing: MemoryEntry[]): DeduplicateResult {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { action: 'CREATE', reason: 'LLM 响应格式异常，默认创建' };

    const parsed = JSON.parse(jsonMatch[0]);
    const action = (['SKIP', 'CREATE', 'MERGE', 'DELETE'].includes(parsed.action)
      ? parsed.action : 'CREATE') as DeduplicateAction;

    const result: DeduplicateResult = {
      action,
      reason: String(parsed.reason || ''),
    };

    if (action === 'MERGE' && parsed.merge_with_id) {
      const validId = existing.find(e => e.id === parsed.merge_with_id);
      if (validId) {
        result.mergeWithId = parsed.merge_with_id;
        result.mergedContent = parsed.merged_content;
      } else {
        result.action = 'CREATE';
        result.reason = 'MERGE 目标 ID 无效，改为创建';
      }
    }

    return result;
  } catch {
    return { action: 'CREATE', reason: 'LLM 去重响应解析失败，默认创建' };
  }
}
