// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: store_incident — 线上故障报告结构化录入

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:store-incident');

export function registerStoreIncident(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'store_incident',
    '将线上故障/事故报告存入知识库。支持从在线故障文档中提取关键信息并结构化存储，形成可检索的故障案例库。',
    {
      title: z.string().describe('故障标题（简洁描述，如"用户支付超时 30 分钟"）'),
      impact: z.enum(['P0', 'P1', 'P2', 'P3']).describe('影响等级: P0(全站不可用) P1(核心功能受损) P2(部分功能异常) P3(轻微影响)'),
      duration_minutes: z.number().optional().describe('故障持续时长（分钟）'),
      affected_services: z.array(z.string()).describe('受影响的服务列表'),
      affected_users: z.string().optional().describe('影响范围描述（如"全量用户"、"约 5000 用户"、"仅东南亚地区"）'),
      timeline: z.array(z.object({
        time: z.string().describe('时间点（如 "2026-04-05 14:30"）'),
        event: z.string().describe('发生的事件'),
      })).optional().describe('故障时间线'),
      root_cause: z.string().describe('根本原因'),
      resolution: z.string().describe('修复/恢复措施'),
      prevention: z.array(z.string()).optional().describe('改进措施列表（防止复发）'),
      lessons_learned: z.array(z.string()).optional().describe('经验教训'),
      doc_url: z.string().optional().describe('原始故障报告文档链接（Confluence/飞书/Google Docs 等）'),
      product_line: z.string().optional().describe('产品线标识（跨项目共享时指定，如 "my-product"）'),
      tags: z.array(z.string()).optional().describe('额外标签'),
    },
    async (params) => {
      const {
        title: incidentTitle, impact, duration_minutes, affected_services,
        affected_users, timeline, root_cause, resolution, prevention,
        lessons_learned, doc_url, product_line, tags,
      } = params;

      const projectId = product_line ?? ctx.gitContext?.projectName ?? 'default';
      const plTag = product_line ? `pl:${product_line.toLowerCase()}` : undefined;

      const content = buildIncidentContent({
        title: incidentTitle, impact, duration_minutes, affected_services,
        affected_users, timeline, root_cause, resolution, prevention,
        lessons_learned, doc_url,
      });

      const memTitle = `[故障报告·${impact}] ${incidentTitle}`;
      const embedding = await ctx.embedding.embedPassage(`${memTitle} ${content}`);

      const dup = await ctx.storage.checkDuplicate(embedding, 0.88);
      if (dup) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: '已存在相似的故障报告',
              existingId: dup.id,
              existingTitle: dup.title,
            }),
          }],
        };
      }

      const entry = await ctx.storage.store({
        projectId,
        branchId: null,
        title: memTitle,
        content,
        scope: 'failure_postmortem' as MemoryScope,
        source: 'manual' as MemorySource,
        tags: [
          ...(tags ?? []),
          ...(plTag ? [plTag] : []),
          'incident', 'postmortem', `impact:${impact}`,
          ...affected_services.map(s => `service:${s}`),
        ],
        embedding,
        metadata: {
          impact,
          durationMinutes: duration_minutes ?? null,
          affectedServices: affected_services,
          affectedUsers: affected_users ?? null,
          docUrl: doc_url ?? null,
          storedAt: new Date().toISOString(),
        },
        isArchived: false,
        archivedReason: null,
        createdBy: ctx.userId,
        expiresAt: null,
        orgId: ctx.orgId || null,
        teamId: null,
        visibility: 'personal',
      });

      logger.info({
        id: entry.id,
        impact,
        services: affected_services,
        duration: duration_minutes,
      }, '故障报告已存入知识库');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            id: entry.id,
            title: entry.title,
            message: `故障报告已存入知识库（${impact} 级、${affected_services.length} 个服务${duration_minutes ? `、持续 ${duration_minutes} 分钟` : ''}）。下次遇到相关服务的问题时将自动召回此案例。`,
          }),
        }],
      };
    },
  );
}

function buildIncidentContent(params: {
  title: string;
  impact: string;
  duration_minutes?: number;
  affected_services: string[];
  affected_users?: string;
  timeline?: Array<{ time: string; event: string }>;
  root_cause: string;
  resolution: string;
  prevention?: string[];
  lessons_learned?: string[];
  doc_url?: string;
}): string {
  const parts: string[] = [
    `故障: ${params.title}`,
    `影响等级: ${params.impact}`,
    ...(params.duration_minutes ? [`持续时长: ${params.duration_minutes} 分钟`] : []),
    `受影响服务: ${params.affected_services.join(', ')}`,
    ...(params.affected_users ? [`影响范围: ${params.affected_users}`] : []),
  ];

  if (params.timeline && params.timeline.length > 0) {
    parts.push('', '--- 时间线 ---');
    for (const entry of params.timeline) {
      parts.push(`  ${entry.time}: ${entry.event}`);
    }
  }

  parts.push('', `根本原因: ${params.root_cause}`);
  parts.push(`修复措施: ${params.resolution}`);

  if (params.prevention && params.prevention.length > 0) {
    parts.push('', '--- 改进措施 ---');
    for (const item of params.prevention) {
      parts.push(`  - ${item}`);
    }
  }

  if (params.lessons_learned && params.lessons_learned.length > 0) {
    parts.push('', '--- 经验教训 ---');
    for (const lesson of params.lessons_learned) {
      parts.push(`  - ${lesson}`);
    }
  }

  if (params.doc_url) {
    parts.push('', `原始文档: ${params.doc_url}`);
  }

  return parts.join('\n');
}
