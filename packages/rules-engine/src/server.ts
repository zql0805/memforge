// Created by dev on 2026/04/04
// Copyright © 2026

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadRulesConfig, getLogger, initPool, loadDbConfig, getPool, SkillStore, ApiEmbeddingService, ensureRedisConnected } from '@memforgeai/shared';
import type { GitContext } from '@memforgeai/shared';
import { RulesPostgresStorage } from './storage/postgres.js';
import { ConflictDetector } from './services/conflict-detector.js';
import { VoteManager } from './services/vote-manager.js';
import { MetricsService } from './services/metrics-service.js';
import { DiscoveryService } from './services/discovery-service.js';
import { detectGitContext } from './services/git.js';
import { registerProposeRule } from './tools/propose.js';
import { registerListRules } from './tools/list-rules.js';
import { registerGetRule } from './tools/get-rule.js';
import { registerVoteRule } from './tools/vote.js';
import { registerUpdateRule } from './tools/update-rule.js';
import { registerDeprecateRule } from './tools/deprecate.js';
import { registerDeleteRule } from './tools/delete.js';
import { registerActivateRule } from './tools/activate.js';
import { registerEnforceRules } from './tools/enforce.js';
import { registerDiscoverRules } from './tools/discover.js';
import { registerMeasureRules } from './tools/measure.js';
import { registerRecordRuleEvent } from './tools/record-event.js';
import { registerActiveRulesResource } from './tools/active-rules-resource.js';
import { registerAssessSkill } from './tools/assess-skill.js';
import { registerGetGrowthPath } from './tools/growth-path.js';
import { registerRecordMilestone } from './tools/record-milestone.js';
import { registerGetSkillRadar } from './tools/skill-radar.js';
import { registerGetTeamMatrix } from './tools/team-matrix.js';
import { registerKnowledgeGraph } from './tools/knowledge-graph.js';
import type { RulesToolContext } from './tools/types.js';

const logger = getLogger('rules-server');

/**
 * 初始化重资源（DB、模型、服务），只需调用一次。
 */
export async function initRulesContext(): Promise<RulesToolContext> {
  const config = loadRulesConfig();

  initPool(loadDbConfig());
  const storage = new RulesPostgresStorage();
  await storage.initialize();
  logger.info('规则 PostgreSQL 存储初始化完成');

  await ensureRedisConnected();

  if (!config.openaiBaseUrl || !config.openaiApiKey || !config.openaiEmbeddingModel) {
    throw new Error(
      '必须配置 OPENAI_BASE_URL、OPENAI_API_KEY 和 OPENAI_EMBEDDING_MODEL（Memforge 使用 API Embedding）',
    );
  }
  const embedding = new ApiEmbeddingService({
    baseUrl: config.openaiBaseUrl,
    apiKey: config.openaiApiKey,
    model: config.openaiEmbeddingModel,
    dimensions: config.openaiEmbeddingDimensions ?? config.embeddingDimensions,
    queryPrefix: config.embeddingQueryPrefix,
    passagePrefix: config.embeddingPassagePrefix,
  });
  await embedding.initialize();
  logger.info(
    { provider: 'api', model: config.openaiEmbeddingModel, dimensions: config.embeddingDimensions },
    'API Embedding 服务加载完成',
  );

  const conflictDetector = new ConflictDetector(storage, embedding, config);
  const voteManager = new VoteManager(storage, config);
  const metrics = new MetricsService(storage);
  const discovery = new DiscoveryService(storage, embedding, config);

  let gitContext: GitContext | null = null;
  try {
    gitContext = detectGitContext(process.cwd());
    logger.info({ project: gitContext.projectName, branch: gitContext.branchName }, 'Git 上下文检测成功');
  } catch {
    logger.warn('未检测到 Git 仓库，使用默认上下文');
  }

  const skillStore = new SkillStore(getPool());

  return {
    storage, embedding, conflictDetector, voteManager, metrics, discovery, config, gitContext,
    skillStore, userId: null, orgId: null, userRole: null, teamId: null,
  };
}

/**
 * 使用共享 Context 创建一个新的 McpServer 实例。
 * 轻量操作，可安全地每请求调用（stateless HTTP 模式）。
 */
export function buildRulesMcpServer(ctx: RulesToolContext): McpServer {
  const server = new McpServer({
    name: 'memforge-rules',
    version: '0.1.0',
  });

  registerProposeRule(server, ctx);
  registerListRules(server, ctx);
  registerGetRule(server, ctx);
  registerVoteRule(server, ctx);
  registerUpdateRule(server, ctx);
  registerDeprecateRule(server, ctx);
  registerDeleteRule(server, ctx);
  registerActivateRule(server, ctx);
  registerEnforceRules(server, ctx);
  registerDiscoverRules(server, ctx);
  registerMeasureRules(server, ctx);
  registerRecordRuleEvent(server, ctx);
  registerActiveRulesResource(server, ctx);
  registerAssessSkill(server, ctx);
  registerGetGrowthPath(server, ctx);
  registerRecordMilestone(server, ctx);
  registerGetSkillRadar(server, ctx);
  registerGetTeamMatrix(server, ctx);
  registerKnowledgeGraph(server, ctx);

  return server;
}

/**
 * 创建 Rules MCP Server 实例（不绑定传输层）。
 * 传输层由 index.ts 根据 TRANSPORT_MODE 选择。
 */
export async function createRulesServer(): Promise<McpServer> {
  const ctx = await initRulesContext();
  const server = buildRulesMcpServer(ctx);
  logger.info('MCP Server 已注册 18 个工具 + 1 个资源 (含 M6 技能树/知识图谱)');
  return server;
}
