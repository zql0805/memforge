// Created by dev on 2026/04/05
// Copyright © 2026
// MCP 工具: learn_from_review — 从 Code Review 评论中提取团队规范

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLogger } from '@memforgeai/shared';
import type { MemoryScope } from '@memforgeai/shared';
import type { ToolContext } from './types.js';

const logger = getLogger('tool:learn-from-review');

export function registerLearnFromReview(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'learn_from_review',
    '从 Code Review 评论中提取团队编码规范和最佳实践。将反复出现的 Review 意见转化为记忆或编码规范候选。',
    {
      comments: z.array(z.object({
        reviewer: z.string().describe('评审者'),
        comment: z.string().describe('Review 评论内容'),
        file_path: z.string().optional().describe('相关文件路径'),
        code_snippet: z.string().optional().describe('相关代码片段'),
        severity: z.enum(['must-fix', 'suggestion', 'nit']).optional().describe('严重程度'),
      })).describe('Code Review 评论列表'),
      pr_title: z.string().optional().describe('PR 标题'),
      pr_url: z.string().optional().describe('PR 链接'),
      product_line: z.string().optional().describe('产品线标识，不传则从 Git 上下文推断项目名'),
    },
    async ({ comments, pr_title, pr_url, product_line }) => {
      const projectId = product_line ?? ctx.gitContext?.projectName ?? 'default';
      const results: ReviewInsight[] = [];

      const categorized = categorizeComments(comments);

      for (const group of categorized) {
        if (group.comments.length === 0) continue;

        const title = `[Code Review] ${group.category}: ${group.summary}`;
        const content = buildReviewContent(group, pr_title, pr_url);

        const scanResult = ctx.scanner.scan(content);
        if (scanResult.blocked) continue;

        const embedding = await ctx.embedding.embedPassage(`${title} ${scanResult.sanitizedContent ?? content}`);

        const duplicate = await ctx.storage.checkDuplicate(embedding, 0.88);
        if (duplicate) {
          results.push({
            category: group.category,
            summary: group.summary,
            action: '已存在类似记忆，跳过',
            duplicateOf: duplicate.id,
          });
          continue;
        }

        let resolvedProjectId: string;
        if (group.visibility === 'global') {
          resolvedProjectId = '_global_';
        } else if (group.visibility === 'product_line' && product_line) {
          resolvedProjectId = product_line;
        } else {
          resolvedProjectId = projectId;
        }

        await ctx.storage.store({
          projectId: resolvedProjectId,
          branchId: ctx.gitContext?.branchName ?? null,
          title,
          content: scanResult.sanitizedContent ?? content,
          scope: group.scope as MemoryScope,
          source: 'code_review',
          tags: ['from-review', group.category, ...(pr_url ? [`pr:${pr_url}`] : [])],
          embedding,
          metadata: {
            reviewers: [...new Set(group.comments.map((c) => c.reviewer))],
            prTitle: pr_title,
            prUrl: pr_url,
            commentCount: group.comments.length,
            learnedAt: new Date().toISOString(),
            source_project: ctx.gitContext?.projectName ?? product_line ?? 'unknown',
            source_product_line: product_line ?? null,
            visibility: group.visibility,
          },
          isArchived: false,
          archivedReason: null,
          createdBy: ctx.userId,
          expiresAt: null,
          orgId: ctx.orgId || null,
          teamId: null,
          visibility: group.visibility,
        });

        results.push({
          category: group.category,
          summary: group.summary,
          action: '已存入记忆',
          isRuleCandidate: group.isRuleCandidate,
        });
      }

      const ruleCandidates = results.filter((r) => r.isRuleCandidate);

      logger.info({
        comments: comments.length,
        insights: results.length,
        ruleCandidates: ruleCandidates.length,
      }, 'Review 学习完成');

      const summary: Record<string, unknown> = {
        totalComments: comments.length,
        insightsExtracted: results.length,
        results,
      };

      if (ruleCandidates.length > 0) {
        summary.ruleCandidateHint = `发现 ${ruleCandidates.length} 条可能的编码规范候选。`
          + `可使用 propose_rule 工具将其正式提议为团队编码规范。`;
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(summary, null, 2),
        }],
      };
    },
  );
}

interface ReviewComment {
  reviewer: string;
  comment: string;
  file_path?: string;
  code_snippet?: string;
  severity?: string;
}

interface CommentGroup {
  category: string;
  scope: string;
  summary: string;
  comments: ReviewComment[];
  isRuleCandidate: boolean;
  visibility: 'global' | 'product_line' | 'personal';
}

interface ReviewInsight {
  category: string;
  summary: string;
  action: string;
  duplicateOf?: string;
  isRuleCandidate?: boolean;
}

function categorizeComments(comments: ReviewComment[]): CommentGroup[] {
  const groups: Map<string, CommentGroup> = new Map();

  for (const comment of comments) {
    const cat = detectCategory(comment.comment);

    if (!groups.has(cat.category)) {
      groups.set(cat.category, {
        category: cat.category,
        scope: cat.scope,
        summary: '',
        comments: [],
        isRuleCandidate: false,
        visibility: cat.visibility,
      });
    }

    const group = groups.get(cat.category)!;
    group.comments.push(comment);

    if (comment.severity === 'must-fix') {
      group.isRuleCandidate = true;
    }
  }

  for (const group of groups.values()) {
    group.summary = group.comments[0].comment.substring(0, 80);
    if (group.comments.length >= 2) {
      group.isRuleCandidate = true;
    }
  }

  return Array.from(groups.values());
}

function detectCategory(comment: string): { category: string; scope: string; visibility: 'global' | 'product_line' | 'personal' } {
  const lower = comment.toLowerCase();

  // 安全类 → 全局（安全规范必须全项目执行）
  if (lower.includes('security') || lower.includes('安全') || lower.includes('sql injection') || lower.includes('xss')) {
    return { category: 'security', scope: 'coding_standard', visibility: 'global' };
  }
  // 异常处理 → 全局（通用编码规范）
  if (lower.includes('error handling') || lower.includes('异常') || lower.includes('try') || lower.includes('catch')) {
    return { category: 'error-handling', scope: 'coding_standard', visibility: 'global' };
  }
  // 性能 → 产品线（同技术栈共享）
  if (lower.includes('performance') || lower.includes('性能') || lower.includes('n+1') || lower.includes('slow')) {
    return { category: 'performance', scope: 'performance_insight', visibility: 'product_line' };
  }
  // 命名/风格/测试 → 产品线（团队约定）
  if (lower.includes('naming') || lower.includes('命名') || lower.includes('变量名')) {
    return { category: 'naming', scope: 'convention', visibility: 'product_line' };
  }
  if (lower.includes('test') || lower.includes('测试') || lower.includes('覆盖率')) {
    return { category: 'testing', scope: 'coding_standard', visibility: 'product_line' };
  }
  if (lower.includes('style') || lower.includes('格式') || lower.includes('indent')) {
    return { category: 'style', scope: 'convention', visibility: 'product_line' };
  }
  if (lower.includes('logic') || lower.includes('逻辑') || lower.includes('bug') || lower.includes('边界')) {
    return { category: 'logic', scope: 'bug_pattern', visibility: 'product_line' };
  }
  if (lower.includes('architect') || lower.includes('架构') || lower.includes('设计模式') || lower.includes('重构')) {
    return { category: 'architecture', scope: 'architecture', visibility: 'product_line' };
  }

  return { category: 'general', scope: 'review_insight', visibility: 'personal' };
}

function buildReviewContent(group: CommentGroup, prTitle?: string, prUrl?: string): string {
  const parts: string[] = [];

  if (prTitle) parts.push(`PR: ${prTitle}`);
  if (prUrl) parts.push(`链接: ${prUrl}`);

  parts.push(`类别: ${group.category}`);
  parts.push(`评论数: ${group.comments.length}`);
  parts.push('');

  for (const comment of group.comments) {
    parts.push(`[${comment.reviewer}]: ${comment.comment}`);
    if (comment.file_path) parts.push(`  文件: ${comment.file_path}`);
    if (comment.code_snippet) parts.push(`  代码: ${comment.code_snippet.substring(0, 200)}`);
    parts.push('');
  }

  return parts.join('\n').trim();
}
