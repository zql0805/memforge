// Created by dev on 2026/04/08
// Copyright © 2026

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, getPool, buildProjectCascade, recordAppliedForRules } from '@memforgeai/shared';
import type { RuleType } from '@memforgeai/shared';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:get-system-rules');

interface Rule {
  id: string;
  title: string;
  description: string;
  rationale: string | null;
  exampleGood: string | null;
  exampleBad: string | null;
  category: string;
  language: string | null;
  severity: string;
  ruleType: RuleType;
}

interface MemoryStandard {
  id: string;
  title: string;
  content: string;
  scope: string;
  tags: string[];
}

export function registerGetSystemRules(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'get_system_rules',
    '获取当前项目所有 always-apply 系统规则（编码规则 + 编码规范），适用于非 Cursor IDE 在会话开始时注入全部规则上下文。',
    {
      product_line: z.string().optional().describe('产品线（如 "my-product"），用于项目级联过滤'),
      include: z.array(z.enum(['rules', 'coding_rules', 'memories', 'all'])).optional()
        .describe('包含哪些规则源：rules（Rules Engine 规则）、memories（记忆库中的编码规范）、all（默认全部）。coding_rules 为 rules 的别名，向后兼容'),
      format: z.enum(['prompt', 'json']).optional().describe('输出格式：prompt（AI 友好文本，默认）或 json'),
      max_rules: z.number().optional().describe('最大返回规则数（默认 200）'),
      rule_types: z.array(z.enum(['coding', 'ai_agent', 'workflow', 'business', 'infra'])).optional()
        .describe('从 memory.rules 拉取时按 rule_type 过滤。不传则返回全部类型'),
      language: z.string().optional()
        .describe('按语言过滤 coding 类规则（如 "java"、"php"、"typescript"）。ai_agent/workflow 等通用类型不受语言过滤影响'),
      team_filter: z.array(z.string()).optional()
        .describe('按团队 ID 过滤规则：仅返回 global/product_line 级 + 指定团队的 team 级规则。不传则返回所有可见级别'),
    },
    async (params) => {
      try {
        const pool = getPool();
        const projectIds = buildProjectCascade(
          ctx.gitContext?.projectName,
          params.product_line,
        );
        const outputFormat = params.format ?? 'prompt';
        const maxRules = Math.min(params.max_rules ?? 200, 500);
        const includes = params.include ?? ['all'];
        const includeAll = includes.includes('all');
        const includeRules = includeAll || includes.includes('rules') || includes.includes('coding_rules');
        const includeMemories = includeAll || includes.includes('memories');

        let codingRules: Rule[] = [];
        let memoryStandards: MemoryStandard[] = [];

        if (includeRules) {
          const teamFilter = params.team_filter && params.team_filter.length > 0
            ? { teamIds: params.team_filter, userId: ctx.userId ?? undefined }
            : (ctx.teamId ? { teamIds: [ctx.teamId], userId: ctx.userId ?? undefined } : undefined);
          codingRules = await fetchActiveRules(pool, projectIds, maxRules, (params.rule_types ?? []) as RuleType[], params.language, teamFilter);
        }

        if (includeMemories) {
          const remaining = maxRules - codingRules.length;
          if (remaining > 0) {
            const memTeamFilter = params.team_filter && params.team_filter.length > 0
              ? { teamIds: params.team_filter, userId: ctx.userId ?? undefined }
              : (ctx.teamId ? { teamIds: [ctx.teamId], userId: ctx.userId ?? undefined } : undefined);
            memoryStandards = await fetchCodingStandardMemories(pool, projectIds, remaining, memTeamFilter);
          }
        }

        const totalCount = codingRules.length + memoryStandards.length;
        logger.info({
          codingRules: codingRules.length,
          memories: memoryStandards.length,
          projectIds,
        }, 'get_system_rules 查询完成');

        if (totalCount === 0) {
          const emptyMsg = outputFormat === 'prompt'
            ? '当前项目暂无系统规则。可通过 propose_rule 或 store_memory(scope: "coding_standard") 添加。'
            : JSON.stringify({ success: true, rules: [], memories: [], total: 0 });
          return { content: [{ type: 'text' as const, text: emptyMsg }] };
        }

        const result = outputFormat === 'prompt'
          ? formatAsPrompt(codingRules, memoryStandards)
          : JSON.stringify({
              success: true,
              project: projectIds,
              rules: codingRules.map(r => ({
                id: r.id, title: r.title, description: r.description,
                category: r.category, severity: r.severity, language: r.language,
                ruleType: r.ruleType,
              })),
              memories: memoryStandards.map(m => ({
                id: m.id, title: m.title, content: m.content,
                scope: m.scope, tags: m.tags,
              })),
              total: totalCount,
            });

        // 会话首次加载时记录 applied 事件（去重：同一会话不重复计数）
        if (!ctx.rulesLoadedAt && codingRules.length > 0) {
          const ruleIds = codingRules.map(r => r.id);
          recordAppliedForRules(ruleIds, ctx.userId).catch(err => {
            logger.warn({ err: String(err) }, '记录规则 applied 事件失败（不影响规则加载）');
          });
        }

        ctx.rulesLoadedAt = new Date();
        logger.info({ rulesLoadedAt: ctx.rulesLoadedAt.toISOString() }, '会话级规则加载追踪已更新');

        return { content: [{ type: 'text' as const, text: result }] };
      } catch (error) {
        logger.error({ error }, 'get_system_rules 执行失败');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    },
  );
}

async function fetchActiveRules(
  pool: ReturnType<typeof getPool>,
  projectIds: string[] | undefined,
  limit: number,
  ruleTypes: RuleType[],
  language?: string,
  teamFilter?: { teamIds?: string[]; userId?: string },
): Promise<Rule[]> {
  const bindings: unknown[] = [];
  let projectClause = '';
  if (projectIds && projectIds.length > 0) {
    bindings.push(projectIds);
    projectClause = ` AND project_id = ANY($${bindings.length})`;
  }
  let ruleTypeClause = '';
  if (ruleTypes.length > 0) {
    bindings.push(ruleTypes);
    ruleTypeClause = ` AND rule_type = ANY($${bindings.length})`;
  }

  const langSpecificTypes = ['coding'];
  let languageClause = '';
  if (language) {
    bindings.push(language.toLowerCase());
    bindings.push(langSpecificTypes);
    languageClause = ` AND (rule_type != ALL($${bindings.length}) OR language IS NULL OR LOWER(language) = $${bindings.length - 1})`;
  }

  let visibilityClause = '';
  if (teamFilter) {
    const visClauses: string[] = ["visibility = 'global'", "visibility = 'product_line'"];
    if (teamFilter.teamIds && teamFilter.teamIds.length > 0) {
      bindings.push(teamFilter.teamIds);
      visClauses.push(`(visibility = 'team' AND team_id = ANY($${bindings.length}))`);
    }
    if (teamFilter.userId) {
      bindings.push(teamFilter.userId);
      visClauses.push(`(visibility = 'personal' AND created_by = $${bindings.length})`);
    }
    visibilityClause = ` AND (${visClauses.join(' OR ')})`;
  }

  bindings.push(limit);

  const { rows } = await pool.query<{
    id: string; title: string; description: string; rationale: string | null;
    example_good: string | null; example_bad: string | null;
    category: string; language: string | null; severity: string;
    rule_type: RuleType;
  }>(
    `SELECT id, title, description, rationale, example_good, example_bad,
            category, language, severity, rule_type
     FROM memory.rules
     WHERE status = 'active'${projectClause}${ruleTypeClause}${languageClause}${visibilityClause}
     ORDER BY
       CASE severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
       category, title
     LIMIT $${bindings.length}`,
    bindings,
  );

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    description: r.description,
    rationale: r.rationale,
    exampleGood: r.example_good,
    exampleBad: r.example_bad,
    category: r.category,
    language: r.language,
    severity: r.severity,
    ruleType: r.rule_type,
  }));
}

async function fetchCodingStandardMemories(
  pool: ReturnType<typeof getPool>,
  projectIds: string[] | undefined,
  limit: number,
  teamFilter?: { teamIds?: string[]; userId?: string },
): Promise<MemoryStandard[]> {
  const bindings: unknown[] = [['coding_standard', 'convention']];
  let projectClause = '';
  if (projectIds && projectIds.length > 0) {
    bindings.push(projectIds);
    projectClause = ` AND project_id = ANY($${bindings.length})`;
  }

  let visibilityClause = '';
  if (teamFilter) {
    const visClauses: string[] = ["visibility = 'global'", "visibility = 'product_line'", "visibility IS NULL"];
    if (teamFilter.teamIds && teamFilter.teamIds.length > 0) {
      bindings.push(teamFilter.teamIds);
      visClauses.push(`(visibility = 'team' AND team_id = ANY($${bindings.length}))`);
    }
    if (teamFilter.userId) {
      bindings.push(teamFilter.userId);
      visClauses.push(`(visibility = 'personal' AND created_by = $${bindings.length})`);
    }
    visibilityClause = ` AND (${visClauses.join(' OR ')})`;
  }

  bindings.push(limit);

  const { rows } = await pool.query<{
    id: string; title: string; content: string; scope: string; tags: string[];
  }>(
    `SELECT id, title, content, scope, tags
     FROM memory.entries
     WHERE scope = ANY($1) AND is_archived = false${projectClause}${visibilityClause}
     ORDER BY updated_at DESC
     LIMIT $${bindings.length}`,
    bindings,
  );

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    content: r.content,
    scope: r.scope,
    tags: r.tags ?? [],
  }));
}

const SEVERITY_LABELS: Record<string, string> = {
  critical: 'P0 必须遵守',
  error: 'P1 强烈建议',
  warning: 'P2 建议',
  info: '参考',
};

function formatAsPrompt(rules: Rule[], memories: MemoryStandard[]): string {
  const total = rules.length + memories.length;
  const lines: string[] = [
    `# 系统规则 (共 ${total} 条)`,
    '',
    '以下规则在**所有对话中生效**，请严格遵循。',
    '',
  ];

  if (rules.length > 0) {
    lines.push(`## 编码规则 (${rules.length} 条)`);
    lines.push('');

    for (const r of rules) {
      const label = SEVERITY_LABELS[r.severity] ?? r.severity;
      lines.push(`### [${label}] ${r.title}`);
      lines.push('');
      lines.push(r.description);
      if (r.rationale) {
        lines.push('');
        lines.push(`**原因**: ${r.rationale}`);
      }
      if (r.exampleGood) {
        lines.push('');
        lines.push('**正确**:');
        lines.push('```');
        lines.push(r.exampleGood);
        lines.push('```');
      }
      if (r.exampleBad) {
        lines.push('');
        lines.push('**错误**:');
        lines.push('```');
        lines.push(r.exampleBad);
        lines.push('```');
      }
      lines.push('');
    }
  }

  if (memories.length > 0) {
    lines.push(`## 编码规范 (${memories.length} 条)`);
    lines.push('');

    for (const m of memories) {
      lines.push(`### ${m.title}`);
      if (m.tags.length > 0) {
        lines.push(`> 标签: ${m.tags.join(', ')}`);
      }
      lines.push('');
      lines.push(m.content.length > 2000 ? m.content.slice(0, 2000) + '\n...(已截断)' : m.content);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('以上规则由 Memforge 系统规则引擎提供，适用于当前项目的所有对话。');

  return lines.join('\n');
}
