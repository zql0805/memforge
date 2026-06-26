// Created by dev on 2026/04/05
// Copyright © 2026

import { writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertPathWithin, getLogger, safeResolvePath, buildVisibilityClause, MemoryScope, MemorySource } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { resolveVisibilityContext } from '../services/team-resolver.js';

const logger = getLogger('export-import');

const IMPORT_BATCH_SIZE = 20;
const EXPORT_BATCH_SIZE = 1000;
const DEFAULT_EXPORT_LIMIT = 10000;
const MAX_EXPORT_LIMIT = 50000;
const MAX_IMPORT_ENTRIES = 10000;

export function registerExportMemories(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'export_memories',
    '导出记忆数据为 JSON 文件，支持按项目/scope/标签筛选。用于个人数据备份或迁移到企业版。',
    {
      output_path: z.string().describe('导出文件路径（如 ./memforge-export.json）'),
      project_id: z.string().optional().describe('按项目 ID 筛选（留空导出全部）'),
      scope: z.string().optional().describe('按 scope 筛选'),
      tags: z.array(z.string()).optional().describe('按标签筛选'),
      include_archived: z.boolean().default(false).describe('是否包含已归档记忆'),
      limit: z.number().int().min(1).max(MAX_EXPORT_LIMIT).default(DEFAULT_EXPORT_LIMIT).describe(
        `导出条数上限（默认 ${DEFAULT_EXPORT_LIMIT}，最大 ${MAX_EXPORT_LIMIT}）`,
      ),
    },
    async ({ output_path, project_id, scope, tags, include_archived, limit }) => {
      const isAdmin = ctx.userRole === 'admin';

      if (!isAdmin && !ctx.userId) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: '未提供用户身份，无法导出记忆' }) }] };
      }

      // 非 admin 必须指定 project_id，防止全库导出
      if (!project_id && ctx.userRole && !isAdmin) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: '非管理员必须指定 project_id 参数' }) }] };
      }

      const projectRoot = ctx.gitContext?.projectPath ?? process.cwd();
      let absPath: string;
      try {
        absPath = safeResolvePath(projectRoot, output_path);
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: (err as Error).message }) }] };
      }

      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (project_id) {
        conditions.push(`project_id = $${paramIdx++}`);
        params.push(project_id);
      }
      if (scope) {
        conditions.push(`scope = $${paramIdx++}`);
        params.push(scope);
      }
      if (!include_archived) {
        conditions.push('is_archived = FALSE');
      }

      if (!isAdmin && ctx.userId) {
        const visCtx = await resolveVisibilityContext(ctx.userId, ctx.orgId ?? null, ctx.teamId ?? null);
        const { clause, nextIdx } = buildVisibilityClause({
          userId: visCtx.userId,
          teamIds: visCtx.teamIds,
          accessibleProductLines: visCtx.accessibleProductLines,
          orgId: visCtx.orgId,
        }, params, paramIdx);
        conditions.push(clause);
        paramIdx = nextIdx;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const pool = (await import('@memforgeai/shared')).getPool();
      const exportLimit = Math.min(limit ?? DEFAULT_EXPORT_LIMIT, MAX_EXPORT_LIMIT);

      // 分批查询 + 流式写入，避免一次性加载全部数据导致 OOM（不含 embedding 字段）
      // count 在尾部追加（流式写入无法预知总数）
      const metaPrefix = JSON.stringify({
        version: '1.0',
        exportedAt: new Date().toISOString(),
        source: {
          projectId: project_id ?? ctx.gitContext?.projectName ?? 'unknown',
          hostname: process.env.HOSTNAME ?? 'local',
        },
        entries: null,
      }).replace('"entries":null', '"entries":[');
      writeFileSync(absPath, metaPrefix, 'utf-8');

      let totalExported = 0;
      let dbOffset = 0;
      let firstEntry = true;

      while (totalExported < exportLimit) {
        const batchLimit = Math.min(EXPORT_BATCH_SIZE, exportLimit - totalExported);
        const { rows } = await pool.query(
          `SELECT id, project_id, branch_id, title, content, scope, source, tags, metadata,
                  is_archived, archived_reason, created_at, updated_at, expires_at
           FROM memory.entries ${where}
           ORDER BY created_at DESC
           LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
          [...params, batchLimit, dbOffset],
        );
        if (rows.length === 0) break;

        let filtered = rows as Array<{ tags: string[] }>;
        if (tags && tags.length > 0) {
          filtered = rows.filter((r: { tags: string[] }) =>
            tags.some(t => r.tags.includes(t)),
          );
        }

        for (const row of filtered) {
          const prefix = firstEntry ? '' : ',\n';
          appendFileSync(absPath, prefix + JSON.stringify(row), 'utf-8');
          firstEntry = false;
          totalExported++;
          if (totalExported >= exportLimit) break;
        }

        dbOffset += rows.length;
        if (rows.length < batchLimit) break;
      }

      appendFileSync(absPath, `\n],"count":${totalExported}}`, 'utf-8');
      logger.info({ path: absPath, count: totalExported }, '记忆数据已导出');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            exported: totalExported,
            path: absPath,
          }),
        }],
      };
    },
  );
}

export function registerImportMemories(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'import_memories',
    '从 JSON 文件导入记忆数据。用于从个人备份恢复或迁移到新环境。自动跳过已存在的记忆（按标题去重）。',
    {
      input_path: z.string().describe('导入文件路径'),
      target_project_id: z.string().optional().describe('覆盖目标项目 ID（留空保持原始值）'),
      dry_run: z.boolean().default(false).describe('试运行：仅报告将导入多少条，不实际写入'),
    },
    async ({ input_path, target_project_id, dry_run }) => {
      // 批量写入必须绑定已认证用户，防止匿名导入污染记忆库
      if (!ctx.userId) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: '未提供用户身份，无法导入记忆' }) }] };
      }

      let absPath: string;
      try {
        absPath = assertPathWithin([process.env.HOME ?? '/tmp', process.cwd()], input_path);
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: (err as Error).message }) }] };
      }

      if (!existsSync(absPath)) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: '文件不存在' }) }] };
      }

      let exportData: { entries: Array<Record<string, unknown>> };
      try {
        exportData = JSON.parse(readFileSync(absPath, 'utf-8'));
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: '文件不是有效 JSON' }) }] };
      }

      if (!Array.isArray(exportData.entries)) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: '无效的导出格式' }) }] };
      }

      if (exportData.entries.length > MAX_IMPORT_ENTRIES) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `导入条目数 ${exportData.entries.length} 超过上限 ${MAX_IMPORT_ENTRIES}`,
            }),
          }],
        };
      }

      let imported = 0;
      let skipped = 0;

      async function importOneEntry(
        entry: Record<string, unknown>,
      ): Promise<'imported' | 'skipped'> {
        const title = entry.title as string;
        const content = entry.content as string;
        if (!title || !content) {
          return 'skipped';
        }

        if (dry_run) {
          return 'imported';
        }

        const scopeResult = MemoryScope.safeParse(entry.scope ?? 'domain_knowledge');
        const sourceResult = MemorySource.safeParse(entry.source ?? 'manual');
        if (!scopeResult.success || !sourceResult.success) {
          logger.warn(
            { title, scope: entry.scope, source: entry.source },
            '导入记忆 scope/source 无效，已跳过',
          );
          return 'skipped';
        }

        const embedding = await ctx.embedding.embed(content.slice(0, 2000));
        await ctx.storage.store({
          projectId: target_project_id ?? (entry.project_id as string) ?? ctx.gitContext?.projectName ?? 'unknown',
          branchId: (entry.branch_id as string) ?? null,
          title,
          content,
          scope: scopeResult.data,
          source: sourceResult.data,
          tags: (entry.tags as string[]) ?? [],
          embedding,
          metadata: { ...(entry.metadata as Record<string, unknown> ?? {}), importedFrom: absPath },
          isArchived: false,
          archivedReason: null,
          createdBy: ctx.userId!,
          expiresAt: null,
          orgId: ctx.orgId || null,
          teamId: null,
          visibility: 'personal',
        });
        return 'imported';
      }

      for (let i = 0; i < exportData.entries.length; i += IMPORT_BATCH_SIZE) {
        const batch = exportData.entries.slice(i, i + IMPORT_BATCH_SIZE);
        const results = await Promise.allSettled(batch.map(entry => importOneEntry(entry)));

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          const title = (batch[j].title as string) ?? '(unknown)';
          if (result.status === 'fulfilled') {
            if (result.value === 'imported') imported++;
            else skipped++;
          } else {
            logger.warn({ title, err: (result.reason as Error).message }, '导入记忆失败（可能重复）');
            skipped++;
          }
        }
      }

      logger.info({ path: absPath, imported, skipped, dryRun: dry_run }, '记忆数据导入完成');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            imported,
            skipped,
            total: exportData.entries.length,
            dryRun: dry_run,
          }),
        }],
      };
    },
  );
}
