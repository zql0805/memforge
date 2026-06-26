// Created by dev on 2026/04/12
// Copyright © 2026
// Agent Task Storage — CRUD + 状态机 + 心跳检测

import { getPool, getLogger, queryWithRLS, getRLSContext } from '@memforgeai/shared';
import type pg from 'pg';

const logger = getLogger('task-store');

function rlsQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
  if (getRLSContext()) return queryWithRLS<T>(text, params);
  return getPool().query<T>(text, params);
}

// ─── 类型定义 ──────────────────────────────────────────

export interface AgentTask {
  id: number;
  user_id: string;
  title: string;
  description: string | null;
  category: string;
  priority: string;
  status: string;
  product_line: string | null;
  project: string | null;
  tags: string[];
  related_items: RelatedItem[];
  started_at: string | null;
  completed_at: string | null;
  execution_summary: string | null;
  execution_issues: string | null;
  conversation_id: string | null;
  history_file_path: string | null;
  last_heartbeat: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  sort_order: number;
}

export interface RelatedItem {
  type: 'memory' | 'rule' | 'defect' | 'url' | 'file' | 'task';
  id?: string;
  value?: string;
  path?: string;
  title?: string;
}

export interface CreateTaskInput {
  user_id: string;
  title: string;
  description?: string;
  category?: string;
  priority?: string;
  status?: string;
  product_line?: string;
  project?: string;
  tags?: string[];
  related_items?: RelatedItem[];
  sort_order?: number;
  created_by?: string;
}

export interface UpdateTaskInput {
  task_id: number;
  status?: string;
  title?: string;
  description?: string;
  category?: string;
  product_line?: string;
  project?: string;
  execution_summary?: string;
  execution_issues?: string;
  conversation_id?: string;
  history_file_path?: string;
  priority?: string;
  tags?: string[];
  related_items?: RelatedItem[];
  sort_order?: number;
  heartbeat?: boolean;
  expected_updated_at?: string;
  /** 调用方用户 ID，用于归属校验 */
  userId?: string | null;
  /** 调用方角色，admin/lead 可更新他人任务 */
  userRole?: string | null;
}

export interface GetTasksInput {
  user_id?: string;
  status?: string;
  category?: string;
  product_line?: string;
  project?: string;
  tags_filter?: string[];
  priority?: string;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: string;
}

export interface TaskLogInput {
  task_id: number;
  message: string;
  level?: string;
  metadata?: Record<string, unknown>;
}

// ─── 状态机 ────────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending:     ['in_progress', 'cancelled', 'suspended'],
  suspended:   ['pending', 'in_progress', 'cancelled'],
  in_progress: ['completed', 'failed', 'pending'],
  failed:      ['pending', 'in_progress'],
  cancelled:   ['pending'],
  completed:   ['pending'],
};

const EDITABLE_STATUSES = new Set(['pending', 'suspended']);

const CONTENT_EDIT_FIELDS = new Set([
  'title', 'description', 'category', 'product_line', 'project',
  'priority', 'sort_order', 'tags', 'related_items',
]);

function validateTransition(current: string, target: string): boolean {
  return VALID_TRANSITIONS[current]?.includes(target) ?? false;
}

type TaskQueryFn = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<pg.QueryResult<T>>;

export interface BatchUpdateResult {
  affected: number;
  failed: Array<{ id: number; error: string }>;
}

// ─── TaskStore ─────────────────────────────────────────

export class TaskStore {
  async createTask(input: CreateTaskInput): Promise<AgentTask> {
    const initialStatus = input.status ?? 'pending';
    if (initialStatus !== 'pending' && initialStatus !== 'suspended') {
      throw new Error(`创建任务时初始状态只能为 pending 或 suspended，收到: ${initialStatus}`);
    }
    const { rows } = await rlsQuery<AgentTask>(
      `INSERT INTO memory.agent_tasks
        (user_id, title, description, category, priority, status, product_line, project, tags, related_items, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
       RETURNING *`,
      [
        input.user_id,
        input.title,
        input.description ?? null,
        input.category ?? 'general',
        input.priority ?? 'P2',
        initialStatus,
        input.product_line ?? null,
        input.project ?? null,
        input.tags ?? [],
        JSON.stringify(input.related_items ?? []),
        input.sort_order ?? 0,
        input.created_by ?? 'user',
      ],
    );

    logger.info({ id: rows[0].id, title: input.title }, '任务已创建');
    return rows[0];
  }

  async getTaskById(taskId: number): Promise<AgentTask | null> {
    const { rows } = await rlsQuery<AgentTask>(
      'SELECT * FROM memory.agent_tasks WHERE id = $1',
      [taskId],
    );
    return rows[0] ?? null;
  }

  async getTasks(input: GetTasksInput): Promise<{ tasks: AgentTask[]; total: number }> {

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (input.user_id) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(input.user_id);
    }
    if (input.status && input.status !== 'all') {
      conditions.push(`status = $${paramIndex++}`);
      params.push(input.status);
    }
    if (input.category) {
      conditions.push(`category = $${paramIndex++}`);
      params.push(input.category);
    }
    if (input.product_line) {
      conditions.push(`product_line = $${paramIndex++}`);
      params.push(input.product_line);
    }
    if (input.project) {
      conditions.push(`project = $${paramIndex++}`);
      params.push(input.project);
    }
    if (input.priority) {
      conditions.push(`priority = $${paramIndex++}`);
      params.push(input.priority);
    }
    if (input.tags_filter?.length) {
      conditions.push(`tags && $${paramIndex++}`);
      params.push(input.tags_filter);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await rlsQuery<{ count: string }>(
      `SELECT COUNT(*) as count FROM memory.agent_tasks ${where}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const orderMap: Record<string, string> = {
      priority: "CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 END",
      created_at: 'created_at',
      updated_at: 'updated_at',
      sort_order: 'sort_order',
    };
    const orderColumn = orderMap[input.sort_by ?? 'priority'] ?? orderMap.priority;
    const sortDir = input.sort_order === 'desc' ? 'DESC' : 'ASC';

    const limit = Math.min(input.limit ?? 50, 100);
    const offset = input.offset ?? 0;

    const { rows: tasks } = await rlsQuery<AgentTask>(
      `SELECT * FROM memory.agent_tasks ${where}
       ORDER BY ${orderColumn} ${sortDir}, created_at ASC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset],
    );

    return { tasks, total };
  }

  async updateTask(input: UpdateTaskInput): Promise<AgentTask> {
    const current = await this.getTaskById(input.task_id);
    if (!current) throw new Error(`任务 ${input.task_id} 不存在`);

    // 归属校验：仅创建者或 admin/lead 可更新
    if (input.userId) {
      const isPrivileged = input.userRole === 'admin' || input.userRole === 'lead';
      if (!isPrivileged && current.created_by !== input.userId) {
        throw new Error(`无权更新他人创建的任务 ${input.task_id}`);
      }
    }

    return this.applyTaskUpdate(input, current);
  }

  /** 在已有事务 client 上执行更新（供 batchUpdateTasks 使用） */
  private async updateTaskWithClient(
    client: pg.PoolClient,
    input: UpdateTaskInput,
  ): Promise<AgentTask> {
    const { rows } = await client.query<AgentTask>(
      'SELECT * FROM memory.agent_tasks WHERE id = $1',
      [input.task_id],
    );
    const current = rows[0];
    if (!current) throw new Error(`任务 ${input.task_id} 不存在`);

    if (input.userId) {
      const isPrivileged = input.userRole === 'admin' || input.userRole === 'lead';
      if (!isPrivileged && current.created_by !== input.userId) {
        throw new Error(`无权更新他人创建的任务 ${input.task_id}`);
      }
    }

    return this.applyTaskUpdate(input, current, (text, params) => client.query(text, params));
  }

  private async applyTaskUpdate(
    input: UpdateTaskInput,
    current: AgentTask,
    queryFn: TaskQueryFn = rlsQuery,
  ): Promise<AgentTask> {
    if (input.status && input.status !== current.status) {
      if (!validateTransition(current.status, input.status)) {
        throw new Error(`非法状态转换: ${current.status} → ${input.status}`);
      }
    }

    if (!EDITABLE_STATUSES.has(current.status)) {
      const inputAny = input as unknown as Record<string, unknown>;
      const hasContentEdits = Object.keys(input).some(
        (k) => CONTENT_EDIT_FIELDS.has(k) && inputAny[k] !== undefined,
      );
      if (hasContentEdits) {
        throw new Error(
          `任务处于 ${current.status} 状态，不允许编辑内容字段。仅可变更状态或更新执行信息。`,
        );
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (input.heartbeat) {
      sets.push('last_heartbeat = NOW()');
    }

    if (input.status) {
      sets.push(`status = $${idx++}`);
      params.push(input.status);

      if (input.status === 'in_progress' && (current.status === 'pending' || current.status === 'suspended')) {
        sets.push(`started_at = NOW()`);
        sets.push(`last_heartbeat = NOW()`);
      }
      if (input.status === 'completed' || input.status === 'failed') {
        sets.push(`completed_at = NOW()`);
      }
      if (input.status === 'pending' && (current.status === 'completed' || current.status === 'failed')) {
        sets.push('completed_at = NULL');
      }
    }
    if (input.execution_summary !== undefined) {
      sets.push(`execution_summary = $${idx++}`);
      params.push(input.execution_summary);
    }
    if (input.execution_issues !== undefined) {
      sets.push(`execution_issues = $${idx++}`);
      params.push(input.execution_issues);
    }
    if (input.conversation_id !== undefined) {
      sets.push(`conversation_id = $${idx++}`);
      params.push(input.conversation_id);
    }
    if (input.history_file_path !== undefined) {
      sets.push(`history_file_path = $${idx++}`);
      params.push(input.history_file_path);
    }
    if (input.title) {
      sets.push(`title = $${idx++}`);
      params.push(input.title);
    }
    if (input.description !== undefined) {
      sets.push(`description = $${idx++}`);
      params.push(input.description);
    }
    if (input.category) {
      sets.push(`category = $${idx++}`);
      params.push(input.category);
    }
    if (input.product_line !== undefined) {
      sets.push(`product_line = $${idx++}`);
      params.push(input.product_line || null);
    }
    if (input.project !== undefined) {
      sets.push(`project = $${idx++}`);
      params.push(input.project || null);
    }
    if (input.priority) {
      sets.push(`priority = $${idx++}`);
      params.push(input.priority);
    }
    if (input.sort_order !== undefined) {
      sets.push(`sort_order = $${idx++}`);
      params.push(input.sort_order);
    }
    if (input.tags) {
      sets.push(`tags = $${idx++}`);
      params.push(input.tags);
    }
    if (input.related_items) {
      sets.push(`related_items = $${idx++}::jsonb`);
      params.push(JSON.stringify(input.related_items));
    }

    if (sets.length === 0) {
      return current;
    }

    let whereClause = `id = $${idx}`;
    params.push(input.task_id);
    idx++;

    if (input.expected_updated_at) {
      whereClause += ` AND updated_at = $${idx}::timestamptz`;
      params.push(input.expected_updated_at);
    }

    const { rows } = await queryFn<AgentTask>(
      `UPDATE memory.agent_tasks SET ${sets.join(', ')} WHERE ${whereClause} RETURNING *`,
      params,
    );

    if (rows.length === 0) {
      if (input.expected_updated_at) {
        throw new Error('并发冲突：任务已被其他操作修改。请刷新后重试。');
      }
      throw new Error(`任务 ${input.task_id} 不存在或已被删除`);
    }

    logger.info({ id: input.task_id, status: input.status }, '任务已更新');
    return rows[0];
  }

  async batchUpdateTasks(
    taskIds: number[],
    updates: Record<string, unknown>,
    userId?: string | null,
    userRole?: string | null,
  ): Promise<BatchUpdateResult> {
    if (taskIds.length > 100) {
      throw new Error('批量更新最多支持 100 个任务');
    }
    if (Object.keys(updates).length === 0) return { affected: 0, failed: [] };

    const pool = getPool();
    const client = await pool.connect();
    const failed: Array<{ id: number; error: string }> = [];

    try {
      await client.query('BEGIN');
      for (const taskId of taskIds) {
        try {
          await this.updateTaskWithClient(client, {
            task_id: taskId,
            status: updates.status as string | undefined,
            category: updates.category as string | undefined,
            priority: updates.priority as string | undefined,
            execution_issues: updates.execution_issues as string | undefined,
            userId,
            userRole,
          });
        } catch (err) {
          failed.push({ id: taskId, error: (err as Error).message });
          await client.query('ROLLBACK');
          logger.warn({ taskId, err: (err as Error).message }, '批量更新任务失败，已回滚');
          return { affected: 0, failed };
        }
      }
      await client.query('COMMIT');
      logger.info({ count: taskIds.length, taskIds }, '批量更新任务');
      return { affected: taskIds.length, failed: [] };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async logProgress(input: TaskLogInput): Promise<void> {

    await rlsQuery(
      `INSERT INTO memory.agent_task_logs (task_id, level, message, metadata)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [input.task_id, input.level ?? 'info', input.message, JSON.stringify(input.metadata ?? {})],
    );

    await rlsQuery(
      'UPDATE memory.agent_tasks SET last_heartbeat = NOW() WHERE id = $1',
      [input.task_id],
    );
  }

  async getTaskLogs(taskId: number, limit = 50): Promise<Array<{
    id: number; level: string; message: string; metadata: unknown; created_at: string;
  }>> {

    const { rows } = await rlsQuery<{ id: number; level: string; message: string; metadata: unknown; created_at: string }>(
      `SELECT id, level, message, metadata, created_at
       FROM memory.agent_task_logs
       WHERE task_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [taskId, limit],
    );
    return rows;
  }

  async checkStaleInProgress(timeoutMs = 2 * 60 * 60 * 1000): Promise<number> {

    const result = await rlsQuery(
      `UPDATE memory.agent_tasks
       SET status = 'pending', last_heartbeat = NULL
       WHERE status = 'in_progress'
         AND last_heartbeat < NOW() - interval '1 millisecond' * $1`,
      [timeoutMs],
    );
    const count = result.rowCount ?? 0;
    if (count > 0) {
      logger.warn({ count }, '回退超时的 in_progress 任务为 pending');
    }
    return count;
  }

  async getDistinctValues(userId: string): Promise<{
    categories: string[];
    product_lines: string[];
    projects: string[];
  }> {

    const [catRes, plRes, projRes] = await Promise.all([
      rlsQuery<{ category: string }>(
        'SELECT DISTINCT category FROM memory.agent_tasks WHERE user_id = $1 ORDER BY category',
        [userId],
      ),
      rlsQuery<{ product_line: string }>(
        'SELECT DISTINCT product_line FROM memory.agent_tasks WHERE user_id = $1 AND product_line IS NOT NULL ORDER BY product_line',
        [userId],
      ),
      rlsQuery<{ project: string }>(
        'SELECT DISTINCT project FROM memory.agent_tasks WHERE user_id = $1 AND project IS NOT NULL ORDER BY project',
        [userId],
      ),
    ]);
    return {
      categories: catRes.rows.map((r) => r.category),
      product_lines: plRes.rows.map((r) => r.product_line),
      projects: projRes.rows.map((r) => r.project),
    };
  }

  async updateSortOrder(taskIds: number[]): Promise<void> {
    if (taskIds.length === 0) return;

    const sortOrders = taskIds.map((_, index) => index);
    await rlsQuery(
      `UPDATE memory.agent_tasks AS t
       SET sort_order = v.sort_order
       FROM (
         SELECT unnest($1::int[]) AS id, unnest($2::int[]) AS sort_order
       ) AS v
       WHERE t.id = v.id`,
      [taskIds, sortOrders],
    );
    logger.info({ count: taskIds.length }, '更新排序顺序');
  }

  async deleteTask(taskId: number): Promise<boolean> {

    const result = await rlsQuery(
      'DELETE FROM memory.agent_tasks WHERE id = $1',
      [taskId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
