// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: store_troubleshoot — 排查流程自动积累为知识库

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { MemoryScope, MemorySource } from '@memforgeai/shared';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:store-troubleshoot');

export function registerStoreTroubleshoot(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'store_troubleshoot',
    '将一次完整的问题排查流程存入知识库。记录问题现象、排查路径、使用的工具链、最终原因和修复方案。形成可复用的排查手册。',
    {
      symptom: z.string().describe('问题现象描述（用户看到了什么）'),
      affected_services: z.array(z.string()).describe('受影响的服务列表'),
      investigation_steps: z.array(z.object({
        tool: z.string().describe('使用的工具（如 es-search、SSH、redis-cli、pangu-config）'),
        action: z.string().describe('执行的操作'),
        finding: z.string().describe('发现的结果'),
      })).describe('排查步骤'),
      root_cause: z.string().describe('最终根因'),
      fix: z.string().describe('修复方案'),
      prevention: z.string().optional().describe('预防措施'),
      category: z.enum([
        'service_down', 'performance', 'data_inconsistency',
        'config_error', 'network', 'resource_exhaustion', 'code_bug', 'other',
      ]).default('other').describe('问题分类'),
      product_line: z.string().optional().describe('产品线标识（跨项目共享时指定，如 "my-product"）'),
      tags: z.array(z.string()).optional().describe('额外标签'),
    },
    async ({ symptom, affected_services, investigation_steps, root_cause, fix, prevention, category, product_line, tags }) => {
      const projectId = product_line ?? ctx.gitContext?.projectName ?? 'default';
      const plTag = product_line ? `pl:${product_line.toLowerCase()}` : undefined;

      const content = buildTroubleshootContent({
        symptom, affected_services, investigation_steps, root_cause, fix, prevention, category,
      });

      const title = `[排查手册] ${symptom.slice(0, 80)}${symptom.length > 80 ? '...' : ''}`;
      const embedding = await ctx.embedding.embedPassage(`${title} ${content}`);

      const dup = await ctx.storage.checkDuplicate(embedding, 0.88);
      if (dup) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: '已存在相似的排查记录',
              existingId: dup.id,
              existingTitle: dup.title,
            }),
          }],
        };
      }

      const toolsUsed = [...new Set(investigation_steps.map(s => s.tool))];

      const entry = await ctx.storage.store({
        projectId,
        branchId: null,
        title,
        content,
        scope: 'debugging_strategy' as MemoryScope,
        source: 'bug_fix' as MemorySource,
        tags: [
          ...(tags ?? []),
          ...(plTag ? [plTag] : []),
          'troubleshoot', `category:${category}`,
          ...affected_services.map(s => `service:${s}`),
          ...toolsUsed.map(t => `tool:${t}`),
        ],
        embedding,
        metadata: {
          symptom,
          affectedServices: affected_services,
          category,
          toolsUsed,
          stepsCount: investigation_steps.length,
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
        category,
        services: affected_services,
        steps: investigation_steps.length,
      }, '排查流程已存入知识库');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            id: entry.id,
            title: entry.title,
            message: `排查流程已存入知识库（${investigation_steps.length} 步骤、${affected_services.length} 个服务）。下次遇到类似问题将自动推荐排查路径。`,
          }),
        }],
      };
    },
  );
}

function buildTroubleshootContent(params: {
  symptom: string;
  affected_services: string[];
  investigation_steps: Array<{ tool: string; action: string; finding: string }>;
  root_cause: string;
  fix: string;
  prevention?: string;
  category: string;
}): string {
  const parts: string[] = [
    `问题现象: ${params.symptom}`,
    `分类: ${params.category}`,
    `受影响服务: ${params.affected_services.join(', ')}`,
    '',
    '--- 排查路径 ---',
  ];

  for (let i = 0; i < params.investigation_steps.length; i++) {
    const step = params.investigation_steps[i];
    parts.push(`${i + 1}. [${step.tool}] ${step.action}`);
    parts.push(`   → ${step.finding}`);
  }

  parts.push('');
  parts.push(`根因: ${params.root_cause}`);
  parts.push(`修复: ${params.fix}`);

  if (params.prevention) {
    parts.push(`预防: ${params.prevention}`);
  }

  return parts.join('\n');
}
