// Created by dev on 2026/05/21

export interface ConfidenceContext {
  /** 知识条目的 category（如 "code-analysis/example/version"） */
  category?: string | null;
  /** 知识条目的 knowledgeType */
  knowledgeType?: string | null;
  /** 查询特征：是否包含代码符号模式（驼峰、路径、类名） */
  queryLooksLikeCode?: boolean;
  /** 查询特征：是否为运营/FAQ 类查询（充值失败、报错、怎么办等） */
  queryLooksLikeOperational?: boolean;
}

const OPERATIONAL_TYPES = new Set(['faq', 'troubleshooting', 'incident', 'runbook', 'how_to']);

export function computeConfidence(
  fusedScoreNormalized: number,
  helpfulCount: number,
  unhelpfulCount: number,
  verified: boolean,
  context?: ConfidenceContext,
): number {
  const totalFeedback = helpfulCount + unhelpfulCount;
  const helpfulRatio = totalFeedback > 0 ? helpfulCount / totalFeedback : 0.5;
  const verifiedBoost = verified ? 1 : 0;

  let typeBoost = 0;
  if (context?.queryLooksLikeCode && !context?.queryLooksLikeOperational
    && context?.category?.startsWith('code-analysis/')) {
    typeBoost = 0.05;
  } else if (context?.queryLooksLikeOperational && !context?.queryLooksLikeCode
    && context?.knowledgeType && OPERATIONAL_TYPES.has(context.knowledgeType)) {
    typeBoost = 0.05;
  }

  return Math.min(1, fusedScoreNormalized * 0.6 + helpfulRatio * 0.2 + verifiedBoost * 0.1 + typeBoost + 0.1);
}

const CODE_SYMBOL_PATTERN = /[A-Z][a-z]+[A-Z]|[a-z]+\.[a-z]+\(|\/api\/|Controller|Service|Repository|Mapper|@\w+Mapping/;

export function queryLooksLikeCode(query: string): boolean {
  return CODE_SYMBOL_PATTERN.test(query);
}

// 中英文运营/FAQ 类查询特征
const OPERATIONAL_PATTERN = /充值|提现|失败|报错|怎么办|怎么处理|如何解决|操作指南|排查|故障|异常|error|fail|how\s+to|troubleshoot|faq|timeout|超时|连接失败|无法|不能|cannot|unable/i;

export function queryLooksLikeOperational(query: string): boolean {
  return OPERATIONAL_PATTERN.test(query) && !queryLooksLikeCode(query);
}
