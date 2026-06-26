// Created by dev on 2026/05/25
import type { DingTalkBlock } from './dingtalk-client.js';

/**
 * 钉钉文档 block JSON → Markdown 转换器
 *
 * 钉钉 API 返回扁平化 block 数组，每个 block 的文本在 block[blockType] 子对象中。
 * 示例：{ blockType: "paragraph", paragraph: { text: "..." }, index: 0, id: "..." }
 */
export function blocksToMarkdown(blocks: DingTalkBlock[]): string {
  if (!blocks || blocks.length === 0) return '';

  const sorted = [...blocks].sort((a, b) => ((a as Record<string, unknown>).index as number ?? 0) - ((b as Record<string, unknown>).index as number ?? 0));
  const lines: string[] = [];
  for (const block of sorted) {
    const md = convertBlock(block);
    if (md !== null) lines.push(md);
  }
  return lines.join('\n').trim();
}

function getBlockContent(block: DingTalkBlock): Record<string, unknown> | null {
  const type = block.blockType;
  if (!type) return null;
  return (block as unknown as Record<string, unknown>)[type] as Record<string, unknown> ?? null;
}

function getBlockText(block: DingTalkBlock): string {
  const content = getBlockContent(block);
  if (!content) {
    if (block.text) return block.text;
    return '';
  }
  return (content.text as string) ?? '';
}

function convertBlock(block: DingTalkBlock): string | null {
  const type = block.blockType?.toLowerCase() ?? '';
  const text = getBlockText(block);

  switch (type) {
    case 'heading': {
      const content = getBlockContent(block);
      const level = (content?.level as number) ?? 1;
      const prefix = '#'.repeat(Math.min(level, 6));
      return `${prefix} ${text}`;
    }
    case 'heading1':
    case 'header1':
      return `# ${text}`;
    case 'heading2':
    case 'header2':
      return `## ${text}`;
    case 'heading3':
    case 'header3':
      return `### ${text}`;
    case 'heading4':
    case 'header4':
      return `#### ${text}`;

    case 'paragraph':
    case 'text':
      return text;

    case 'unorderedlist':
    case 'bulletlist':
      return `- ${text}`;

    case 'orderedlist':
    case 'numberlist': {
      const content = getBlockContent(block);
      const order = (content?.order as number) ?? 1;
      return `${order}. ${text}`;
    }

    case 'codeblock':
    case 'code_block':
    case 'code': {
      const content = getBlockContent(block);
      const lang = (content?.language as string) ?? '';
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }

    case 'blockquote':
    case 'quote':
    case 'callout':
      return text.split('\n').map(l => `> ${l}`).join('\n');

    case 'image': {
      const content = getBlockContent(block);
      const url = (content?.url as string) ?? (content?.src as string) ?? '';
      const alt = (content?.alt as string) ?? (content?.caption as string) ?? '';
      return url ? `![${alt}](${url})` : null;
    }

    case 'table': {
      const content = getBlockContent(block);
      return convertTable(content);
    }

    case 'horizontalrule':
    case 'divider':
    case 'hr':
      return '---';

    case 'todolist':
    case 'checklist':
    case 'task_list': {
      const content = getBlockContent(block);
      const checked = (content?.checked as boolean) ?? false;
      return `- [${checked ? 'x' : ' '}] ${text}`;
    }

    case 'link': {
      const content = getBlockContent(block);
      const href = (content?.href as string) ?? (content?.url as string) ?? '';
      return href ? `[${text}](${href})` : text;
    }

    default:
      if (text) return text;
      return null;
  }
}

function convertTable(content: Record<string, unknown> | null): string | null {
  if (!content) return null;

  // 钉钉表格格式: { cells: string[][], colSize: number, rowSize: number }
  const cells = content.cells as string[][] | undefined;
  if (!cells?.length) {
    if (content.text) return String(content.text);
    return null;
  }

  const mdRows = cells.map(row => {
    const formatted = row.map(cell => (cell ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '));
    return `| ${formatted.join(' | ')} |`;
  });

  if (mdRows.length === 0) return null;

  const colCount = cells[0]?.length ?? 1;
  const separator = `| ${Array(colCount).fill('---').join(' | ')} |`;

  return [mdRows[0], separator, ...mdRows.slice(1)].join('\n');
}
