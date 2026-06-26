// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: knowledge_graph — 知识图谱查询与关系管理

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, getPool } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';
import { isAdminOrLead } from './rule-auth.js';

const logger = getLogger('tool:knowledge-graph');

export function registerKnowledgeGraph(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'add_knowledge_relation',
    '在记忆、规则、技能之间建立知识图谱关系',
    {
      source_id: z.string().describe('源节点 ID'),
      source_type: z.enum(['entry', 'rule', 'skill']).describe('源节点类型'),
      target_id: z.string().describe('目标节点 ID'),
      target_type: z.enum(['entry', 'rule', 'skill']).describe('目标节点类型'),
      relation_type: z.enum([
        'related_to', 'evolved_from', 'superseded_by',
        'derived_from', 'requires', 'demonstrates', 'contradicts',
        'caused_by', 'fixed_by', 'guided_by', 'produced', 'references',
      ]).describe('关系类型'),
      confidence: z.number().min(0).max(1).default(0.8).describe('关系置信度'),
    },
    async (args) => {
      if (!isAdminOrLead(ctx)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'add_knowledge_relation 仅限 admin/lead 角色调用',
            }, null, 2),
          }],
        };
      }

      const relation = await ctx.skillStore.addRelation(
        args.source_id,
        args.source_type,
        args.target_id,
        args.target_type,
        args.relation_type,
        args.confidence,
        'user',
      );

      logger.info({
        source: `${args.source_type}:${args.source_id}`,
        target: `${args.target_type}:${args.target_id}`,
        type: args.relation_type,
      }, '知识关系已建立');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            relationId: relation.id,
            sourceId: args.source_id,
            sourceType: args.source_type,
            targetId: args.target_id,
            targetType: args.target_type,
            relationType: args.relation_type,
            confidence: args.confidence,
            createdAt: relation.createdAt,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_knowledge_graph',
    '从某个节点出发，获取知识图谱的关联网络',
    {
      center_id: z.string().describe('中心节点 ID'),
      center_type: z.enum(['entry', 'rule', 'skill']).describe('中心节点类型'),
      depth: z.number().min(1).max(3).default(2).describe('扩展深度'),
    },
    async ({ center_id, center_type, depth }) => {
      const graph = await ctx.skillStore.getKnowledgeGraph(center_id, center_type, depth);

      // 可见性后过滤：移除当前用户无权查看的 entry 节点
      const entryIds = graph.nodes.filter(n => n.type === 'entry').map(n => n.id);
      const invisibleIds = new Set<string>();
      if (entryIds.length > 0 && ctx.userId) {
        try {
          const pool = getPool();
          const { rows } = await pool.query<{ id: string }>(
            `SELECT id::text FROM memory.entries
             WHERE id = ANY($1::uuid[])
               AND visibility = 'personal' AND created_by != $2`,
            [entryIds, ctx.userId],
          );
          for (const r of rows) invisibleIds.add(r.id);
        } catch {
          logger.debug('知识图谱 visibility 过滤查询失败，降级跳过');
        }
      }

      const visibleNodes = graph.nodes.filter(n => !invisibleIds.has(n.id));
      const visibleEdges = graph.edges.filter(e =>
        !invisibleIds.has(e.sourceId) && !invisibleIds.has(e.targetId),
      );

      logger.info({
        center: `${center_type}:${center_id}`,
        depth,
        nodes: visibleNodes.length,
        edges: visibleEdges.length,
        filtered: invisibleIds.size,
      }, '知识图谱查询');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            center: { id: center_id, type: center_type },
            depth,
            nodeCount: visibleNodes.length,
            edgeCount: visibleEdges.length,
            nodes: visibleNodes.map((n) => ({
              id: n.id,
              type: n.type,
              label: n.label,
              metadata: n.metadata ?? {},
            })),
            edges: visibleEdges.map((e) => {
              const srcNode = visibleNodes.find(
                (n) => n.id === e.sourceId && n.type === e.sourceType,
              );
              const tgtNode = visibleNodes.find(
                (n) => n.id === e.targetId && n.type === e.targetType,
              );
              return {
                source: srcNode?.label ?? e.sourceId.substring(0, 8),
                sourceType: e.sourceType,
                target: tgtNode?.label ?? e.targetId.substring(0, 8),
                targetType: e.targetType,
                relation: e.relationType,
                confidence: e.confidence,
              };
            }),
          }, null, 2),
        }],
      };
    },
  );
}
