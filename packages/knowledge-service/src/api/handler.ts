// Created by dev on 2026/05/21
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getLogger, SearchKnowledgeInput, StoreKnowledgeInput, StoreCategoryInput, KnowledgeFeedbackInput, ImportTicketsInput, resolveVisibilityContext, KnowledgeType, MemoryVisibility } from '@memforgeai/shared';
import type { ApiEmbeddingService } from '@memforgeai/shared';
import type { KnowledgePostgresStorage } from '../storage/postgres.js';
import type { HybridSearchEngine } from '../search/hybrid-engine.js';
import type { TicketImporter } from '../import/ticket-importer.js';
import type { LifecycleManager } from '../lifecycle/manager.js';
import type { VlmExtractor } from '../import/vlm-extractor.js';
import { assembleCodeContext } from '../search/code-context-assembler.js';
import { canModifyKnowledgeItem, isAdminOrLead } from '../auth/permissions.js';
import { canViewKnowledgeItem, resolveKnowledgeVisibilityFilters } from '../auth/visibility.js';

const logger = getLogger('knowledge:api');

interface ApiContext {
  storage: KnowledgePostgresStorage;
  searchEngine: HybridSearchEngine;
  embedding: ApiEmbeddingService | null;
  importer: TicketImporter;
  lifecycle: LifecycleManager;
  userId: string | null;
  userRole: string | null;
  orgId: string | null;
  teamId: string | null;
  vlmExtractor?: VlmExtractor | null;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendUnauthorized(res: ServerResponse, message = '未认证'): void {
  sendJson(res, 401, { error: message });
}

function sendForbidden(res: ServerResponse, message = '无权限执行此操作'): void {
  sendJson(res, 403, { error: message });
}

export async function handleKnowledgeApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
): Promise<void> {
  const url = req.url ?? '';
  const method = req.method ?? 'GET';
  const path = url.replace('/api/knowledge/', '').split('?')[0];

  try {
    if (path === 'search' && method === 'POST') {
      const body = await readBody(req);
      const input = SearchKnowledgeInput.parse({
        query: body.query,
        projectId: body.project_id ?? body.projectId,
        productLine: body.product_line ?? body.productLine,
        knowledgeType: body.knowledge_type ?? body.knowledgeType,
        category: body.category,
        limit: body.limit,
        minConfidence: body.min_confidence ?? body.minConfidence,
        teamId: body.team_id ?? body.teamId,
        orgId: body.org_id ?? body.orgId,
      });

      const projectIds = input.projectId ? [input.projectId] : [];

      let visibilityFilters;
      if (ctx.userId) {
        if (input.productLine) {
          visibilityFilters = {
            userId: ctx.userId,
            orgId: input.orgId ?? null,
            teamIds: input.teamId ? [input.teamId] : [],
            accessibleProductLines: [input.productLine],
          };
        } else {
          const visCtx = await resolveVisibilityContext(ctx.userId, input.orgId ?? null, input.teamId ?? null);
          visibilityFilters = {
            userId: visCtx.userId,
            orgId: visCtx.orgId,
            teamIds: visCtx.teamIds,
            accessibleProductLines: visCtx.accessibleProductLines,
          };
        }
      }
      // 未认证时禁止客户端传入 teamId/orgId 构造 visibility 过滤

      const result = await ctx.searchEngine.search({
        query: input.query,
        projectIds,
        productLine: input.productLine,
        knowledgeType: input.knowledgeType,
        category: input.category,
        limit: input.limit,
        minConfidence: input.minConfidence,
        visibilityFilters,
      });
      sendJson(res, 200, {
        results: result.results,
        autoReplySuggested: result.autoReplySuggested,
        total: result.total,
        trace: result.trace,
      });

    } else if (path === 'store' && method === 'POST') {
      if (!ctx.userId) {
        sendForbidden(res);
        return;
      }
      const body = await readBody(req);
      const input = StoreKnowledgeInput.parse({
        projectId: body.project_id ?? body.projectId,
        productLine: body.product_line ?? body.productLine,
        knowledgeType: body.knowledge_type ?? body.knowledgeType,
        category: body.category,
        title: body.title,
        summary: body.summary,
        content: body.content ?? body.answer,
        question: body.question,
        metadata: body.metadata,
        tags: body.tags,
        answerType: body.answer_type ?? body.answerType,
        media: body.media,
        sourceType: body.source_type ?? body.sourceType,
        sourceRef: body.source_ref ?? body.sourceRef,
        visibility: body.visibility,
        status: body.status as string | undefined,
        teamId: body.team_id ?? body.teamId,
        orgId: body.org_id ?? body.orgId,
      });

      let embedding: number[] | null = null;
      if (ctx.embedding) {
        try {
          const text = [input.title, input.summary, input.question, input.content].filter(Boolean).join(' ');
          const [vec] = await ctx.embedding.embedBatch([text]);
          embedding = vec;
        } catch (err) {
          logger.warn({ err: String(err) }, 'Embedding generation failed, will be queued');
        }
      }

      let mediaText = input.media
        .filter(m => m.type === 'image')
        .map(m => [m.visible_text, m.description].filter(Boolean).join(' '))
        .join(' ');

      // VLM 异步提取：当 media 包含图片且 VLM 可用时自动提取描述（不阻塞写入）
      const imageUrls = input.media
        .filter(m => m.type === 'image' && m.url)
        .map(m => m.url as string);

      const item = await ctx.storage.store({
        ...input,
        embedding,
        mediaText,
        createdBy: ctx.userId,
      });

      if (imageUrls.length > 0 && ctx.vlmExtractor?.isAvailable) {
        ctx.vlmExtractor.extractBatch(imageUrls)
          .then(async (vlmText) => {
            if (!vlmText) return;
            const combined = [mediaText, vlmText].filter(Boolean).join(' ');
            await ctx.storage.updateMediaText(item.id, combined);
            logger.info({ id: item.id, imageCount: imageUrls.length }, 'VLM media_text 异步更新完成');
          })
          .catch(err => logger.warn({ err, id: item.id }, 'VLM 异步提取失败'));
      }

      sendJson(res, 201, { success: true, id: item.id });

    } else if (path === 'feedback' && method === 'POST') {
      if (!ctx.userId) {
        sendForbidden(res);
        return;
      }
      const body = await readBody(req);
      const input = KnowledgeFeedbackInput.parse({
        knowledgeId: body.knowledge_id ?? body.knowledgeId,
        ticketId: body.ticket_id ?? body.ticketId,
        helpful: body.helpful,
        comment: body.comment,
      });
      await ctx.storage.storeFeedback(input.knowledgeId, input.helpful, {
        ticketId: input.ticketId,
        comment: input.comment,
        createdBy: ctx.userId,
      });
      sendJson(res, 200, { success: true });

    } else if (path === 'import-tickets' && method === 'POST') {
      if (!ctx.userId) {
        sendUnauthorized(res);
        return;
      }
      const body = await readBody(req);
      const input = ImportTicketsInput.parse({
        productLine: body.product_line ?? body.productLine,
        tickets: ((body.tickets as unknown[]) ?? []).map((t: unknown) => {
        const ticket = t as Record<string, unknown>;
        return ({
          ticketId: ticket.ticket_id ?? ticket.ticketId,
          title: ticket.title,
          description: ticket.description,
          resolution: ticket.resolution,
          category: ticket.category,
          tags: ticket.tags,
          resolvedAt: ticket.resolved_at ?? ticket.resolvedAt,
          media: ticket.media,
        });
        }),
        extractMode: body.extract_mode ?? body.extractMode,
        dryRun: body.dry_run ?? body.dryRun,
      });

      if (input.dryRun) {
        sendJson(res, 200, { status: 'dry_run', count: input.tickets.length });
        return;
      }

      const result = await ctx.importer.importTickets(input, ctx.userId);
      sendJson(res, 200, { status: 'accepted', ...result });

    } else if ((path === 'list' || path === '') && method === 'GET') {
      const params = new URL(url, 'http://localhost').searchParams;
      const productLine = params.get('product_line') ?? undefined;
      const visibilityFilters = await resolveKnowledgeVisibilityFilters(ctx, productLine);
      const result = await ctx.storage.list({
        projectId: params.get('project_id') ?? undefined,
        productLine,
        status: params.get('status') ?? undefined,
        knowledgeType: params.get('knowledge_type') ?? undefined,
        category: params.get('category') ?? undefined,
        search: params.get('search') ?? undefined,
        page: parseInt(params.get('page') ?? '1', 10),
        pageSize: parseInt(params.get('page_size') ?? '20', 10),
        visibilityFilters,
      });
      sendJson(res, 200, result);

    } else if (path === 'categories' && method === 'GET') {
      const params = new URL(url, 'http://localhost').searchParams;
      const categories = await ctx.storage.listCategories(
        params.get('product_line') ?? undefined,
      );
      sendJson(res, 200, { categories });

    } else if (path === 'categories' && method === 'POST') {
      if (!ctx.userId) {
        sendUnauthorized(res);
        return;
      }
      if (!isAdminOrLead(ctx.userRole)) {
        sendForbidden(res);
        return;
      }
      const body = await readBody(req);
      const input = StoreCategoryInput.parse({
        name: body.name,
        slug: body.slug,
        parentId: body.parent_id ?? body.parentId,
        description: body.description,
        productLine: body.product_line ?? body.productLine,
        icon: body.icon,
        sortOrder: body.sort_order ?? body.sortOrder,
      });
      const category = await ctx.storage.createCategory(input);
      sendJson(res, 201, { success: true, category });

    } else if (path.match(/^categories\/[0-9a-f-]{36}$/) && method === 'PUT') {
      if (!ctx.userId) {
        sendUnauthorized(res);
        return;
      }
      if (!isAdminOrLead(ctx.userRole)) {
        sendForbidden(res);
        return;
      }
      const id = path.replace('categories/', '');
      const body = await readBody(req);
      const category = await ctx.storage.updateCategory(id, {
        name: body.name as string | undefined,
        slug: body.slug as string | undefined,
        parentId: (body.parent_id ?? body.parentId) as string | null | undefined,
        description: (body.description as string | null | undefined),
        productLine: (body.product_line ?? body.productLine) as string | null | undefined,
        icon: (body.icon as string | null | undefined),
        sortOrder: (body.sort_order ?? body.sortOrder) as number | undefined,
      });
      if (!category) { sendJson(res, 404, { error: 'Not found' }); return; }
      sendJson(res, 200, { success: true, category });

    } else if (path.match(/^categories\/[0-9a-f-]{36}$/) && method === 'DELETE') {
      if (!ctx.userId) {
        sendUnauthorized(res);
        return;
      }
      if (!isAdminOrLead(ctx.userRole)) {
        sendForbidden(res);
        return;
      }
      const id = path.replace('categories/', '');
      const ok = await ctx.storage.deleteCategory(id);
      sendJson(res, ok ? 200 : 404, { success: ok });

    } else if (path === 'code-context' && method === 'POST') {
      const body = await readBody(req);
      const query = body.query as string;
      if (!query) { sendJson(res, 400, { error: 'query is required' }); return; }

      const maxChars = (body.max_chars ?? body.maxChars ?? 15000) as number;
      const projectIds = body.project_id ? [body.project_id as string] : [];

      let visibilityFilters;
      if (ctx.userId) {
        const plParam = (body.product_line ?? body.productLine) as string | undefined;
        if (plParam) {
          visibilityFilters = {
            userId: ctx.userId,
            orgId: ctx.orgId ?? null,
            teamIds: ctx.teamId ? [ctx.teamId] : [],
            accessibleProductLines: [plParam],
          };
        } else {
          const visCtx = await resolveVisibilityContext(ctx.userId, ctx.orgId ?? null, ctx.teamId ?? null);
          visibilityFilters = {
            userId: visCtx.userId,
            orgId: visCtx.orgId,
            teamIds: visCtx.teamIds,
            accessibleProductLines: visCtx.accessibleProductLines,
          };
        }
      }

      const result = await ctx.searchEngine.search({
        query,
        projectIds,
        productLine: (body.product_line ?? body.productLine) as string | undefined,
        knowledgeType: undefined,
        category: undefined,
        limit: 12,
        minConfidence: 0.3,
        visibilityFilters,
      });

      if (result.results.length === 0) {
        sendJson(res, 200, { markdown: `未找到与 "${query}" 相关的代码知识。`, itemCount: 0, truncated: false });
        return;
      }

      const assembled = assembleCodeContext(query, result.results, maxChars);
      sendJson(res, 200, assembled);

    } else if (path === 'browse' && method === 'GET') {
      const params = new URL(url, 'http://localhost').searchParams;
      const productLine = params.get('product_line') ?? undefined;
      const categorySlug = params.get('path') ?? undefined;
      const page = parseInt(params.get('page') ?? '1', 10);
      const pageSize = parseInt(params.get('page_size') ?? '20', 10);

      const allCategories = await ctx.storage.listCategories(productLine);

      let targetCategory: typeof allCategories[number] | null = null;
      if (categorySlug) {
        targetCategory = allCategories.find(c => c.slug === categorySlug) ?? null;
      }

      const subcategories = allCategories.filter(c => {
        if (!categorySlug) return !c.parentId;
        return c.parentId === targetCategory?.id;
      });

      const visibilityFilters = await resolveKnowledgeVisibilityFilters(ctx, productLine);
      const { items, total } = await ctx.storage.list({
        productLine,
        category: targetCategory?.slug,
        status: 'published',
        page,
        pageSize,
        visibilityFilters,
      });

      sendJson(res, 200, {
        path: categorySlug ?? '/',
        subcategories: subcategories.map(c => ({ id: c.id, name: c.name, slug: c.slug })),
        entries: items,
        total,
        page,
        pageSize,
      });

    } else if (path === 'stats' && method === 'GET') {
      const params = new URL(url, 'http://localhost').searchParams;
      const stats = await ctx.storage.getStats(params.get('product_line') ?? undefined);
      sendJson(res, 200, stats);

    } else if (path.match(/^[0-9a-f-]{36}$/) && method === 'GET') {
      const item = await ctx.storage.getById(path);
      if (!item) { sendJson(res, 404, { error: 'Not found' }); return; }
      const visFilters = await resolveKnowledgeVisibilityFilters(ctx, item.productLine ?? undefined);
      if (!canViewKnowledgeItem(item, {
        ...ctx,
        accessibleProductLines: visFilters?.accessibleProductLines,
      })) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      sendJson(res, 200, item);

    } else if (path.match(/^[0-9a-f-]{36}$/) && method === 'PUT') {
      const id = path;
      if (!ctx.userId) {
        sendForbidden(res);
        return;
      }
      const existing = await ctx.storage.getById(id);
      if (!existing) { sendJson(res, 404, { error: 'Not found' }); return; }
      if (!canModifyKnowledgeItem(existing, ctx.userId, ctx.userRole)) {
        sendForbidden(res);
        return;
      }
      const body = await readBody(req);
      const fields: Record<string, unknown> = {};
      if (body.title !== undefined) fields.title = body.title;
      if (body.content !== undefined) fields.content = body.content;
      if (body.summary !== undefined) fields.summary = body.summary;
      if (body.question !== undefined) fields.question = body.question;
      if (body.category !== undefined) fields.category = body.category;
      const rawKnowledgeType = body.knowledge_type ?? body.knowledgeType;
      if (rawKnowledgeType !== undefined) {
        const parsed = KnowledgeType.safeParse(rawKnowledgeType);
        if (parsed.success) fields.knowledge_type = parsed.data;
      }
      if (body.tags !== undefined) fields.tags = body.tags;
      if (body.metadata !== undefined) fields.metadata = JSON.stringify(body.metadata);
      if (body.visibility !== undefined) {
        const parsed = MemoryVisibility.safeParse(body.visibility);
        if (parsed.success) fields.visibility = parsed.data;
      }
      const updated = await ctx.storage.update(id, fields, ctx.userId);
      if (!updated) { sendJson(res, 404, { error: 'Not found' }); return; }
      sendJson(res, 200, { success: true, item: updated });

    } else if (path.match(/^[0-9a-f-]{36}\/publish$/) && method === 'POST') {
      const id = path.replace('/publish', '');
      if (!ctx.userId) {
        sendForbidden(res);
        return;
      }
      const existing = await ctx.storage.getById(id);
      if (!existing) { sendJson(res, 404, { error: 'Not found' }); return; }
      if (!canModifyKnowledgeItem(existing, ctx.userId, ctx.userRole)) {
        sendForbidden(res);
        return;
      }
      const ok = await ctx.lifecycle.publish(id, ctx.userId);
      sendJson(res, ok ? 200 : 400, { success: ok });

    } else if (path.match(/^[0-9a-f-]{36}\/archive$/) && method === 'POST') {
      const id = path.replace('/archive', '');
      if (!ctx.userId) {
        sendForbidden(res);
        return;
      }
      const existing = await ctx.storage.getById(id);
      if (!existing) { sendJson(res, 404, { error: 'Not found' }); return; }
      if (!canModifyKnowledgeItem(existing, ctx.userId, ctx.userRole)) {
        sendForbidden(res);
        return;
      }
      const ok = await ctx.lifecycle.archive(id, ctx.userId);
      sendJson(res, ok ? 200 : 400, { success: ok });

    } else if (path.match(/^[0-9a-f-]{36}$/) && method === 'DELETE') {
      const id = path;
      if (!ctx.userId) {
        sendForbidden(res);
        return;
      }
      const existing = await ctx.storage.getById(id);
      if (!existing) { sendJson(res, 404, { error: 'Not found' }); return; }
      if (!canModifyKnowledgeItem(existing, ctx.userId, ctx.userRole)) {
        sendForbidden(res);
        return;
      }
      const ok = await ctx.storage.delete(id);
      sendJson(res, ok ? 200 : 404, { success: ok });

    } else if (path === 'cleanup' && method === 'POST') {
      if (!ctx.userId) {
        sendUnauthorized(res);
        return;
      }
      if (!isAdminOrLead(ctx.userRole)) {
        sendForbidden(res);
        return;
      }
      const body = await readBody(req);
      const projectId = (body.project_id ?? body.projectId) as string | undefined;
      const sourceType = (body.source_type ?? body.sourceType) as string | undefined;
      const sourceRefPrefix = (body.source_ref_prefix ?? body.sourceRefPrefix) as string | undefined;
      if (!sourceType) {
        sendJson(res, 400, { error: 'source_type is required' });
        return;
      }
      const deleted = await ctx.lifecycle.cleanupBySource(projectId ?? null, sourceType, sourceRefPrefix);
      sendJson(res, 200, { deleted });

    } else if (path === 'mark-stale' && method === 'POST') {
      if (!ctx.userId) {
        sendUnauthorized(res);
        return;
      }
      if (!isAdminOrLead(ctx.userRole)) {
        sendForbidden(res);
        return;
      }
      const body = await readBody(req);
      const repoId = (body.repo_id ?? body.repoId) as string | undefined;
      const files = body.files as string[] | undefined;
      if (!repoId) {
        sendJson(res, 400, { error: 'repo_id is required' });
        return;
      }
      const staleCount = await ctx.lifecycle.markStaleByFiles(repoId, files ?? []);
      sendJson(res, 200, { staleCount });

    } else if (path === 'stale-stats' && method === 'GET') {
      const params = new URL(url, 'http://localhost').searchParams;
      const stats = await ctx.lifecycle.getStaleStats(params.get('product_line') ?? undefined);
      sendJson(res, 200, stats);

    } else {
      sendJson(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    logger.error({ err, path, method }, 'API error');
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { error: message });
  }
}
