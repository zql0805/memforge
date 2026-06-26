// Created by dev on 2026/04/12
// Copyright © 2026

import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import { TaskStore } from '../storage/task-store.js';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:task-import');

const TASK_BLOCK_RE = /^\d+[、.]\s*(.+?)(?=\n\d+[、.]|\n*$)/gms;

function parseTaskCommentMeta(content: string): Map<number, { status?: string; note?: string }> {
  const map = new Map<number, { status?: string; note?: string }>();
  const re = /<!--\s*task-(\d+)\s+([\s\S]*?)\s*-->/g;
  for (const m of content.matchAll(re)) {
    const n = parseInt(m[1]!, 10);
    const inner = m[2]!;
    const statusMatch = inner.match(/status:\s*([^,\s]+)/i);
    const noteMatch = inner.match(/note:\s*(.+)/i);
    map.set(n, {
      status: statusMatch?.[1]?.trim().toLowerCase(),
      note: noteMatch?.[1]?.trim(),
    });
  }
  return map;
}

function extractTitle(block: string): string {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines[0] ?? block.trim()) || 'Untitled';
}

export function registerImportTasksFromPlan(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'import_tasks_from_plan',
    '从 plan 文件批量导入任务到任务系统',
    {
      file_path: z.string(),
      product_line: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    async (params) => {
      try {
        if (!params.dry_run && !ctx.userId) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: '当前会话未绑定用户，无法导入任务（可 dry_run 预演）' }),
            }],
            isError: true,
          };
        }

        const raw = await readFile(params.file_path, 'utf8');
        const metaByNum = parseTaskCommentMeta(raw);

        const blocks: string[] = [];
        const re = new RegExp(TASK_BLOCK_RE.source, 'gms');
        let bm: RegExpExecArray | null;
        while ((bm = re.exec(raw)) !== null) {
          blocks.push(bm[1].trim());
        }

        const parsed = blocks.length;
        let created = 0;
        let skipped_completed = 0;

        const taskStore = new TaskStore();

        for (let i = 0; i < blocks.length; i++) {
          const taskNum = i + 1;
          const title = extractTitle(blocks[i]!);
          const meta = metaByNum.get(taskNum);
          const status = meta?.status;

          if (status === 'completed') {
            skipped_completed += 1;
            continue;
          }

          if (params.dry_run) {
            continue;
          }

          const descriptionParts = [meta?.note].filter(Boolean);
          await taskStore.createTask({
            user_id: ctx.userId!,
            title,
            description: descriptionParts.length ? descriptionParts.join('\n') : undefined,
            product_line: params.product_line,
            created_by: ctx.userId!,
          });
          created += 1;
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, parsed, created, skipped_completed }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'import_tasks_from_plan failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
