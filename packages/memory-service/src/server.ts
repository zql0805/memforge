// Created by dev on 2026/04/04
// Copyright © 2026

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, getLogger, getPool, initPool, loadDbConfig, ApiEmbeddingService, ensureRedisConnected } from '@memforgeai/shared';
import type { GitContext } from '@memforgeai/shared';
import { PostgresStorage } from './storage/postgres.js';
import { SensitiveDataScanner } from './services/scanner.js';
import { detectGitContext } from './services/git.js';
import { registerStoreMemory } from './tools/store.js';
import { registerRecallMemory } from './tools/recall.js';
import { registerListMemories } from './tools/list.js';
import { registerUpdateMemory } from './tools/update.js';
import { registerArchiveMemory } from './tools/archive.js';
import { registerIndexDocuments } from './tools/index-documents.js';
import { registerSyncDocuments } from './tools/sync-documents.js';
import { registerLearnFromCommits } from './tools/learn-from-commit.js';
import { registerLearnFromReview } from './tools/learn-from-review.js';
import { registerWatchDocs } from './tools/watch-prdocs.js';
import { registerImportTopology } from './tools/import-topology.js';
import { registerScanTopology } from './tools/scan-topology.js';
import { registerExportMemories, registerImportMemories } from './tools/export-import.js';
import { registerBootstrap } from './tools/bootstrap.js';
import { registerStoreSessionSummary } from './tools/store-session-summary.js';
import { registerStoreLogInsight } from './tools/store-log-insight.js';
import { registerStoreTroubleshoot } from './tools/store-troubleshoot.js';
import { registerStoreIncident } from './tools/store-incident.js';
import { registerStoreCodeReview } from './tools/store-code-review.js';
import { registerStoreStructuredMemory } from './tools/store-structured-memory.js';
import { registerGetDeveloperProfile } from './tools/developer-profile.js';
import { registerGetSystemRules } from './tools/get-system-rules.js';
import { registerVerifyMemory } from './tools/verify-memory.js';
import { registerIndexApiDocs } from './tools/index-api-docs.js';
import { registerStartWorkContext } from './tools/start-work-context.js';
import { registerUpdateWorkContext } from './tools/update-work-context.js';
import { registerEvaluateWorkContext } from './tools/evaluate-work-context.js';
import { registerGetAgentTasks } from './tools/task-get.js';
import { registerCreateAgentTask } from './tools/task-create.js';
import { registerUpdateAgentTask } from './tools/task-update.js';
import { registerBatchUpdateTasks } from './tools/task-batch.js';
import { registerLogTaskProgress } from './tools/task-log.js';
import { registerImportTasksFromPlan } from './tools/task-import.js';
import { registerManageAgentTasks } from './tools/task-manage.js';
import { registerQueryTopology, registerGetTopologyReleaseOrder, registerGetTopologyChangeImpact, registerResolveServicePath, registerLookupInterfaceProvider } from './tools/query-topology.js';
import { registerBootstrapProjectHistory } from './tools/bootstrap-project-history.js';
import { registerCheckStaleCode } from './tools/check-stale-code.js';
import { registerCheckConflictRisk } from './tools/check-conflict-risk.js';
import { registerGetProjectContext } from './tools/get-project-context.js';
import { registerExtractCodingStandards } from './tools/extract-coding-standards.js';
import { registerCheckRelatedActivity } from './tools/check-related-activity.js';
import { registerExtractSessionMemories, createSessionLlmProvider } from './tools/extract-session.js';
import { registerReviewCommit } from './tools/review-commit.js';
import { registerInstallGitHooks } from './tools/install-git-hooks.js';
import { registerSetupGitlabWebhooks } from './tools/setup-gitlab-webhooks.js';
import { registerBatchInstallHooks } from './tools/batch-install-hooks.js';
import { startTopologyAutoSync } from './auto/topology-sync.js';
import { startRulesMdcSync } from './auto/rules-mdc-sync.js';
import { runAutoInitHook } from './auto/init-hook.js';
import { GitChangeEngine } from './tools/git-engine/index.js';
import type { ToolContext } from './tools/types.js';

const logger = getLogger('server');

/**
 * 初始化重资源（DB、模型、扫描器），只需调用一次。
 * 返回共享的 ToolContext，可供多个 McpServer 实例复用。
 */
export async function initMemoryContext(): Promise<ToolContext> {
  const config = loadConfig();

  initPool(loadDbConfig());
  const storage = new PostgresStorage();
  await storage.initialize();
  logger.info('PostgreSQL 存储初始化完成');

  const scanner = new SensitiveDataScanner();

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
  await storage.validateEmbeddingDimensions(config.embeddingDimensions);
  await storage.setEmbeddingMeta('model_tier', `api:${config.openaiEmbeddingModel}`);
  logger.info(
    { provider: 'api', model: config.openaiEmbeddingModel, dimensions: config.embeddingDimensions },
    'API Embedding 服务加载完成',
  );

  let gitContext: GitContext | null = null;
  try {
    gitContext = detectGitContext(process.cwd());
    logger.info({ project: gitContext.projectName, branch: gitContext.branchName }, 'Git 上下文检测成功');
  } catch {
    const envProject = process.env.MEMFORGE_DEFAULT_PROJECT;
    if (envProject) {
      gitContext = {
        projectName: envProject,
        branchName: 'unknown',
        projectPath: process.cwd(),
        isWorktree: false,
        worktreePath: null,
        remoteUrl: null,
      };
      logger.info({ project: envProject }, '使用 MEMFORGE_DEFAULT_PROJECT 环境变量作为项目标识');
    } else {
      logger.warn('未检测到 Git 仓库且未配置 MEMFORGE_DEFAULT_PROJECT，project_id 将使用 "default"');
    }
  }

  return { storage, scanner, embedding, config, gitContext, userId: null, orgId: null, teamId: null, userRole: null, deviceId: null, isSuperAdmin: false, rulesLoadedAt: null };
}

/**
 * 使用共享 ToolContext 创建一个新的 McpServer 实例。
 * 轻量操作，可安全地每请求调用（stateless HTTP 模式）。
 */
export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: 'memforge-memory',
    version: '0.1.0',
  });

  // 通过底层 Server 实例注入 MCP instructions（所有 IDE 均可见）
  // 先注入静态基础版，再异步加载 DB 中的 ai_agent 规则补充
  const serverInternal = server.server as unknown as { _instructions: string };
  serverInternal._instructions = getBaseInstructions();
  loadDynamicInstructions(serverInternal).catch(err => {
    logger.warn({ err: String(err) }, 'ai_agent 规则动态加载失败，使用基础 instructions');
  });

  registerStoreMemory(server, ctx);
  registerRecallMemory(server, ctx);
  registerListMemories(server, ctx);
  registerUpdateMemory(server, ctx);
  registerArchiveMemory(server, ctx);
  registerIndexDocuments(server, ctx);
  registerSyncDocuments(server, ctx);
  registerLearnFromCommits(server, ctx);
  registerLearnFromReview(server, ctx);
  registerWatchDocs(server, ctx);
  registerImportTopology(server, ctx);
  registerScanTopology(server, ctx);
  registerExportMemories(server, ctx);
  registerImportMemories(server, ctx);
  registerBootstrap(server, ctx);
  registerStoreSessionSummary(server, ctx);
  registerStoreLogInsight(server, ctx);
  registerStoreTroubleshoot(server, ctx);
  registerStoreIncident(server, ctx);
  registerStoreCodeReview(server, ctx);
  registerStoreStructuredMemory(server, ctx);
  registerStartWorkContext(server, ctx);
  registerUpdateWorkContext(server, ctx);
  registerEvaluateWorkContext(server, ctx);
  registerGetAgentTasks(server, ctx);
  registerCreateAgentTask(server, ctx);
  registerUpdateAgentTask(server, ctx);
  registerBatchUpdateTasks(server, ctx);
  registerLogTaskProgress(server, ctx);
  registerImportTasksFromPlan(server, ctx);
  registerManageAgentTasks(server, ctx);
  registerQueryTopology(server, ctx);
  registerGetTopologyReleaseOrder(server, ctx);
  registerGetTopologyChangeImpact(server, ctx);
  registerResolveServicePath(server, ctx);
  registerLookupInterfaceProvider(server, ctx);
  registerGetDeveloperProfile(server, ctx);
  registerGetSystemRules(server, ctx);
  registerVerifyMemory(server, ctx);
  registerIndexApiDocs(server, ctx);
  registerBootstrapProjectHistory(server, ctx);
  registerCheckStaleCode(server, ctx);
  registerCheckConflictRisk(server, ctx);
  registerGetProjectContext(server, ctx);
  registerExtractCodingStandards(server, ctx);
  registerCheckRelatedActivity(server, ctx);
  registerExtractSessionMemories(server, ctx, createSessionLlmProvider());
  registerReviewCommit(server, ctx);
  registerInstallGitHooks(server, ctx);
  registerSetupGitlabWebhooks(server, ctx);
  registerBatchInstallHooks(server, ctx);

  return server;
}

/**
 * 创建 Memory MCP Server 实例（不绑定传输层）。
 * 传输层由 index.ts 根据 TRANSPORT_MODE 选择。
 */
export async function createMemoryServer(): Promise<McpServer> {
  const ctx = await initMemoryContext();
  const server = buildMcpServer(ctx);

  logger.info('MCP Server 已注册 37 个工具 (含 5 个基础记忆 + 5 个自动学习 + 2 个拓扑桥接 + 4 个拓扑查询 + 2 个导出导入 + 6 个知识积累 + 3 个工作追踪 + 6 个 Agent 任务 + 1 个开发者画像 + 1 个系统规则 + 1 个校验 + 1 个 API 索引)');

  // 启动拓扑自动同步（后台非阻塞）
  startTopologyAutoSync(ctx).catch((err: Error) => {
    logger.warn({ err: err.message }, '拓扑自动同步启动失败（不影响主服务）');
  });

  // Smart Semi-Auto 自动初始化（后台非阻塞）
  runAutoInitHook(ctx).catch((err: Error) => {
    logger.warn({ err: err.message }, '自动初始化检查失败（不影响主服务）');
  });

  // A2: Rules ↔ .mdc 双向同步（后台非阻塞）
  startRulesMdcSync().catch((err: Error) => {
    logger.warn({ err: err.message }, 'Rules ↔ .mdc 双向同步启动失败（不影响主服务）');
  });

  // Git 变更引擎（定时扫描已注册仓库的新提交，提取知识存入记忆库）
  if (process.env.MEMFORGE_GIT_ENGINE !== 'off') {
    const gitEngine = new GitChangeEngine(ctx);
    gitEngine.start();
  }

  return server;
}

function getBaseInstructions(): string {
  return `# Memforge 记忆服务 — AI 助手行为指南

## 规范加载（修改代码前必须执行）

在修改、创建或审查代码之前，必须调用 get_system_rules 工具加载团队规范：
  get_system_rules({ product_line: "<从工作区路径推断>", language: "<当前项目主语言>", format: "prompt" })
- 不传 rule_types 则返回全部类型规范（coding + ai_agent + workflow + business + infra）
- language：按语言过滤 coding 类规范（如 java/php/typescript），只返回该语言专属 + 通用规范。ai_agent/workflow 等非编码规范不受语言限制
- 每个会话首次涉及代码修改时调用一次（后续同会话无需重复）
- 返回的规范在整个会话中持续生效，违反视为 Bug
- 如果本会话未加载规范就执行 store_memory 或 store_code_review，响应会返回 warning 提醒

## 工具选择指南
- get_system_rules：用于加载全部生效规范，代码修改前必须调用
- list_rules：用于浏览、管理、搜索规范（分页），不适合加载全量规范

## 记忆检索（回答问题或执行任务前必须执行）

在回答用户问题或执行任务之前，调用 recall_memory 检索相关历史经验：
  recall_memory({ query: "与当前任务相关的关键词", product_line: "<从工作区路径推断>", limit: 5, format: "prompt" })
- 修改代码前：用文件路径 + 业务域搜索
- 问题排查时：用错误信息 + 服务名搜索
- scope 为 coding_standard 的记忆视为强制规则

## 知识积累（完成工作后自动存储）

- Code Review 发现 P0/P1 问题 → store_code_review（最高优先级，自动执行）
- 修复 Bug → store_memory({ scope: "bug_pattern" })
- 架构决策 → store_memory({ scope: "architecture" })
- 排查流程 → store_troubleshoot

## 可见性判断

- 通用编码/安全/性能规范 → global
- 产品线架构决策 → product_line
- 特定项目 Bug/配置 → project（默认）

## 拓扑查询

查询服务间关系优先使用结构化工具：query_topology / get_topology_change_impact / get_topology_release_order

## 静默运行

- 检索记忆过程不告知用户；存储记忆时简要告知`;
}

async function loadDynamicInstructions(serverInternal: { _instructions: string }): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ title: string; description: string; severity: string }>(
    `SELECT title, description, severity FROM memory.rules
     WHERE rule_type = 'ai_agent' AND status = 'active' AND project_id = '_global_'
     ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, title`,
  );

  if (rows.length === 0) return;

  const rulesSection = rows
    .map((r: { severity: string; title: string; description: string }) => `### ${r.severity === 'error' ? '[必须]' : '[建议]'} ${r.title}\n${r.description}`)
    .join('\n\n');

  serverInternal._instructions = `${serverInternal._instructions}

## AI 行为规范（从规则库动态加载，共 ${rows.length} 条）

${rulesSection}`;

  logger.info({ count: rows.length }, 'AI 行为规范已动态注入 MCP instructions');
}
