// Created by dev on 2026/05/25
// P4-B: LLM 驱动的会话记忆自动提取

import { getLogger, MemoryScope } from '@memforgeai/shared';
import { EXTRACTION_SYSTEM_PROMPT } from './prompts.js';

const logger = getLogger('session:extractor');

export interface ExtractedMemory {
  title: string;
  content: string;
  scope: MemoryScope;
  tags: string[];
  visibility: 'personal' | 'team' | 'product_line' | 'global';
}

export interface ExtractionResult {
  memories: ExtractedMemory[];
  tokenUsage?: { prompt: number; completion: number };
}

interface LLMProvider {
  chat(messages: Array<{ role: string; content: string }>, options?: { signal?: AbortSignal }): Promise<string>;
}

export class SessionExtractor {
  constructor(private readonly llm: LLMProvider) {}

  async extract(sessionContent: string): Promise<ExtractionResult> {
    if (!sessionContent || sessionContent.trim().length < 100) {
      logger.debug('Session too short, skipping extraction');
      return { memories: [] };
    }

    const truncated = sessionContent.length > 30000
      ? sessionContent.slice(0, 15000) + '\n\n...[中间内容省略]...\n\n' + sessionContent.slice(-15000)
      : sessionContent;

    const userMsg = `请分析以下对话并提取有价值的记忆。只返回 JSON 数组，不要用 markdown code block 包裹：\n\n${truncated}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const messages = [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ];

        if (attempt > 0) {
          messages.push(
            { role: 'assistant', content: '```json\n[' },
            { role: 'user', content: '格式错误。请直接返回 JSON 数组，不要用 code block 包裹。示例: [{"title":"...","content":"...","scope":"bug_pattern","tags":[],"visibility":"personal"}]' },
          );
        }

        const response = await this.llm.chat(messages, { signal: AbortSignal.timeout(180_000) });
        const memories = parseExtractionResponse(response);

        if (memories.length > 0 || attempt > 0) {
          logger.info({ count: memories.length, attempt }, '会话记忆提取完成');
          return { memories };
        }

        logger.debug({ attempt, responsePreview: response.substring(0, 200) }, '首次提取结果为空，重试');
      } catch (err) {
        logger.error({ err, attempt }, '会话记忆提取失败');
        if (attempt > 0) return { memories: [] };
      }
    }

    return { memories: [] };
  }
}

function parseExtractionResponse(response: string): ExtractedMemory[] {
  try {
    const parsed = extractJsonArray(response);
    if (!parsed) {
      logger.warn({ responsePreview: response.substring(0, 300) }, 'LLM 响应中未找到有效 JSON 数组');
      return [];
    }

    const scopeAliases: Record<string, MemoryScope> = {
      '架构决策': 'architecture' as MemoryScope,
      '架构': 'architecture' as MemoryScope,
      'bug模式': 'bug_pattern' as MemoryScope,
      'bug_模式': 'bug_pattern' as MemoryScope,
      'Bug模式': 'bug_pattern' as MemoryScope,
      '经验教训': 'lesson_learned' as MemoryScope,
      '编码规范': 'coding_standard' as MemoryScope,
      '用户画像': 'user_profile' as MemoryScope,
      '实体引用': 'entity_reference' as MemoryScope,
      '性能优化': 'performance_insight' as MemoryScope,
      '约定': 'convention' as MemoryScope,
      '领域知识': 'domain_knowledge' as MemoryScope,
      '问题方案': 'problem_solution' as MemoryScope,
      '故障复盘': 'failure_postmortem' as MemoryScope,
    };

    const results: ExtractedMemory[] = [];
    for (const m of parsed) {
      const raw = m as Record<string, unknown>;
      if (!raw.title || !raw.content) continue;

      const rawScope = String(raw.scope ?? '');
      const parseResult = MemoryScope.safeParse(rawScope);
      const scope = parseResult.success
        ? parseResult.data
        : scopeAliases[rawScope];
      if (!scope) continue;

      results.push({
        title: String(raw.title).slice(0, 200),
        content: String(raw.content).slice(0, 5000),
        scope,
        tags: normalizeTags(raw.tags),
        visibility: normalizeVisibility(raw.visibility),
      });
    }
    return results;
  } catch {
    logger.warn({ responsePreview: response.substring(0, 300) }, 'Failed to parse LLM extraction response');
    return [];
  }
}

function normalizeVisibility(raw: unknown): ExtractedMemory['visibility'] {
  const valid: ExtractedMemory['visibility'][] = ['personal', 'team', 'product_line', 'global'];
  if (valid.includes(raw as ExtractedMemory['visibility'])) return raw as ExtractedMemory['visibility'];
  const aliases: Record<string, ExtractedMemory['visibility']> = {
    'public': 'global', 'project': 'personal', '个人': 'personal',
    '团队': 'team', '产品线': 'product_line', '全局': 'global',
  };
  return aliases[String(raw)] ?? 'personal';
}

function normalizeTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter(t => typeof t === 'string').slice(0, 10);
  if (typeof raw === 'string') return raw.split(/[,，;；\s]+/).filter(Boolean).slice(0, 10);
  return [];
}

function sanitizeForJson(text: string): string {
  return text
    .replace(/\uFFFD/g, '')           // 移除 U+FFFD 替换字符 (�)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // 移除不可打印控制字符
    .replace(/"\s+"(title|content|scope|tags|visibility)"\s*:/gi, '"$1":'); // 修复 " "content": → "content":
}

function extractJsonArray(text: string): Record<string, unknown>[] | null {
  const sanitized = sanitizeForJson(text);
  const codeBlockRe = /```\s*(?:json)?\s*\n?([\s\S]*?)```/;

  // 1. 尝试从 markdown code block 中提取
  const codeBlockMatch = sanitized.match(codeBlockRe);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    const result = tryParseArray(inner);
    if (result) return result;
  }

  // 2. 直接匹配 JSON 数组
  const arrayMatch = sanitized.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    const result = tryParseArray(arrayMatch[0]);
    if (result) return result;
  }

  // 3. 去除 code block 标记后再尝试
  const cleaned = sanitized.replace(codeBlockRe, '$1').replace(/```/g, '').trim();
  const cleanedMatch = cleaned.match(/\[[\s\S]*\]/);
  if (cleanedMatch) {
    const result = tryParseArray(cleanedMatch[0]);
    if (result) return result;
  }

  // 4. 逐个提取完整的 JSON 对象（应对截断/乱码的数组）
  const objects = extractIndividualObjects(sanitized);
  if (objects.length > 0) return objects;

  return null;
}

function flattenNestedArrays(arr: unknown[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const item of arr) {
    if (Array.isArray(item)) {
      result.push(...flattenNestedArrays(item));
    } else if (item && typeof item === 'object') {
      result.push(item as Record<string, unknown>);
    }
  }
  return result;
}

function tryParseArray(raw: string): Record<string, unknown>[] | null {
  const attempts = [
    raw,
    raw.replace(/,\s*([\]}])/g, '$1'),  // 修复尾部逗号
  ];

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (Array.isArray(parsed)) {
        return flattenNestedArrays(parsed);
      }
    } catch { /* fall through */ }
  }

  return null;
}

function extractIndividualObjects(text: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        const parsed = repairAndParse(candidate);
        if (parsed && parsed.title && parsed.content) {
          results.push(parsed);
        }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }

  return results;
}

function repairAndParse(raw: string): Record<string, unknown> | null {
  // 直接尝试
  try { return JSON.parse(raw); } catch { /* fall through */ }

  let fixed = raw;

  // 修复未闭合的数组括号
  const openBrackets = (fixed.match(/\[/g) ?? []).length;
  const closeBrackets = (fixed.match(/\]/g) ?? []).length;
  if (openBrackets > closeBrackets) {
    fixed = fixed.replace(/(\[[^\]]*?)(\s*"(?:visibility|scope|title|content)")/g, '$1],$2');
  }

  // 修复尾部逗号
  fixed = fixed.replace(/,\s*([\]}])/g, '$1');

  // 修复 "tags": "string" → "tags": ["string"]（非数组情况）
  fixed = fixed.replace(/"tags"\s*:\s*"([^"]+)"/g, (_, v) => {
    const items = v.split(/[,，;；]+/).map((s: string) => `"${s.trim()}"`).join(',');
    return `"tags": [${items}]`;
  });

  try { return JSON.parse(fixed); } catch { /* fall through */ }

  // 尝试用正则逐字段提取（应对无法修复的 JSON 结构）
  return extractFieldsFromBrokenJson(fixed);
}

function extractFieldsFromBrokenJson(text: string): Record<string, unknown> | null {
  const titleMatch = text.match(/"title"\s*:\s*"([^"]{1,200})"/);
  const contentMatch = text.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
  const scopeMatch = text.match(/"scope"\s*:\s*"([^"]+)"/);
  const tagsMatch = text.match(/"tags"\s*:\s*\[([^\]]*)\]/);
  const visibilityMatch = text.match(/"visibility"\s*:\s*"([^"]+)"/);

  if (!titleMatch || !contentMatch) return null;

  const result: Record<string, unknown> = {
    title: titleMatch[1],
    content: contentMatch[1].replace(/\\"/g, '"'),
    scope: scopeMatch ? scopeMatch[1] : 'lesson_learned',
  };

  if (tagsMatch) {
    const tags = tagsMatch[1].match(/"([^"]+)"/g);
    result.tags = tags ? tags.map(t => t.replace(/"/g, '')) : [];
  } else {
    result.tags = [];
  }

  if (visibilityMatch) result.visibility = visibilityMatch[1];

  return result;
}
