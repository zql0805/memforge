// Created by dev on 2026/05/14
// MCP 工具: extract_coding_standards — 从 Git 历史提交中批量提取编码规范候选
// 扫描 from-commit 记忆中的 bugfix/security/refactor 类型提交，
// 通过模式匹配识别反模式，生成可被 propose_rule 采纳的规则候选

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger, getPool } from '@memforgeai/shared';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:extract-coding-standards');

interface AntiPattern {
  name: string;
  pattern: RegExp;
  category: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  description: string;
  languages?: string[];
}

const ANTI_PATTERNS: AntiPattern[] = [
  {
    name: 'loop_db_query',
    pattern: /(?:foreach|for|while)\s*\([^)]*\)\s*\{[^}]*(?:\$this->ctx->getDb|->query|->execute|\.query\(|\.execute\()/is,
    category: 'performance',
    severity: 'error',
    title: '禁止在循环内执行数据库查询',
    description: '循环内直接执行 DB 查询导致 N+1 问题，应改为批量查询后内存关联。',
  },
  {
    name: 'catch_all_exception',
    pattern: /catch\s*\(\s*(?:Exception|\\\s*Exception|Throwable)\s*\$?\w*\s*\)\s*\{[^}]{0,50}\}/is,
    category: 'logic',
    severity: 'warning',
    title: '避免吞掉所有异常',
    description: '捕获宽泛的 Exception/Throwable 不做处理会隐藏 Bug，应精确捕获并记录日志。',
    languages: ['php', 'java'],
  },
  {
    name: 'hardcoded_secret',
    pattern: /(?:password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    category: 'security',
    severity: 'error',
    title: '禁止硬编码敏感信息',
    description: '密码/API Key/Token 应使用环境变量或配置中心，不应硬编码在源码中。',
  },
  {
    name: 'sql_concatenation',
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE)\s+.*(?:\$\w+|'\s*\+\s*\w+|"\s*\+\s*\w+|`\$\{)/i,
    category: 'security',
    severity: 'error',
    title: '禁止 SQL 字符串拼接',
    description: '直接拼接用户输入到 SQL 中会导致注入，应使用参数化查询。',
  },
  {
    name: 'redis_set_expire_non_atomic',
    pattern: /(?:->set\([^)]+\)[\s\S]{0,100}->expire\(|\.set\([^)]+\)[\s\S]{0,100}\.expire\()/i,
    category: 'logic',
    severity: 'warning',
    title: 'Redis set + expire 非原子操作',
    description: 'set 和 expire 分两步执行有并发风险，应使用 setex/set EX 或 Lua 脚本。',
  },
  {
    name: 'missing_timeout',
    pattern: /(?:curl_exec|file_get_contents|Http::|\$http->|fetch\(|axios\.)(?:(?!timeout).){0,200}$/ims,
    category: 'logic',
    severity: 'warning',
    title: '外部调用缺少超时设置',
    description: 'HTTP/RPC 请求应设置合理超时，避免下游不可用导致级联故障。',
  },
  {
    name: 'select_star',
    pattern: /SELECT\s+\*\s+FROM/i,
    category: 'performance',
    severity: 'info',
    title: '避免 SELECT * 全字段查询',
    description: '显式列出所需字段可减少网络开销和内存占用，也有利于索引覆盖。',
  },
];

interface RuleCandidate {
  title: string;
  description: string;
  category: string;
  severity: string;
  confidence: number;
  sourceCommits: Array<{ hash: string; repoId: string; title: string }>;
  matchedPattern: string;
}

export function registerExtractCodingStandards(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'extract_coding_standards',
    '从 Git 历史提交（from-commit 记忆）中批量扫描反模式，自动发现编码规范候选。返回候选列表，可配合 propose_rule 正式提议。',
    {
      product_line: z.string().optional().describe('产品线过滤（不传则扫描全部）'),
      categories: z.array(z.string()).optional().describe('提交分类过滤，默认 bugfix/security/refactor'),
      limit: z.number().optional().describe('扫描记忆条数上限，默认 200'),
      min_confidence: z.number().optional().describe('最低置信度阈值，默认 0.5'),
    },
    async ({ product_line, categories, limit, min_confidence }) => {
      try {
        const cats = categories ?? ['bugfix', 'security', 'refactor', 'performance'];
        const maxScan = Math.min(limit ?? 200, 500);
        const minConf = min_confidence ?? 0.5;

        const candidates = await scanCommitMemories(
          product_line ?? null,
          cats,
          maxScan,
          minConf,
          ctx.userId,
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              scannedCategories: cats,
              totalCandidates: candidates.length,
              candidates,
              hint: candidates.length > 0
                ? '可使用 propose_rule 将候选正式提议为编码规则。'
                : '未从 Git 历史中发现新的反模式。如有更多 bugfix 类提交，可运行 bootstrap_project_history 增加数据。',
            }, null, 2),
          }],
        };
      } catch (err) {
        logger.error({ error: err }, 'extract_coding_standards 失败');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: (err as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );
}

async function scanCommitMemories(
  productLine: string | null,
  categories: string[],
  limit: number,
  minConfidence: number,
  userId: string | null,
): Promise<RuleCandidate[]> {
  const pool = getPool();

  let plClause = '';
  const bindings: unknown[] = [];
  let paramIdx = 1;

  if (userId) {
    plClause += ` AND (created_by = $${paramIdx} OR created_by IS NULL)`;
    bindings.push(userId);
    paramIdx++;
  }

  if (productLine) {
    plClause += ` AND project_id = $${paramIdx}`;
    bindings.push(productLine);
    paramIdx++;
  }

  plClause += ` AND metadata->>'category' = ANY($${paramIdx})`;
  bindings.push(categories);
  paramIdx++;

  const { rows } = await pool.query<{
    id: string;
    title: string;
    content: string;
    metadata: Record<string, unknown>;
  }>(`
    SELECT id, title, content, metadata
    FROM memory.entries
    WHERE tags @> ARRAY['from-commit']
      AND is_archived = false
      ${plClause}
    ORDER BY created_at DESC
    LIMIT $${paramIdx}
  `, [...bindings, limit]);

  const candidateMap = new Map<string, RuleCandidate>();

  for (const row of rows) {
    const content = row.content ?? '';

    for (const ap of ANTI_PATTERNS) {
      ap.pattern.lastIndex = 0;
      if (!ap.pattern.test(content)) continue;

      const existing = candidateMap.get(ap.name);
      const commitRef = {
        hash: (row.metadata?.commitHash as string)?.substring(0, 8) ?? row.id.substring(0, 8),
        repoId: (row.metadata?.source_repo_id as string) ?? (row.metadata?.repo_id as string) ?? 'unknown',
        title: row.title,
      };

      if (existing) {
        existing.sourceCommits.push(commitRef);
        existing.confidence = Math.min(1.0, existing.confidence + 0.1);
      } else {
        candidateMap.set(ap.name, {
          title: ap.title,
          description: ap.description,
          category: ap.category,
          severity: ap.severity,
          confidence: 0.6,
          sourceCommits: [commitRef],
          matchedPattern: ap.name,
        });
      }
    }
  }

  return Array.from(candidateMap.values())
    .filter(c => c.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence || b.sourceCommits.length - a.sourceCommits.length);
}
