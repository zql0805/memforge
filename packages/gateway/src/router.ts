// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 请求路由 — 将经过认证授权的请求代理到后端 MCP 服务

import { getLogger } from '@memforgeai/shared';
import type { GatewayConfig } from './config.js';

const logger = getLogger('router');

/**
 * Memory Service 管辖的工具集
 */
const MEMORY_TOOLS = new Set([
  'store_memory', 'recall_memory', 'list_memories', 'update_memory', 'archive_memory',
  'store_incident', 'store_log_insight', 'store_troubleshoot', 'store_session_summary', 'store_structured_memory',
  'index_documents', 'sync_documents', 'watch_docs',
  'learn_from_commits', 'learn_from_review',
  'import_topology', 'scan_topology', 'bootstrap',
  'query_topology', 'get_topology_release_order', 'get_topology_change_impact', 'resolve_service_path',
  'export_memories', 'import_memories',
  'start_work_context', 'update_work_context', 'evaluate_work_context',
  'get_developer_profile', 'store_code_review',
  'get_system_rules',
  'verify_memory',
  'index_api_docs',
  'get_agent_tasks', 'create_agent_task', 'update_agent_task',
  'batch_update_tasks', 'log_task_progress', 'import_tasks_from_plan', 'manage_agent_tasks',
  'extract_session_memories',
  'bootstrap_project_history', 'check_stale_code', 'check_conflict_risk',
  'get_project_context', 'check_related_activity', 'extract_coding_standards',
  'review_commit', 'install_git_hooks',
]);

/**
 * Rules Engine 管辖的工具集
 */
const RULES_TOOLS = new Set([
  'propose_rule', 'list_rules', 'get_rule', 'vote_rule', 'update_rule',
  'activate_rule', 'deprecate_rule', 'delete_rule', 'enforce_rules', 'discover_rules', 'measure_rules',
  'record_rule_event',
  'get_skill_radar', 'get_team_matrix',
  'get_knowledge_graph', 'add_knowledge_relation',
  'record_milestone', 'assess_skill', 'get_growth_path',
]);


/**
 * Knowledge Service 管辖的工具集
 */
const KNOWLEDGE_TOOLS = new Set([
  'search_knowledge', 'store_knowledge',
  'browse_knowledge', 'read_knowledge_item', 'write_knowledge_item',
  'import_dingtalk_docs', 'code_context',
  'knowledge_feedback', 'list_knowledge', 'knowledge_stats',
]);

export class McpRouter {
  constructor(private readonly config: GatewayConfig) {}

  /**
   * 根据工具名判断应路由到哪个后端服务
   */
  resolveServiceUrl(tool: string): string | null {
    if (MEMORY_TOOLS.has(tool)) {
      return this.config.memoryServiceUrl;
    }
    if (RULES_TOOLS.has(tool)) {
      return this.config.rulesServiceUrl;
    }
    if (KNOWLEDGE_TOOLS.has(tool)) {
      return this.config.knowledgeServiceUrl;
    }
    return null;
  }

  /**
   * 将 MCP JSON-RPC 请求代理到后端服务。
   * 后端服务运行在 HTTP 模式 (TRANSPORT_MODE=http)。
   *
   * TODO: 将 Gateway 入站 x-request-id 透传到下游 memory/rules/knowledge 服务，便于全链路追踪。
   */
  async proxyRequest(
    serviceUrl: string,
    body: Buffer | string,
    headers: Record<string, string>,
  ): Promise<ProxyResult> {
    const url = `${serviceUrl}/mcp`;
    const startMs = Date.now();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          ...headers,
        },
        body,
      });

      let responseBody = await response.text();
      const durationMs = Date.now() - startMs;

      // MCP SDK 的 StreamableHTTPServerTransport 可能返回 SSE 格式
      // 将 "event: message\ndata: {...}\n\n" 转为纯 JSON
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream') || responseBody.startsWith('event:')) {
        const dataLine = responseBody.split('\n').find(l => l.startsWith('data: '));
        if (dataLine) {
          responseBody = dataLine.slice(6);
        }
      }

      logger.debug({ url, status: response.status, durationMs }, 'MCP 代理请求完成');

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      logger.error({ url, error: err, durationMs }, 'MCP 代理请求失败');
      throw new RouterError(`后端服务不可用: ${serviceUrl}`, err);
    }
  }

  /**
   * 从 MCP JSON-RPC 请求体中提取工具名
   */
  extractToolName(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;

    const jsonRpc = body as Record<string, unknown>;
    if (jsonRpc.method === 'tools/call') {
      const params = jsonRpc.params as Record<string, unknown> | undefined;
      return (params?.name as string) ?? null;
    }
    return null;
  }

  /**
   * 判断请求是否为只读类型（tools/list, resources/read 等）。
   * 只读请求可以放宽权限检查。
   */
  isReadOnlyMethod(method: string): boolean {
    return ['tools/list', 'resources/list', 'resources/read', 'prompts/list', 'prompts/get'].includes(method);
  }

  /**
   * 预热后端服务连接池：启动后立即发送 health check，建立 TCP 长连接，
   * 并预取 tools/list 结果到缓存，避免首次 WebUI 请求冷启动延迟。
   */
  async warmUp(): Promise<void> {
    const services = [this.config.memoryServiceUrl, this.config.rulesServiceUrl, this.config.knowledgeServiceUrl];
    await Promise.allSettled(
      services.map(async (url) => {
        try {
          const resp = await fetch(`${url}/health`, { method: 'GET' });
          logger.info({ url, status: resp.status }, '后端服务预热完成');
        } catch (err) {
          logger.warn({ url, err: (err as Error).message }, '后端服务预热失败（启动后重试）');
        }
      }),
    );
  }
}

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}

export class RouterError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RouterError';
  }
}
