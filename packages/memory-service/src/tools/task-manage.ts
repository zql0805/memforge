// Created by dev on 2026/04/08
// Copyright © 2026
// MCP 工具: manage_agent_tasks — Agent 任务写操作的统一入口
// 合并 create_agent_task / update_agent_task / batch_update_tasks /
// log_task_progress / import_tasks_from_plan 5 个工具，降低 AI 误用率

import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, validateScanPath } from '@memforgeai/shared';
import { TaskStore, type RelatedItem } from '../storage/task-store.js';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:task-manage');

const relatedItemSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  value: z.string().optional(),
  path: z.string().optional(),
  title: z.string().optional(),
});

function normalizeRelatedItems(
  items: z.infer<typeof relatedItemSchema>[] | undefined,
): RelatedItem[] | undefined {
  if (!items?.length) return undefined;
  return items.map((it) => ({
    type: it.type as RelatedItem['type'],
    id: it.id,
    value: it.value,
    path: it.path,
    title: it.title,
  }));
}

// ─── plan 文件解析（同 task-import.ts 保持一致）───────────────────────────
const TASK_BLOCK_RE = /^- \*\*(.+?)\*\*/m;

function extractTitle(block: string): string {
  const m = TASK_BLOCK_RE.exec(block);
  return m?.[1] ?? block.split('\n')[0] ?? '未命名任务';
}

interface TaskCommentMeta { status?: string; note?: string }

function parseTaskCommentMeta(raw: string): Map<number, TaskCommentMeta> {
  const metaByNum = new Map<number, TaskCommentMeta>();
  const lines = raw.split('\n');
  for (const line of lines) {
    const m = /<!--\s*task:(\d+)\s+(.*?)\s*-->/.exec(line);
    if (!m) continue;
    const num = parseInt(m[1]!, 10);
    const parts = m[2]!.split(/\s+/);
    const meta: TaskCommentMeta = {};
    for (const p of parts) {
      const [k, v] = p.split('=');
      if (k === 'status') meta.status = v;
      if (k === 'note') meta.note = v?.replace(/_/g, ' ');
    }
    metaByNum.set(num, meta);
  }
  return metaByNum;
}

export function registerManageAgentTasks(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'manage_agent_tasks',
    [
      'Agent 任务写操作的统一入口，通过 action 字段路由到对应操作：',
      '• create       — 创建新任务（替代 create_agent_task）',
      '• update       — 更新任务状态/内容（替代 update_agent_task）',
      '• batch_update — 批量更新多个任务（替代 batch_update_tasks）',
      '• log          — 记录任务执行日志（替代 log_task_progress）',
      '• import_plan  — 从 plan 文件导入任务（替代 import_tasks_from_plan）',
    ].join('\n'),
    {
      action: z.enum(['create', 'update', 'batch_update', 'log', 'import_plan']).describe(
        '操作类型：create/update/batch_update/log/import_plan',
      ),

      // ─── create 参数 ──────────────────────────────────────────────
      title: z.string().optional().describe('[create] 任务标题（必填）'),
      description: z.string().optional().describe('[create/update] 任务描述'),
      category: z.string().optional().describe('[create/update] 分类'),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('[create/update] 优先级'),
      status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'suspended']).optional().describe('[create] 初始状态，默认 pending；[update] 新状态'),
      product_line: z.string().optional().describe('[create/update] 产品线'),
      project: z.string().optional().describe('[create/update] 项目'),
      tags: z.array(z.string()).optional().describe('[create/update] 标签'),
      related_items: z.array(relatedItemSchema).optional().describe('[create/update] 关联资源'),
      sort_order: z.number().optional().describe('[create/update] 排序值'),

      // ─── update 参数 ──────────────────────────────────────────────
      task_id: z.number().optional().describe('[update/log] 任务 ID（必填）'),
      execution_summary: z.string().optional().describe('[update] 执行摘要'),
      execution_issues: z.string().optional().describe('[update/batch_update] 执行中遇到的问题'),
      conversation_id: z.string().optional().describe('[update] 对话 ID'),
      history_file_path: z.string().optional().describe('[update] 历史文件路径'),
      heartbeat: z.boolean().optional().describe('[update] 更新心跳时间戳'),
      expected_updated_at: z.string().optional().describe('[update] 乐观锁：预期 updated_at'),

      // ─── batch_update 参数 ───────────────────────────────────────
      task_ids: z.array(z.number()).max(100).optional().describe('[batch_update] 要批量更新的任务 ID 列表（必填，最多 100 个）'),
      batch_status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'suspended']).optional().describe('[batch_update] 批量目标状态'),
      batch_category: z.string().optional().describe('[batch_update] 批量目标分类'),
      batch_priority: z.string().optional().describe('[batch_update] 批量目标优先级'),

      // ─── log 参数 ────────────────────────────────────────────────
      message: z.string().optional().describe('[log] 日志消息（必填）'),
      level: z.enum(['info', 'warn', 'error', 'debug']).optional().describe('[log] 日志级别，默认 info'),
      metadata: z.record(z.unknown()).optional().describe('[log] 元数据'),

      // ─── import_plan 参数 ────────────────────────────────────────
      file_path: z.string().optional().describe('[import_plan] plan 文件路径（必填）'),
      dry_run: z.boolean().optional().describe('[import_plan] 仅预演，不实际创建'),
    },
    async (params) => {
      try {
        const taskStore = new TaskStore();

        switch (params.action) {
          case 'create': {
            if (!params.title) {
              return errResult('create 操作必须提供 title');
            }
            if (!ctx.userId) {
              return errResult('当前会话未绑定用户，无法创建任务');
            }
            const task = await taskStore.createTask({
              user_id: ctx.userId,
              title: params.title,
              description: params.description,
              category: params.category,
              priority: params.priority,
              status: (params.status as 'pending' | 'suspended' | undefined),
              product_line: params.product_line,
              project: params.project,
              tags: params.tags,
              related_items: normalizeRelatedItems(params.related_items),
              sort_order: params.sort_order,
              created_by: ctx.userId,
            });
            return ok({ task });
          }

          case 'update': {
            if (!params.task_id) return errResult('update 操作必须提供 task_id');
            const task = await taskStore.updateTask({
              task_id: params.task_id,
              status: params.status as 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'suspended' | undefined,
              title: params.title,
              description: params.description,
              category: params.category,
              product_line: params.product_line,
              project: params.project,
              execution_summary: params.execution_summary,
              execution_issues: params.execution_issues,
              conversation_id: params.conversation_id,
              history_file_path: params.history_file_path,
              priority: params.priority,
              tags: params.tags,
              related_items: normalizeRelatedItems(params.related_items),
              sort_order: params.sort_order,
              heartbeat: params.heartbeat,
              expected_updated_at: params.expected_updated_at,
              userId: ctx.userId,
              userRole: ctx.userRole,
            });
            return ok({ task });
          }

          case 'batch_update': {
            if (!params.task_ids?.length) return errResult('batch_update 操作必须提供 task_ids');
            const updates: Record<string, unknown> = {};
            if (params.batch_status !== undefined) updates.status = params.batch_status;
            if (params.batch_category !== undefined) updates.category = params.batch_category;
            if (params.batch_priority !== undefined) updates.priority = params.batch_priority;
            if (params.execution_issues !== undefined) updates.execution_issues = params.execution_issues;
            const result = await taskStore.batchUpdateTasks(
              params.task_ids,
              updates,
              ctx.userId,
              ctx.userRole,
            );
            return ok({ affected: result.affected, failed: result.failed });
          }

          case 'log': {
            if (!params.task_id) return errResult('log 操作必须提供 task_id');
            if (!params.message) return errResult('log 操作必须提供 message');
            await taskStore.logProgress({
              task_id: params.task_id,
              message: params.message,
              level: params.level,
              metadata: params.metadata,
            });
            return ok({ logged: true });
          }

          case 'import_plan': {
            if (!params.file_path) return errResult('import_plan 操作必须提供 file_path');
            if (!params.dry_run && !ctx.userId) {
              return errResult('当前会话未绑定用户，无法导入任务（可 dry_run 预演）');
            }
            let planPath: string;
            try {
              planPath = validateScanPath(params.file_path);
            } catch (err) {
              return errResult((err as Error).message);
            }
            const raw = await readFile(planPath, 'utf8');
            const metaByNum = parseTaskCommentMeta(raw);
            const blocks: string[] = [];
            const re = /^- \*\*(.+?)\*\*/gm;
            // 使用行扫描方式提取任务块
            const taskLines = raw.split('\n').filter(l => /^- \*\*/.test(l));
            for (const line of taskLines) {
              blocks.push(line);
            }
            let created = 0;
            let skipped_completed = 0;
            for (let i = 0; i < blocks.length; i++) {
              const taskNum = i + 1;
              const title = extractTitle(blocks[i]!);
              const meta = metaByNum.get(taskNum);
              if (meta?.status === 'completed') { skipped_completed++; continue; }
              if (!params.dry_run) {
                await taskStore.createTask({
                  user_id: ctx.userId!,
                  title,
                  description: meta?.note,
                  product_line: params.product_line,
                  created_by: ctx.userId!,
                });
                created++;
              }
            }
            return ok({ parsed: blocks.length, created, skipped_completed, dry_run: params.dry_run ?? false });
          }

          default:
            return errResult(`未知操作: ${String(params.action)}`);
        }
      } catch (error) {
        logger.error({ error, action: params.action }, 'manage_agent_tasks 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}

function ok(data: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...data }) }] };
}

function errResult(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
}
