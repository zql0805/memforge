// Created by dev on 2026/05/25
import { getLogger } from '@memforgeai/shared';
import { DingTalkClient } from './dingtalk-client.js';
import type { DingTalkConfig, DingTalkNode } from './dingtalk-client.js';
import { blocksToMarkdown } from './dingtalk-converter.js';
import type { KnowledgePostgresStorage } from '../storage/postgres.js';

const logger = getLogger('knowledge:dingtalk-importer');

const IMPORT_BATCH_SIZE = 10;
const BATCH_INTERVAL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface DingTalkImportOptions {
  rootNodeId: string;
  productLine: string;
  maxDepth?: number;
  dryRun?: boolean;
  /** 仅导入指定文件夹路径下的文档，为空则全量 */
  folderFilter?: string[];
  /** 文档类型后缀过滤，如 ['.adoc', '.asheet']，为空则全部 */
  docTypeFilter?: string[];
}

export interface DingTalkImportResult {
  total: number;
  imported: number;
  skipped: number;
  errors: number;
  details: Array<{
    nodeId: string;
    name: string;
    path: string;
    status: 'imported' | 'skipped' | 'error';
    reason?: string;
  }>;
}

/** 钉钉文件夹路径 → 知识库分类名的映射 */
function pathToCategory(pathSegments: string[]): string {
  if (pathSegments.length === 0) return '未分类';
  return pathSegments[0].replace(/\s+/g, '-').toLowerCase();
}

/** 从 nodeId 中提取可能的文档 ID（钉钉 wiki node 的 docId 就是 nodeId） */
function extractDocId(node: DingTalkNode): string | null {
  if (node.type !== 'FILE') return null;
  // .dlink 是外部链接，跳过
  if (node.name.endsWith('.dlink')) return null;
  return node.nodeId;
}

export class DingTalkImporter {
  private readonly client: DingTalkClient;
  private readonly storage: KnowledgePostgresStorage;

  constructor(config: DingTalkConfig, storage: KnowledgePostgresStorage) {
    this.client = new DingTalkClient(config);
    this.storage = storage;
  }

  async import(options: DingTalkImportOptions, userId: string | null): Promise<DingTalkImportResult> {
    const { rootNodeId, productLine, maxDepth = 5, dryRun = false, folderFilter, docTypeFilter } = options;

    logger.info({ rootNodeId, productLine, maxDepth, dryRun }, 'Starting DingTalk import');

    const tree = await this.client.walkTree(rootNodeId, maxDepth);

    const result: DingTalkImportResult = {
      total: 0,
      imported: 0,
      skipped: 0,
      errors: 0,
      details: [],
    };

    const fileNodes = tree.filter(item => item.node.type === 'FILE');
    result.total = fileNodes.length;

    const pendingImports: Array<{
      node: DingTalkNode;
      path: string[];
      fullPath: string;
      existing: Awaited<ReturnType<KnowledgePostgresStorage['findBySourceRef']>>;
    }> = [];

    const NON_BLOCK_EXTENSIONS = ['.axls', '.able', '.appt', '.amind', '.pdf', '.pptx', '.docx', '.xlsx'];
    const eligibleNodes: Array<{ node: DingTalkNode; path: string[]; fullPath: string }> = [];

    for (const { node, path } of fileNodes) {
      const fullPath = path.join('/');

      if (folderFilter?.length) {
        const matchesFilter = folderFilter.some(f => fullPath.startsWith(f));
        if (!matchesFilter) {
          result.skipped++;
          result.details.push({ nodeId: node.nodeId, name: node.name, path: fullPath, status: 'skipped', reason: 'folder filter' });
          continue;
        }
      }

      if (docTypeFilter?.length) {
        const matchesType = docTypeFilter.some(ext => node.name.endsWith(ext));
        if (!matchesType) {
          result.skipped++;
          result.details.push({ nodeId: node.nodeId, name: node.name, path: fullPath, status: 'skipped', reason: 'doc type filter' });
          continue;
        }
      }

      if (node.name.endsWith('.dlink')) {
        result.skipped++;
        result.details.push({ nodeId: node.nodeId, name: node.name, path: fullPath, status: 'skipped', reason: 'external link' });
        continue;
      }

      const lastDot = node.name.lastIndexOf('.');
      const ext = lastDot >= 0 ? node.name.slice(lastDot).toLowerCase() : '';
      if (NON_BLOCK_EXTENSIONS.includes(ext) || node.category === 'DOCUMENT') {
        result.skipped++;
        result.details.push({ nodeId: node.nodeId, name: node.name, path: fullPath, status: 'skipped', reason: `unsupported format: ${ext || node.category}` });
        continue;
      }

      eligibleNodes.push({ node, path, fullPath });
    }

    const existingMap = await this.storage.findBySourceRefs(
      'dingtalk',
      eligibleNodes.map(item => item.node.nodeId),
    );

    for (const { node, path, fullPath } of eligibleNodes) {
      const existing = existingMap.get(node.nodeId) ?? null;
      if (existing) {
        const nodeModified = node.modifiedTime ? new Date(node.modifiedTime) : null;
        if (nodeModified && nodeModified <= existing.updatedAt) {
          result.skipped++;
          result.details.push({ nodeId: node.nodeId, name: node.name, path: fullPath, status: 'skipped', reason: 'not modified' });
          continue;
        }
      }

      if (dryRun) {
        result.imported++;
        result.details.push({ nodeId: node.nodeId, name: node.name, path: fullPath, status: 'imported', reason: 'dry run' });
        continue;
      }

      pendingImports.push({ node, path, fullPath, existing });
    }

    for (let i = 0; i < pendingImports.length; i += IMPORT_BATCH_SIZE) {
      if (i > 0) {
        await sleep(BATCH_INTERVAL_MS);
      }
      const batch = pendingImports.slice(i, i + IMPORT_BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(item => this.importDocument(item, productLine, userId)),
      );

      for (let j = 0; j < batchResults.length; j++) {
        const batchResult = batchResults[j];
        const { node, fullPath } = batch[j];
        if (batchResult.status === 'fulfilled') {
          const detail = batchResult.value;
          result.details.push(detail);
          if (detail.status === 'imported') {
            result.imported++;
            logger.debug({ nodeId: node.nodeId, title: node.name, path: fullPath }, 'Document imported');
          } else if (detail.status === 'skipped') {
            result.skipped++;
          }
        } else {
          result.errors++;
          const msg = batchResult.reason instanceof Error ? batchResult.reason.message : String(batchResult.reason);
          result.details.push({ nodeId: node.nodeId, name: node.name, path: fullPath, status: 'error', reason: msg });
          logger.warn({ nodeId: node.nodeId, err: msg }, 'Document import failed');
        }
      }
    }

    logger.info({
      rootNodeId,
      productLine,
      total: result.total,
      imported: result.imported,
      skipped: result.skipped,
      errors: result.errors,
    }, 'DingTalk import completed');

    return result;
  }

  private async importDocument(
    item: {
      node: DingTalkNode;
      path: string[];
      fullPath: string;
      existing: Awaited<ReturnType<KnowledgePostgresStorage['findBySourceRef']>>;
    },
    productLine: string,
    userId: string | null,
  ): Promise<DingTalkImportResult['details'][number]> {
    const { node, path, fullPath, existing } = item;
    const content = await this.fetchAndConvert(node);

    if (!content || content.length < 10) {
      return { nodeId: node.nodeId, name: node.name, path: fullPath, status: 'skipped', reason: 'empty content' };
    }

    const title = node.name
      .replace(/\.(adoc|asheet|amind|appt|aform)$/i, '')
      .trim();

    const category = pathToCategory(path.slice(0, -1));

    if (existing) {
      await this.storage.update(existing.id, {
        title,
        content,
        category,
        updated_by: userId,
      }, userId);
    } else {
      await this.storage.store({
        projectId: productLine,
        productLine,
        knowledgeType: 'technical',
        category,
        title,
        content,
        tags: ['dingtalk-import', ...path.slice(0, -1)],
        answerType: 'direct',
        embedding: null,
        mediaText: '',
        media: [],
        sourceType: 'document',
        sourceRef: node.nodeId,
        visibility: 'product_line',
        createdBy: userId,
      });
    }

    return { nodeId: node.nodeId, name: node.name, path: fullPath, status: 'imported' };
  }

  private async fetchAndConvert(node: DingTalkNode): Promise<string> {
    const docId = extractDocId(node);
    if (!docId) return '';

    const blocks = await this.client.getDocumentBlocks(docId);
    if (blocks.length === 0) return '';

    return blocksToMarkdown(blocks);
  }
}
