// Created by dev on 2026/06/04
// 从 code-context MCP 工具提取的可复用组装逻辑，供 MCP 和 REST API 共用

import type { KBSearchResult } from '@memforgeai/shared';

export interface AssembledCodeContext {
  markdown: string;
  itemCount: number;
  truncated: boolean;
}

export function assembleCodeContext(query: string, items: KBSearchResult[], maxChars: number): AssembledCodeContext {
  const overviews: KBSearchResult[] = [];
  const modules: KBSearchResult[] = [];
  const others: KBSearchResult[] = [];

  for (const item of items) {
    const title = item.title ?? '';
    if (title.includes('项目概览') || title.includes('Project Overview') || title.includes('项目档案') || title.includes('Full Passport')) {
      overviews.push(item);
    } else if (title.includes('模块档案') || title.includes('Module Passport')) {
      modules.push(item);
    } else {
      others.push(item);
    }
  }

  const lines: string[] = [];
  lines.push(`## Code Context\n`);
  lines.push(`**Query:** ${query}\n`);
  lines.push(`**匹配条目:** ${items.length} 条（${overviews.length} 概览 + ${modules.length} 模块 + ${others.length} 其他）\n`);

  let charCount = lines.join('\n').length;
  let truncated = false;
  let includedCount = 0;

  const orderedItems = [...overviews, ...modules, ...others];

  for (const item of orderedItems) {
    const section = formatItem(item);
    if (charCount + section.length > maxChars && includedCount > 0) {
      truncated = true;
      const remaining = orderedItems.length - includedCount;
      lines.push(`\n---\n*（已截断，还有 ${remaining} 条相关知识未展示。可通过 search_knowledge 单独查询。）*`);
      break;
    }
    lines.push(section);
    charCount += section.length;
    includedCount++;
  }

  return { markdown: lines.join('\n'), itemCount: includedCount, truncated };
}

function formatItem(item: KBSearchResult): string {
  const lines: string[] = [];
  const confidence = typeof item.confidence === 'number' ? `${Math.round(item.confidence * 100)}%` : '?';

  lines.push(`\n### ${item.title ?? 'Untitled'}`);
  lines.push(`> confidence: ${confidence} | category: ${item.category ?? '-'} | type: ${item.knowledgeType ?? '-'}`);

  if (item.summary) {
    lines.push(`\n${item.summary}`);
  } else if (item.content) {
    lines.push(`\n${item.content}`);
  }

  lines.push('');
  return lines.join('\n');
}
