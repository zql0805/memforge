// Created by dev on 2026/06/01
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, validateScanPath } from '@memforgeai/shared';
import type { ToolContext } from './types.js';
import { installGitHooks } from '../auto/git-hooks-installer.js';

const logger = getLogger('tool:install-git-hooks');

export function registerInstallGitHooks(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'install_git_hooks',
    '为指定 Git 仓库安装/更新 Memforge post-commit & post-merge hooks。token 绑定产品线，自动嵌入脚本。IDE Rule 在会话首次交互时自动调用。',
    {
      project_root: z.string().describe('Git 仓库的绝对路径（Cursor 工作区根目录）'),
    },
    async ({ project_root }) => {
      let validatedRoot: string;
      try {
        validatedRoot = validateScanPath(project_root);
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `路径校验失败: ${(err as Error).message}`,
          }],
          isError: true,
        };
      }

      try {
        const result = await installGitHooks(validatedRoot, ctx.userId);

        if (result.productLineSkipped) {
          return {
            content: [{
              type: 'text' as const,
              text: `仓库 ${validatedRoot} 不在当前 Memforge 实例的产品线中，跳过 hook 安装。`,
            }],
          };
        }

        const parts: string[] = [];
        if (result.installed.length > 0) parts.push(`新安装: ${result.installed.join(', ')}`);
        if (result.updated.length > 0) parts.push(`已更新: ${result.updated.join(', ')}`);
        if (result.skipped.length > 0) parts.push(`已是最新: ${result.skipped.join(', ')}`);
        if (result.userHookPreserved.length > 0) parts.push(`保留用户 hook: ${result.userHookPreserved.join(', ')}`);

        const summary = parts.length > 0 ? parts.join('；') : '无变更';
        logger.info({ project_root: validatedRoot, summary }, 'install_git_hooks 执行完成');

        return {
          content: [{
            type: 'text' as const,
            text: `Git hooks 安装结果: ${summary}`,
          }],
        };
      } catch (err) {
        const msg = (err as Error).message;
        logger.error({ err: msg, project_root: validatedRoot }, 'install_git_hooks 失败');
        return {
          content: [{
            type: 'text' as const,
            text: `Git hooks 安装失败: ${msg}`,
          }],
          isError: true,
        };
      }
    },
  );
}
