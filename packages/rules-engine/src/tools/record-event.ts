// Created by dev on 2026/04/04
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { RuleEventType } from '@memforgeai/shared';
import type { RulesToolContext } from './types.js';

const logger = getLogger('tool:record-event');

export function registerRecordRuleEvent(server: McpServer, ctx: RulesToolContext): void {
  server.tool(
    'record_rule_event',
    '记录规则应用/违反/采纳/拒绝事件。用于追踪规则效果度量。',
    {
      rule_id: z.string().describe('规则 ID'),
      event_type: z.enum(['applied', 'violated', 'accepted', 'rejected', 'auto_fixed']).describe('事件类型'),
      file_path: z.string().optional().describe('相关文件路径'),
      code_snippet: z.string().optional().describe('相关代码片段'),
      user_id: z.string().optional().describe('（已忽略，操作人由 Gateway 身份决定）'),
      metadata: z.record(z.unknown()).optional().describe('附加元数据'),
    },
    async (params) => {
      try {
        const rule = await ctx.storage.getRuleById(params.rule_id);
        if (!rule) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: '规则不存在' }) }],
          };
        }

        const event = await ctx.storage.recordEvent({
          ruleId: params.rule_id,
          eventType: params.event_type as RuleEventType,
          filePath: params.file_path ?? null,
          codeSnippet: params.code_snippet ?? null,
          userId: ctx.userId ?? null,
          metadata: params.metadata ?? {},
        });

        logger.info({ ruleId: params.rule_id, eventType: params.event_type }, '规则事件已记录');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              eventId: event.id,
              ruleId: event.ruleId,
              eventType: event.eventType,
              message: `事件 ${event.eventType} 已记录。`,
            }),
          }],
        };
      } catch (error) {
        logger.error({ error }, 'record_rule_event 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}
