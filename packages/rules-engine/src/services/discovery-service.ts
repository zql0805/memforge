// Created by dev on 2026/04/04
// Copyright © 2026
// 规则发现服务：基于模式匹配 + 语义相似度的启发式规则候选发现
// M4 将引入 LLM 增强

import { getLogger } from '@memforgeai/shared';
import type { RuleCandidate, RuleCategory, RuleSeverity, RulesConfig, ApiEmbeddingService } from '@memforgeai/shared';
import { RulesPostgresStorage } from '../storage/postgres.js';

const logger = getLogger('discovery');

interface AntiPattern {
  name: string;
  pattern: RegExp;
  category: RuleCategory;
  severity: RuleSeverity;
  titleTemplate: string;
  descriptionTemplate: string;
  languages?: string[];
}

const ANTI_PATTERNS: AntiPattern[] = [
  {
    name: 'loop_db_query',
    pattern: /(?:foreach|for|while)\s*\([^)]*\)\s*\{[^}]*(?:\$this->ctx->getDb|->query|->execute|\.query\(|\.execute\()/is,
    category: 'performance',
    severity: 'error',
    titleTemplate: '禁止在循环内执行数据库查询',
    descriptionTemplate: '在循环体内直接执行数据库查询会导致 N+1 问题，应改为批量查询后在内存中关联。',
    languages: ['php', 'java', 'python'],
  },
  {
    name: 'catch_all_exception',
    pattern: /catch\s*\(\s*(?:Exception|\\\s*Exception|\$e|Throwable|Error)\s*(?:\$\w+)?\s*\)\s*\{[^}]{0,50}\}/is,
    category: 'logic',
    severity: 'warning',
    titleTemplate: '避免吞掉所有异常',
    descriptionTemplate: '捕获宽泛的 Exception/Throwable 而不做有意义处理（如记录日志或重抛），会隐藏潜在 Bug。',
    languages: ['php', 'java'],
  },
  {
    name: 'hardcoded_secret',
    pattern: /(?:password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    category: 'security',
    severity: 'error',
    titleTemplate: '禁止硬编码敏感信息',
    descriptionTemplate: '密码、API Key、Token 等敏感信息不应硬编码在源码中，应使用环境变量或配置中心。',
  },
  {
    name: 'sql_concatenation',
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE)\s+.*(?:\$\w+|'\s*\+\s*\w+|"\s*\+\s*\w+|`\$\{)/i,
    category: 'security',
    severity: 'error',
    titleTemplate: '禁止 SQL 字符串拼接',
    descriptionTemplate: '直接拼接用户输入到 SQL 语句中会导致 SQL 注入漏洞，应使用参数化查询或 Prepared Statement。',
  },
  {
    name: 'no_error_handling',
    pattern: /(?:fetch|axios|http\.get|curl_exec|file_get_contents)\s*\([^)]*\)(?!\s*\.(?:then|catch)|[^;]*(?:try|catch|if))/i,
    category: 'logic',
    severity: 'warning',
    titleTemplate: '网络请求缺少错误处理',
    descriptionTemplate: '外部 HTTP 请求应包含超时设置和错误处理，避免因下游服务不可用导致级联故障。',
  },
  {
    name: 'magic_number',
    pattern: /(?:if|else if|case|return)\s*.*(?<![0-9.])(?:86400|3600|1000|60|24|365|1024|2048|4096)(?![0-9.])/,
    category: 'style',
    severity: 'info',
    titleTemplate: '避免使用魔法数字',
    descriptionTemplate: '代码中直接使用字面数字（如 86400、3600）降低可读性，应定义为命名常量。',
  },
];

const REVIEW_KEYWORDS: Array<{ pattern: RegExp; category: RuleCategory; severity: RuleSeverity }> = [
  { pattern: /(?:应该|需要|必须|建议|推荐).*(?:使用|改为|替换|采用)/i, category: 'convention', severity: 'warning' },
  { pattern: /(?:禁止|不应|不要|避免|不可以).*(?:使用|直接|手动)/i, category: 'convention', severity: 'warning' },
  { pattern: /(?:安全|漏洞|注入|XSS|CSRF|越权)/i, category: 'security', severity: 'error' },
  { pattern: /(?:性能|慢查询|N\+1|内存泄漏|超时)/i, category: 'performance', severity: 'warning' },
];

export class DiscoveryService {
  constructor(
    private storage: RulesPostgresStorage,
    private embedding: ApiEmbeddingService,
    private config: RulesConfig,
  ) {}

  async discover(
    sourceType: 'code_review' | 'bug_fix' | 'codebase_scan',
    content: string,
    language?: string,
    filePath?: string,
  ): Promise<RuleCandidate[]> {
    switch (sourceType) {
      case 'codebase_scan':
        return this.scanForAntiPatterns(content, language, filePath);
      case 'code_review':
        return this.analyzeReviewComment(content, language, filePath);
      case 'bug_fix':
        return this.analyzeBugFix(content, language, filePath);
      default:
        return [];
    }
  }

  private async scanForAntiPatterns(
    code: string,
    language?: string,
    filePath?: string,
  ): Promise<RuleCandidate[]> {
    const candidates: RuleCandidate[] = [];

    for (const ap of ANTI_PATTERNS) {
      if (ap.languages && language && !ap.languages.includes(language)) continue;
      if (!ap.pattern.test(code)) continue;

      const similar = await this.findSimilarRules(ap.titleTemplate + ' ' + ap.descriptionTemplate);

      candidates.push({
        title: ap.titleTemplate,
        description: ap.descriptionTemplate,
        category: ap.category,
        language: language ?? null,
        severity: ap.severity,
        confidence: 0.85,
        sourceRef: { type: 'codebase_scan', pattern: ap.name, filePath },
        similarExistingRules: similar,
      });
    }

    logger.info({ sourceType: 'codebase_scan', found: candidates.length }, '反模式扫描完成');
    return candidates;
  }

  private async analyzeReviewComment(
    comment: string,
    language?: string,
    _filePath?: string,
  ): Promise<RuleCandidate[]> {
    const candidates: RuleCandidate[] = [];

    for (const kw of REVIEW_KEYWORDS) {
      if (!kw.pattern.test(comment)) continue;

      const similar = await this.findSimilarRules(comment);

      candidates.push({
        title: comment.length > 100 ? comment.slice(0, 97) + '...' : comment,
        description: comment,
        category: kw.category,
        language: language ?? null,
        severity: kw.severity,
        confidence: 0.6,
        sourceRef: { type: 'code_review', originalComment: comment },
        similarExistingRules: similar,
      });
      break;
    }

    logger.info({ sourceType: 'code_review', found: candidates.length }, 'Review 评论分析完成');
    return candidates;
  }

  private async analyzeBugFix(
    diff: string,
    language?: string,
    filePath?: string,
  ): Promise<RuleCandidate[]> {
    const candidates: RuleCandidate[] = [];

    // 从 diff 中提取删除行（-）和添加行（+）
    const removedLines = diff.split('\n')
      .filter(l => l.startsWith('-') && !l.startsWith('---'))
      .map(l => l.slice(1).trim())
      .filter(Boolean);

    const addedLines = diff.split('\n')
      .filter(l => l.startsWith('+') && !l.startsWith('+++'))
      .map(l => l.slice(1).trim())
      .filter(Boolean);

    if (removedLines.length === 0 || addedLines.length === 0) return candidates;

    const removedCode = removedLines.join('\n');

    // 检查删除的代码是否匹配已知反模式
    for (const ap of ANTI_PATTERNS) {
      if (ap.languages && language && !ap.languages.includes(language)) continue;
      if (!ap.pattern.test(removedCode)) continue;

      const similar = await this.findSimilarRules(ap.titleTemplate + ' ' + ap.descriptionTemplate);

      candidates.push({
        title: `[Bug修复发现] ${ap.titleTemplate}`,
        description: `通过 Bug 修复 diff 发现：旧代码包含 "${ap.name}" 反模式。${ap.descriptionTemplate}`,
        category: ap.category,
        language: language ?? null,
        severity: ap.severity,
        confidence: 0.75,
        sourceRef: { type: 'bug_fix', pattern: ap.name, filePath },
        similarExistingRules: similar,
      });
    }

    logger.info({ sourceType: 'bug_fix', found: candidates.length }, 'Bug 修复分析完成');
    return candidates;
  }

  private async findSimilarRules(
    text: string,
  ): Promise<Array<{ id: string; title: string; similarity: number }>> {
    const embedding = await this.embedding.embedPassage(text);
    const results = await this.storage.searchRuleEmbeddings(embedding, 0.6);
    const topResults = results.slice(0, 3);
    if (topResults.length === 0) return [];

    const rules = await this.storage.getRulesByIds(topResults.map(r => r.id));
    const ruleMap = new Map(rules.map(r => [r.id, r]));

    return topResults.map(r => ({
      id: r.id,
      title: ruleMap.get(r.id)?.title ?? 'unknown',
      similarity: Math.round(r.similarity * 1000) / 1000,
    }));
  }
}
