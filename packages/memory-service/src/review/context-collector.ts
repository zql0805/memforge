import { getLogger, getPool } from '@memforgeai/shared';

const logger = getLogger('review:context');

export interface ReviewContext {
  bugPatterns: Array<{ title: string; content: string }>;
  codingRules: Array<{ title: string; content: string }>;
  pastReviews: Array<{ commit_hash: string; findings: unknown[] }>;
  securityDomains: string[];
  commitMessage?: string;
}

const SECURITY_DOMAINS: Record<string, { patterns: string[]; triggerFiles: RegExp[] }> = {
  financial: {
    patterns: [
      '支付金额由客户端传入 → 服务端必须从订单表读取',
      '余额扣减未加锁 → 使用数据库行锁或 CAS',
      '退款接口无幂等 → 基于订单号幂等',
    ],
    triggerFiles: [/pay/i, /order/i, /wallet/i, /recharge/i],
  },
  authorization: {
    patterns: [
      '通过 user_id 参数查询 → 必须校验 session 中的 user_id 一致',
      'ID 可预测/可遍历 → 使用 UUID 或加权限校验',
      '水平越权：A 用户操作 B 用户数据 → 强制 owner 校验',
    ],
    triggerFiles: [/controller/i, /api/i, /admin/i],
  },
  authentication: {
    patterns: [
      '密码重置 token 固定/可预测 → 使用加密随机 token',
      '验证码无次数限制 → 加频率限制 + 过期时间',
      'Session 固定 → 登录后重新生成 session ID',
    ],
    triggerFiles: [/auth/i, /login/i, /password/i, /sso/i],
  },
  information: {
    patterns: [
      '错误信息暴露内部路径/SQL/堆栈 → 生产环境返回通用错误',
      '调试接口未关闭 → 环境变量控制，生产禁用',
      '用户隐私字段明文返回 → 脱敏处理',
    ],
    triggerFiles: [/controller/i, /api/i, /response/i, /log/i],
  },
  logic_flow: {
    patterns: [
      '竞态条件：先检查再执行(TOCTOU) → 使用原子操作或分布式锁',
      '业务流程可绕过（跳步调用） → 状态机校验前置条件',
      '批量操作无上限 → 限制单次批量数量',
    ],
    triggerFiles: [/service/i, /handler/i, /job/i],
  },
  configuration: {
    patterns: [
      '.env/config 文件暴露在 public/static 路径 → 检查 web 根目录',
      '默认密码/弱密码 → 强制修改默认凭据',
      'CORS 配置过于宽松 (allow *) → 限定具体域名',
    ],
    triggerFiles: [/\.env/i, /config/i, /nginx/i, /docker/i],
  },
};

function extractKeywords(commitMessage: string, files: string[]): string[] {
  const keywords = new Set<string>();
  const dirPattern = /(?:^|\/)([a-zA-Z][\w-]+)\//g;
  for (const f of files) {
    let m: RegExpExecArray | null;
    while ((m = dirPattern.exec(f)) !== null) {
      if (!['src', 'main', 'java', 'test', 'resources', 'node_modules', 'dist'].includes(m[1])) {
        keywords.add(m[1].toLowerCase());
      }
    }
  }
  const words = commitMessage.replace(/[^a-zA-Z\u4e00-\u9fff\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
  for (const w of words.slice(0, 10)) {
    keywords.add(w.toLowerCase());
  }
  return [...keywords].slice(0, 8);
}

export async function collectContext(
  repoId: string,
  files: string[],
  commitMessage: string,
  productLine?: string,
): Promise<ReviewContext> {
  const pool = getPool();
  const result: ReviewContext = {
    bugPatterns: [],
    codingRules: [],
    pastReviews: [],
    securityDomains: [],
    commitMessage,
  };

  const keywords = extractKeywords(commitMessage, files);

  // bugPatterns: 优先匹配当前仓库 + 关键词，兜底取最近 5 条
  try {
    let bugRes;
    if (keywords.length > 0) {
      const keywordPattern = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      bugRes = await pool.query(
        `SELECT title, content FROM memory.entries
         WHERE scope = 'bug_pattern'
         AND (metadata->>'migrated_to_knowledge' IS NULL OR metadata->>'migrated_to_knowledge' != 'true')
         AND (project_id = $1 OR content ~* $2)
         ORDER BY CASE WHEN project_id = $1 THEN 0 ELSE 1 END, created_at DESC
         LIMIT 5`,
        [repoId, keywordPattern],
      );
    }
    if (!bugRes || bugRes.rows.length === 0) {
      bugRes = await pool.query(
        `SELECT title, content FROM memory.entries
         WHERE scope = 'bug_pattern'
         AND (metadata->>'migrated_to_knowledge' IS NULL OR metadata->>'migrated_to_knowledge' != 'true')
         ORDER BY created_at DESC LIMIT 5`,
      );
    }
    result.bugPatterns = bugRes.rows;
  } catch (err) {
    logger.warn({ err }, 'recall bug patterns 失败，跳过');
  }

  // codingRules: 优先从 knowledge_items 查，兜底查 entries
  try {
    const knowledgeRes = await pool.query(
      `SELECT title, content FROM memory.knowledge_items
       WHERE knowledge_type = 'technical' AND status = 'published'
       AND (source_type = 'document' OR source_type = 'code_review')
       AND (title ILIKE '%规范%' OR title ILIKE '%standard%' OR title ILIKE '%convention%'
            OR tags @> '["coding_standard"]' OR tags @> '["convention"]')
       ORDER BY created_at DESC LIMIT 5`,
    );
    if (knowledgeRes.rows.length > 0) {
      result.codingRules = knowledgeRes.rows;
    } else {
      const rulesRes = await pool.query(
        `SELECT title, content FROM memory.entries
         WHERE scope IN ('coding_standard', 'convention')
         AND is_archived = FALSE
         ORDER BY created_at DESC LIMIT 5`,
      );
      result.codingRules = rulesRes.rows;
    }
  } catch (err) {
    logger.warn({ err }, 'load coding rules 失败，跳过');
  }

  try {
    const reviewRes = await pool.query(
      `SELECT commit_hash, findings FROM memory.code_reviews
       WHERE repo_id = $1 ORDER BY reviewed_at DESC LIMIT 5`,
      [repoId],
    );
    result.pastReviews = reviewRes.rows;
  } catch (err) {
    logger.warn({ err }, 'query past reviews 失败，跳过');
  }

  for (const [domain, config] of Object.entries(SECURITY_DOMAINS)) {
    const matched = files.some(f =>
      config.triggerFiles.some(pattern => pattern.test(f)),
    );
    if (matched) {
      result.securityDomains.push(domain);
    }
  }

  logger.info({
    bugPatterns: result.bugPatterns.length,
    codingRules: result.codingRules.length,
    pastReviews: result.pastReviews.length,
    securityDomains: result.securityDomains,
    keywords: keywords.slice(0, 5),
  }, '上下文收集完成');

  return result;
}

export function buildSecurityContext(domains: string[]): string {
  const parts: string[] = [];
  for (const domain of domains) {
    const config = SECURITY_DOMAINS[domain];
    if (config) {
      parts.push(`## ${domain} 安全检查要点\n${config.patterns.map(p => `- ${p}`).join('\n')}`);
    }
  }
  return parts.join('\n\n');
}
