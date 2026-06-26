import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, getPool } from '@memforgeai/shared';
import { randomBytes, createHash } from 'node:crypto';
import type { ToolContext } from './types.js';

function hashSecret(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

const logger = getLogger('tool:setup-gitlab-webhooks');

const ALLOWED_GITLAB_HOSTS = new Set(
  (process.env.GITLAB_ALLOWED_HOSTS || 'gitlab.example.com').split(',').map(h => h.trim()),
);

function validateGitlabUrl(url: string): string {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error(`不支持的协议: ${parsed.protocol}`);
  }
  if (!ALLOWED_GITLAB_HOSTS.has(parsed.hostname)) {
    throw new Error(`GitLab 实例 ${parsed.hostname} 不在允许列表中 (${[...ALLOWED_GITLAB_HOSTS].join(', ')})`);
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function registerSetupGitlabWebhooks(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'setup_gitlab_webhooks',
    '为指定 GitLab 项目配置 Memforge Code Review Webhook。自动创建 webhook 并记录配置到数据库。',
    {
      gitlab_url: z.string().default('https://gitlab.example.com').describe('GitLab 实例 URL'),
      project_paths: z.array(z.string()).describe('GitLab 项目路径列表（如 ["group/project"]）'),
      product_line: z.string().optional().describe('产品线标识'),
      events: z.array(z.string()).default(['push_events', 'merge_requests_events']).describe('要监听的事件类型'),
    },
    async (params) => {
      const privateToken = process.env.GITLAB_PRIVATE_TOKEN;
      if (!privateToken) {
        return {
          content: [{ type: 'text' as const, text: 'GITLAB_PRIVATE_TOKEN 未配置，无法创建 webhook' }],
          isError: true,
        };
      }

      let gitlabBase: string;
      try {
        gitlabBase = validateGitlabUrl(params.gitlab_url);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `GitLab URL 验证失败: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const gatewayUrl = process.env.MEMFORGE_GATEWAY_URL || process.env.GATEWAY_URL;
      if (!gatewayUrl) {
        return {
          content: [{ type: 'text' as const, text: 'MEMFORGE_GATEWAY_URL 未配置，无法生成 webhook 回调地址' }],
          isError: true,
        };
      }

      const webhookUrl = `${gatewayUrl}/api/hooks/gitlab-webhook`;
      const pool = getPool();
      const results: Array<{ project: string; status: string; webhookId?: number; error?: string }> = [];

      for (const projectPath of params.project_paths) {
        try {
          const existing = await pool.query(
            `SELECT id, webhook_id FROM memory.webhook_configs
             WHERE platform = 'gitlab' AND instance_url = $1 AND project_path = $2`,
            [gitlabBase, projectPath],
          );

          if (existing.rows.length > 0 && existing.rows[0].webhook_id) {
            results.push({ project: projectPath, status: 'already_configured', webhookId: existing.rows[0].webhook_id });
            continue;
          }

          const secret = randomBytes(32).toString('hex');
          const encodedPath = encodeURIComponent(projectPath);

          const eventBody: Record<string, unknown> = {
            url: webhookUrl,
            token: secret,
            enable_ssl_verification: true,
          };
          for (const event of params.events) {
            eventBody[event] = true;
          }

          const resp = await fetch(
            `${gitlabBase}/api/v4/projects/${encodedPath}/hooks`,
            {
              method: 'POST',
              headers: { 'PRIVATE-TOKEN': privateToken, 'Content-Type': 'application/json' },
              body: JSON.stringify(eventBody),
            },
          );

          if (!resp.ok) {
            const errText = await resp.text();
            results.push({ project: projectPath, status: 'failed', error: `GitLab API ${resp.status}: ${errText}` });
            continue;
          }

          const hookData = (await resp.json()) as { id: number };

          await pool.query(
            `INSERT INTO memory.webhook_configs
               (platform, instance_url, project_path, product_line, webhook_id, webhook_secret, webhook_secret_hash, events, created_by, user_id)
             VALUES ('gitlab', $1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (platform, instance_url, project_path)
             DO UPDATE SET webhook_id = $4, webhook_secret = '***', webhook_secret_hash = $6, events = $7, updated_at = NOW(), is_active = TRUE`,
            [gitlabBase, projectPath, params.product_line ?? null, hookData.id, '***', hashSecret(secret), params.events, ctx.userId ?? null, ctx.userId ?? null],
          );

          results.push({ project: projectPath, status: 'created', webhookId: hookData.id });
          logger.info({ project: projectPath, webhookId: hookData.id }, 'GitLab webhook 创建成功');
        } catch (err) {
          const msg = (err as Error).message;
          logger.error({ err: msg, project: projectPath }, 'Webhook 配置失败');
          results.push({ project: projectPath, status: 'error', error: msg });
        }
      }

      const summary = results.map(r => {
        if (r.status === 'created') return `✅ ${r.project}: 已创建 (hook #${r.webhookId})`;
        if (r.status === 'already_configured') return `⏭️ ${r.project}: 已存在 (hook #${r.webhookId})`;
        return `❌ ${r.project}: ${r.error ?? r.status}`;
      }).join('\n');

      return {
        content: [{ type: 'text' as const, text: `Webhook 配置结果:\n${summary}` }],
      };
    },
  );
}
