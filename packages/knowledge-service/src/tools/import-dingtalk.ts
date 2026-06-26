// Created by dev on 2026/05/25
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import { DingTalkImporter } from '../import/dingtalk-importer.js';
import type { DingTalkConfig } from '../import/dingtalk-client.js';
import type { KnowledgeToolContext } from './types.js';

const logger = getLogger('knowledge:tool:import-dingtalk');

export function registerImportDingtalk(server: McpServer, ctx: KnowledgeToolContext): void {
  server.tool(
    'import_dingtalk_docs',
    'Import documents from DingTalk Wiki (知识库) into Memforge knowledge base. Walks the folder tree, converts document blocks to Markdown, and stores as knowledge items with deduplication.',
    {
      root_node_id: z.string().describe('Root node ID of the DingTalk Wiki workspace or folder to import from'),
      product_line: z.string().describe('Product line for the imported knowledge items'),
      max_depth: z.number().optional().default(5).describe('Maximum folder depth to traverse (default: 5)'),
      dry_run: z.boolean().optional().default(false).describe('If true, only list documents without importing'),
      folder_filter: z.array(z.string()).optional().describe('Only import docs under these folder paths (e.g. ["产品相关", "运营相关"])'),
      doc_type_filter: z.array(z.string()).optional().describe('Only import docs with these extensions (e.g. [".adoc", ".asheet"])'),
    },
    async (args) => {
      const appKey = process.env.DINGTALK_APP_KEY;
      const appSecret = process.env.DINGTALK_APP_SECRET;
      const operatorId = process.env.DINGTALK_OPERATOR_ID;

      if (!appKey || !appSecret || !operatorId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: '缺少钉钉配置：需要设置 DINGTALK_APP_KEY, DINGTALK_APP_SECRET, DINGTALK_OPERATOR_ID 环境变量',
            }),
          }],
        };
      }

      const config: DingTalkConfig = { appKey, appSecret, operatorId };
      const importer = new DingTalkImporter(config, ctx.storage);

      try {
        const result = await importer.import({
          rootNodeId: args.root_node_id,
          productLine: args.product_line,
          maxDepth: args.max_depth,
          dryRun: args.dry_run,
          folderFilter: args.folder_filter,
          docTypeFilter: args.doc_type_filter,
        }, ctx.userId);

        logger.info({
          rootNodeId: args.root_node_id,
          productLine: args.product_line,
          ...result,
          details: undefined,
        }, 'DingTalk import tool completed');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              total: result.total,
              imported: result.imported,
              skipped: result.skipped,
              errors: result.errors,
              details: result.details.slice(0, 50),
            }, null, 2),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, rootNodeId: args.root_node_id }, 'DingTalk import failed');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: msg }),
          }],
        };
      }
    },
  );
}
