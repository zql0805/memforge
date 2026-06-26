// Created by dev on 2026/05/25
// P5: VFS 格式化器 — 将知识条目格式化为文件系统视图

import type { KnowledgeItem, KnowledgeCategory } from '@memforgeai/shared';
import { buildVfsUri } from './resolver.js';

export interface VfsDirectoryEntry {
  name: string;
  type: 'directory' | 'file';
  uri: string;
  size?: number;
  updatedAt?: string;
  metadata?: {
    knowledgeType?: string;
    status?: string;
    helpfulCount?: number;
  };
}

export interface VfsDirectoryListing {
  path: string;
  uri: string;
  entries: VfsDirectoryEntry[];
  total: number;
}

export function formatDirectoryListing(
  categoryPath: string,
  subcategories: KnowledgeCategory[],
  items: KnowledgeItem[],
): VfsDirectoryListing {
  const entries: VfsDirectoryEntry[] = [];

  for (const cat of subcategories) {
    const childPath = cat.fullPath || (categoryPath === '/' ? `/${cat.slug}` : `${categoryPath}/${cat.slug}`);
    entries.push({
      name: `${cat.name}/`,
      type: 'directory',
      uri: buildVfsUri(childPath),
      metadata: { knowledgeType: 'category' },
    });
  }

  for (const item of items) {
    const slug = (item as unknown as Record<string, unknown>).slug as string || item.id;
    entries.push({
      name: `${slug}.md`,
      type: 'file',
      uri: buildVfsUri(categoryPath, slug),
      size: item.content.length,
      updatedAt: item.updatedAt.toISOString(),
      metadata: {
        knowledgeType: item.knowledgeType,
        status: item.status,
        helpfulCount: item.helpfulCount,
      },
    });
  }

  return {
    path: categoryPath,
    uri: buildVfsUri(categoryPath),
    entries,
    total: entries.length,
  };
}

export function formatAsMarkdown(item: KnowledgeItem): string {
  const parts: string[] = [];

  parts.push(`---`);
  parts.push(`title: ${item.title}`);
  if (item.knowledgeType) parts.push(`type: ${item.knowledgeType}`);
  if (item.category) parts.push(`category: ${item.category}`);
  if (item.tags.length > 0) parts.push(`tags: [${item.tags.join(', ')}]`);
  parts.push(`status: ${item.status}`);
  parts.push(`verified: ${item.verifiedBy != null}`);
  parts.push(`helpful: ${item.helpfulCount}/${item.helpfulCount + item.unhelpfulCount}`);
  parts.push(`updated: ${item.updatedAt.toISOString()}`);
  parts.push(`---`);
  parts.push('');

  if (item.question) {
    parts.push(`## 问题`);
    parts.push(item.question);
    parts.push('');
  }

  if (item.summary) {
    parts.push(`## 摘要`);
    parts.push(item.summary);
    parts.push('');
  }

  parts.push(`## 内容`);
  parts.push(item.content);

  if (item.media && item.media.length > 0) {
    parts.push('');
    parts.push(`## 附件`);
    for (const m of item.media) {
      parts.push(`- [${m.description || m.type}](${m.url})`);
    }
  }

  return parts.join('\n');
}
