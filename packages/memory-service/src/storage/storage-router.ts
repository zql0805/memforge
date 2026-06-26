import { getLogger } from '@memforgeai/shared';
import type { MemoryScope, MemorySource, MemoryVisibility } from '@memforgeai/shared';
import type { ToolContext } from '../tools/types.js';

const logger = getLogger('storage:router');

/** knowledge-service 写入超时（毫秒） */
const KNOWLEDGE_WRITE_TIMEOUT_MS = 10_000;

type StorageTarget =
  | { type: 'knowledge'; knowledgeType: string }
  | { type: 'memory' }
  | { type: 'dual'; knowledgeType: string };

const KNOWLEDGE_SCOPES: Record<string, string> = {
  api_reference: 'api_reference',
  domain_knowledge: 'technical',
  coding_standard: 'technical',
  convention: 'technical',
  bug_pattern: 'troubleshooting',
  lesson_learned: 'technical',
  performance_insight: 'technical',
};

export function routeByScope(scope: string): StorageTarget {
  const knowledgeType = KNOWLEDGE_SCOPES[scope];
  if (knowledgeType) {
    return { type: 'dual', knowledgeType };
  }
  return { type: 'memory' };
}

interface KnowledgeWriteParams {
  projectId: string;
  productLine?: string;
  teamId?: string;
  orgId?: string;
  title: string;
  content: string;
  knowledgeType: string;
  sourceType: string;
  sourceRef: string;
  tags?: string[];
  visibility?: string;
}

const knowledgeServiceUrl = process.env.KNOWLEDGE_SERVICE_URL || 'http://127.0.0.1:3003';

export async function writeToKnowledge(params: KnowledgeWriteParams): Promise<boolean> {
  try {
    const resp = await fetch(`${knowledgeServiceUrl}/api/knowledge/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: params.projectId,
        product_line: params.productLine,
        team_id: params.teamId,
        org_id: params.orgId,
        knowledge_type: params.knowledgeType,
        title: params.title,
        question: params.title,
        answer: params.content,
        source_type: params.sourceType,
        source_ref: params.sourceRef,
        tags: params.tags ?? [],
        visibility: params.visibility ?? 'personal',
        status: 'published',
      }),
      signal: AbortSignal.timeout(KNOWLEDGE_WRITE_TIMEOUT_MS),
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status, sourceRef: params.sourceRef }, '写入 knowledge-service 失败');
      return false;
    }
    return true;
  } catch (err) {
    logger.debug({ err, sourceRef: params.sourceRef }, '写入 knowledge-service 异常（降级到仅 entries）');
    return false;
  }
}

export interface DualWriteParams {
  ctx: ToolContext;
  scope: MemoryScope;
  projectId: string;
  productLine?: string;
  branchId: string | null;
  title: string;
  content: string;
  source: MemorySource;
  tags: string[];
  embedding: number[];
  metadata: Record<string, unknown>;
  sourceRef?: string;
  visibility?: MemoryVisibility;
}

export async function storeWithRouting(params: DualWriteParams): Promise<void> {
  const route = routeByScope(params.scope);

  const isDualWrite = route.type === 'dual' || route.type === 'knowledge';

  await params.ctx.storage.store({
    projectId: params.projectId,
    branchId: params.branchId,
    title: params.title,
    content: params.content,
    scope: params.scope,
    source: params.source,
    tags: params.tags,
    embedding: params.embedding,
    metadata: isDualWrite
      ? { ...params.metadata, migrated_to_knowledge: 'true' }
      : params.metadata,
    isArchived: false,
    archivedReason: null,
    createdBy: params.ctx.userId,
    expiresAt: null,
    orgId: params.ctx.orgId || null,
    teamId: params.ctx.teamId || null,
    visibility: params.visibility ?? 'personal',
  });

  if (isDualWrite) {
    writeToKnowledge({
      projectId: params.projectId,
      productLine: params.productLine,
      teamId: params.ctx.teamId || undefined,
      orgId: params.ctx.orgId || undefined,
      title: params.title,
      content: params.content,
      knowledgeType: route.type === 'dual' ? route.knowledgeType : (route as { knowledgeType: string }).knowledgeType,
      sourceType: 'auto_index',
      sourceRef: params.sourceRef ?? `${params.scope}:${params.title.slice(0, 80)}`,
      tags: params.tags,
      visibility: params.visibility,
    }).catch(err => {
      logger.debug({ err }, '异步写入知识库失败');
    });
  }
}
