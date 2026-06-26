// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';

const logger = getLogger('tool:discover');

export function registerDiscoverRules(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'discover_rules',
    '分析代码变更和 Code Review 评论，自动发现潜在的编码规则候选。M2 基于模式匹配+语义，M4 将引入 LLM 增强。',
    {
      source_type: z.string().describe('规则发现来源: code_review/bug_fix/codebase_scan'),
      content: z.string().describe('要分析的内容（Code Review 评论、Bug 修复 diff、代码片段等）'),
      language: z.string().optional().describe('编程语言'),
      file_path: z.string().optional().describe('文件路径'),
    },
    async (params) => {
      try {
        const candidates = await ctx.discovery.discover(
          params.source_type as 'code_review' | 'bug_fix' | 'codebase_scan',
          params.content,
          params.language,
          params.file_path,
        );

        logger.info({
          sourceType: params.source_type,
          candidatesFound: candidates.length,
        }, 'discover_rules 分析完成');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              candidates,
              total: candidates.length,
              message: candidates.length > 0
                ? `发现 ${candidates.length} 个规则候选。可使用 propose_rule 将其正式提议。`
                : '未发现匹配的规则候选。',
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'discover_rules 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
