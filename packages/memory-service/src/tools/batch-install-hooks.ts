import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, validateScanPath } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { installGitHooks } from '../auto/git-hooks-installer.js';

const logger = getLogger('tool:batch-install-hooks');

export function registerBatchInstallHooks(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'batch_install_hooks',
    '批量为多个 Git 仓库安装 Memforge post-commit & post-merge hooks。支持从产品线拓扑自动获取仓库列表。',
    {
      project_roots: z.array(z.string()).describe('Git 仓库绝对路径列表'),
    },
    async (params) => {
      const results: Array<{ root: string; status: string; detail?: string }> = [];

      for (const root of params.project_roots) {
        try {
          const validatedRoot = validateScanPath(root);
          const result = await installGitHooks(validatedRoot, ctx.userId);

          if (result.productLineSkipped) {
            results.push({ root, status: 'skipped', detail: '不在当前产品线中' });
            continue;
          }

          const parts: string[] = [];
          if (result.installed.length > 0) parts.push(`新安装: ${result.installed.join(', ')}`);
          if (result.updated.length > 0) parts.push(`已更新: ${result.updated.join(', ')}`);
          if (result.skipped.length > 0) parts.push(`已是最新: ${result.skipped.join(', ')}`);
          if (result.userHookPreserved.length > 0) parts.push(`保留用户 hook: ${result.userHookPreserved.join(', ')}`);

          results.push({ root, status: 'ok', detail: parts.join('；') || '无变更' });
        } catch (err) {
          const msg = (err as Error).message;
          logger.warn({ err: msg, root }, 'batch_install_hooks 单仓库失败');
          results.push({ root, status: 'error', detail: msg });
        }
      }

      const ok = results.filter(r => r.status === 'ok').length;
      const skipped = results.filter(r => r.status === 'skipped').length;
      const failed = results.filter(r => r.status === 'error').length;

      const summary = results.map(r => {
        const icon = r.status === 'ok' ? '✅' : r.status === 'skipped' ? '⏭️' : '❌';
        return `${icon} ${r.root}: ${r.detail ?? r.status}`;
      }).join('\n');

      return {
        content: [{
          type: 'text' as const,
          text: `批量安装完成: ${ok} 成功, ${skipped} 跳过, ${failed} 失败\n\n${summary}`,
        }],
      };
    },
  );
}
