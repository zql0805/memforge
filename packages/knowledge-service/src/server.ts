// Created by dev on 2026/05/21
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, getLogger, initPool, loadDbConfig, ApiEmbeddingService, ensureRedisConnected } from '@memforgeai/shared';
import { KnowledgePostgresStorage } from './storage/postgres.js';
import { HybridSearchEngine } from './search/hybrid-engine.js';
import { EmbedQueue } from './import/embed-queue.js';
import { TicketImporter } from './import/ticket-importer.js';
import { LifecycleManager } from './lifecycle/manager.js';
import { registerSearchKnowledge } from './tools/search-knowledge.js';
import { registerStoreKnowledge } from './tools/store-knowledge.js';
import { registerBrowseKnowledge } from './tools/browse.js';
import { registerReadKnowledgeItem } from './tools/read-item.js';
import { registerWriteKnowledgeItem } from './tools/write-item.js';
import { registerImportDingtalk } from './tools/import-dingtalk.js';
import { registerCodeContext } from './tools/code-context.js';
import { registerKnowledgeFeedback } from './tools/feedback.js';
import { registerListKnowledge } from './tools/list-knowledge.js';
import { registerKnowledgeStats } from './tools/knowledge-stats.js';
import type { KnowledgeToolContext } from './tools/types.js';

const logger = getLogger('knowledge:server');

export async function initKnowledgeContext(): Promise<{
  ctx: KnowledgeToolContext;
  searchEngine: HybridSearchEngine;
  embedQueue: EmbedQueue;
  importer: TicketImporter;
  lifecycle: LifecycleManager;
}> {
  const config = loadConfig();
  initPool(loadDbConfig());

  const storage = new KnowledgePostgresStorage();
  await storage.initialize();
  logger.info('Knowledge PostgreSQL storage initialized');

  await ensureRedisConnected();

  let embedding: ApiEmbeddingService | null = null;
  if (!config.openaiBaseUrl || !config.openaiApiKey || !config.openaiEmbeddingModel) {
    logger.warn('Embedding 配置缺失（OPENAI_BASE_URL/API_KEY/EMBEDDING_MODEL），降级为仅 BM25 搜索');
  } else {
    embedding = new ApiEmbeddingService({
      baseUrl: config.openaiBaseUrl,
      apiKey: config.openaiApiKey,
      model: config.openaiEmbeddingModel,
      dimensions: config.openaiEmbeddingDimensions ?? config.embeddingDimensions,
      queryPrefix: config.embeddingQueryPrefix,
      passagePrefix: config.embeddingPassagePrefix,
    });
    try {
      await embedding.initialize();
    } catch (err) {
      logger.warn({ err }, 'Embedding 服务初始化失败，降级为仅 BM25 搜索');
      embedding = null;
    }
  }

  const searchEngine = new HybridSearchEngine(storage, embedding);
  const embedQueue = new EmbedQueue(embedding);
  const importer = new TicketImporter(storage);
  const lifecycle = new LifecycleManager(storage);

  const ctx: KnowledgeToolContext = {
    storage, embedding, config,
    userId: null, orgId: null, teamId: null, userRole: null, deviceId: null, isSuperAdmin: false,
  };

  return { ctx, searchEngine, embedQueue, importer, lifecycle };
}

export function buildKnowledgeMcpServer(ctx: KnowledgeToolContext, searchEngine: HybridSearchEngine): McpServer {
  const server = new McpServer({ name: 'memforge-knowledge', version: '1.0.0' });
  registerSearchKnowledge(server, ctx, searchEngine);
  registerStoreKnowledge(server, ctx);
  registerBrowseKnowledge(server, ctx);
  registerReadKnowledgeItem(server, ctx);
  registerWriteKnowledgeItem(server, ctx);
  registerImportDingtalk(server, ctx);
  registerCodeContext(server, ctx, searchEngine);
  registerKnowledgeFeedback(server, ctx);
  registerListKnowledge(server, ctx);
  registerKnowledgeStats(server, ctx);
  return server;
}
