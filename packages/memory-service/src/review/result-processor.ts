import { getLogger, getPool, loadEmbeddingConfig, ApiEmbeddingService } from '@memforgeai/shared';
import type { StaticFinding } from './static-scanner.js';
import type { LLMFinding } from './llm-reviewer.js';
import type { ReviewContext } from './context-collector.js';

const logger = getLogger('review:result');

let _embeddingService: ApiEmbeddingService | null | undefined;
async function getEmbedding(): Promise<ApiEmbeddingService | null> {
  if (_embeddingService !== undefined) return _embeddingService;
  const cfg = loadEmbeddingConfig();
  if (!cfg) { _embeddingService = null; return null; }
  try {
    const svc = new ApiEmbeddingService(cfg);
    await svc.initialize();
    _embeddingService = svc;
    return svc;
  } catch (err) {
    logger.warn({ err }, 'Embedding 服务不可用，P0/P1 发现将缺少向量（不影响主流程）');
    _embeddingService = null;
    return null;
  }
}

export type Finding = (StaticFinding | LLMFinding) & { source: string };

export interface ProcessedReview {
  findings: Finding[];
  p0Count: number;
  p1Count: number;
  p2Count: number;
  needsNotification: boolean;
}

function deduplicateFindings(
  staticFindings: StaticFinding[],
  llmFindings: LLMFinding[],
): Finding[] {
  const result: Finding[] = [];

  for (const sf of staticFindings) {
    result.push({ ...sf, source: 'static_rule' });
  }

  for (const lf of llmFindings) {
    const isDuplicate = result.some(existing =>
      existing.file === lf.file
      && existing.category === lf.category
      && Math.abs((existing.line || 0) - (lf.line || 0)) <= 3,
    );
    if (!isDuplicate) {
      result.push({ ...lf, source: 'llm_review' });
    }
  }

  result.sort((a, b) => {
    const severityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
    return (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
  });

  return result;
}

export interface MrMetadata {
  reviewType?: 'commit' | 'merge_request';
  mrIid?: number;
  mrUrl?: string;
  gitlabProjectId?: number;
}

export async function processResults(
  staticFindings: StaticFinding[],
  llmFindings: LLMFinding[],
  commitHash: string,
  repoId: string,
  classification: string,
  branch: string,
  author: string,
  diff: string,
  llmSkipped: boolean,
  diffTruncated: boolean,
  context?: ReviewContext,
  productLine?: string,
  mrMeta?: MrMetadata,
): Promise<ProcessedReview> {
  const findings = deduplicateFindings(staticFindings, llmFindings);

  const p0Count = findings.filter(f => f.severity === 'P0').length;
  const p1Count = findings.filter(f => f.severity === 'P1').length;
  const p2Count = findings.filter(f => f.severity === 'P2').length;
  const needsNotification = p0Count > 0 || p1Count >= 3;

  const contextUsed = context ? {
    memoriesRecalled: context.bugPatterns.length,
    rulesLoaded: context.codingRules.length,
    securityDomainsApplied: context.securityDomains,
    pastReviewsChecked: context.pastReviews.length,
  } : {};

  try {
    const pool = getPool();
    const summary = generateSummary(findings, classification);

    const reviewType = mrMeta?.reviewType || 'commit';
    const mrIid = mrMeta?.mrIid ?? null;
    const mrUrl = mrMeta?.mrUrl ?? null;
    const gitlabProjectId = mrMeta?.gitlabProjectId ?? null;

    await pool.query(
      `INSERT INTO memory.code_reviews
       (project_id, product_line, repo_id, commit_hash, branch, author, classification, findings, summary,
        diff_preview, llm_skipped, diff_truncated, context_used, notified,
        review_type, mr_iid, mr_url, gitlab_project_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (repo_id, commit_hash, COALESCE(mr_iid, 0)) DO UPDATE SET
         findings = EXCLUDED.findings,
         summary = EXCLUDED.summary,
         diff_preview = EXCLUDED.diff_preview,
         llm_skipped = EXCLUDED.llm_skipped,
         diff_truncated = EXCLUDED.diff_truncated,
         context_used = EXCLUDED.context_used,
         review_type = EXCLUDED.review_type,
         mr_iid = EXCLUDED.mr_iid,
         mr_url = EXCLUDED.mr_url,
         gitlab_project_id = EXCLUDED.gitlab_project_id,
         reviewed_at = NOW()`,
      [
        repoId,
        productLine || null,
        repoId,
        commitHash,
        branch,
        author,
        classification,
        JSON.stringify(findings),
        summary,
        diff.slice(0, 2000),
        llmSkipped,
        diffTruncated,
        JSON.stringify(contextUsed),
        false,
        reviewType,
        mrIid,
        mrUrl,
        gitlabProjectId,
      ],
    );

    const criticalFindings = findings.filter(f => f.severity === 'P0' || f.severity === 'P1');
    if (criticalFindings.length > 0) {
      await storeFindingsAsMemory(criticalFindings, repoId, commitHash);
    }

    logger.info({
      commitHash: commitHash.slice(0, 8),
      repoId,
      p0Count,
      p1Count,
      p2Count,
      needsNotification,
      contextUsed,
    }, '审查结果已持久化');
  } catch (err) {
    logger.error({ err, commitHash }, '持久化审查结果失败');
  }

  return { findings, p0Count, p1Count, p2Count, needsNotification };
}

export async function updateNotifiedStatus(repoId: string, commitHash: string): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `UPDATE memory.code_reviews SET notified = TRUE, notified_at = NOW()
       WHERE repo_id = $1 AND commit_hash = $2`,
      [repoId, commitHash],
    );
  } catch (err) {
    logger.warn({ err, commitHash }, 'notified 状态回写失败');
  }
}

function generateSummary(findings: Finding[], classification: string): string {
  if (findings.length === 0) {
    return `[${classification}] 无发现`;
  }

  const p0 = findings.filter(f => f.severity === 'P0');
  const p1 = findings.filter(f => f.severity === 'P1');

  const parts: string[] = [`[${classification}] 发现 ${findings.length} 个问题`];

  if (p0.length > 0) {
    parts.push(`P0: ${p0.map(f => f.description.slice(0, 50)).join('; ')}`);
  }
  if (p1.length > 0) {
    parts.push(`P1: ${p1.map(f => f.description.slice(0, 50)).join('; ')}`);
  }

  return parts.join(' | ');
}

async function storeFindingsAsMemory(
  criticalFindings: Finding[],
  repoId: string,
  commitHash: string,
): Promise<void> {
  try {
    const pool = getPool();
    let stored = 0;
    for (const finding of criticalFindings) {
      const dedupKey = `auto-review:${commitHash.slice(0, 8)}:${finding.file}:${finding.category}`;
      const { rows } = await pool.query(
        `SELECT 1 FROM memory.entries WHERE project_id = $1 AND scope = 'bug_pattern'
         AND metadata->>'dedup_key' = $2 LIMIT 1`,
        [repoId, dedupKey],
      );
      if (rows.length > 0) continue;

      const title = `[${finding.severity}] ${finding.category}: ${finding.description.slice(0, 80)}`;
      const content = `发现于 ${repoId} commit ${commitHash.slice(0, 8)}\n文件: ${finding.file}\n问题: ${finding.description}\n建议: ${finding.suggestion}`;

      let embeddingLiteral: string | null = null;
      const embSvc = await getEmbedding();
      if (embSvc) {
        try {
          const vec = await embSvc.embedPassage(`${title} ${content}`);
          embeddingLiteral = `[${vec.join(',')}]`;
        } catch (embErr) {
          logger.warn({ err: embErr, file: finding.file }, '生成 embedding 失败，跳过');
        }
      }

      await pool.query(
        `INSERT INTO memory.entries (project_id, title, content, scope, source, tags, metadata, embedding)
         VALUES ($1, $2, $3, 'bug_pattern', 'code_review', $4, $5, $6)`,
        [
          repoId,
          title,
          content,
          JSON.stringify([finding.category, 'auto-review', finding.severity]),
          JSON.stringify({ dedup_key: dedupKey }),
          embeddingLiteral,
        ],
      );
      stored++;
    }
    if (stored > 0) {
      logger.info({ stored, total: criticalFindings.length }, 'P0/P1 发现已写入记忆库');
    }
  } catch (err) {
    logger.warn({ err }, 'P0/P1 发现写入记忆失败（不影响主流程）');
  }
}
