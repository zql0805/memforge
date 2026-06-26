// Created by dev on 2026/04/08
// Copyright © 2026
// 自动桥接：当 store_memory(coding_standard) 存入短规则时，
// 自动在 memory.rules 表中创建 candidate，统一纳入规则引擎管理。
//
// A: bug_pattern 高频自动提议——同类记忆 ≥ 3 条时自动创建 candidate
// B: P0 快速通道——P0 发现直接写入 active 状态，跳过投票
// C: 关键词+语义双重判断——防止与现有规则重复桥接

import { randomUUID } from 'node:crypto';
import { getLogger, getPool } from '@memforgeai/shared';

const logger = getLogger('service:rule-bridge');

const MAX_CONTENT_LENGTH = 100_000;

// 触发规则桥接的规范型关键词（仅 coding_standard / convention 需要）
const RULE_PATTERN_KEYWORDS = [
  '禁止', '必须', '不得', '不允许', '强制', '严禁',
  '避免', '不应', '不可', '务必', '确保', '需要',
  'must', 'should not', 'forbidden', 'required', 'never',
];

// bug_pattern 高频阈值：同类记忆达到此数量才自动提议规则
const BUG_PATTERN_FREQUENCY_THRESHOLD = 3;

// 语义相似度阈值：与现有规则余弦相似度超过此值时跳过桥接（防重复）
const SEMANTIC_DEDUP_THRESHOLD = 0.82;

// bug_pattern 频率检测时的相似度阈值
const BUG_PATTERN_SIMILARITY_THRESHOLD = 0.78;

interface BridgeInput {
  memoryId: string;
  title: string;
  content: string;
  scope: string;
  projectId: string;
  embedding: number[];
  createdBy: string | null;
  /** B: P0 快速通道——true 时直接创建 active 规则 */
  forceActive?: boolean;
}

export async function tryBridgeToRule(input: BridgeInput): Promise<string | null> {
  if (input.content.length > MAX_CONTENT_LENGTH) return null;

  // 允许的 scope 范围
  const codingScopes = ['coding_standard', 'convention'];
  const patternScopes = ['bug_pattern', 'lesson_learned'];
  const isCodeScope = codingScopes.includes(input.scope);
  const isPatternScope = patternScopes.includes(input.scope);

  if (!isCodeScope && !isPatternScope) return null;

  const combined = `${input.title} ${input.content}`.toLowerCase();

  // coding_standard / convention 需要包含规范型关键词
  if (isCodeScope) {
    const hasRulePattern = RULE_PATTERN_KEYWORDS.some(kw => combined.includes(kw.toLowerCase()));
    if (!hasRulePattern) return null;
  }

  // A: bug_pattern / lesson_learned 需要同类记忆频率 >= 阈值
  if (isPatternScope && !input.forceActive) {
    const freqOk = await checkBugPatternFrequency(input.embedding, input.scope, BUG_PATTERN_FREQUENCY_THRESHOLD);
    if (!freqOk) {
      logger.debug({ scope: input.scope, title: input.title }, '同类记忆频率未达阈值，暂不桥接');
      return null;
    }
    logger.info({ scope: input.scope, title: input.title }, '同类记忆频率达阈值，触发自动提议规则');
  }

  try {
    const pool = getPool();
    let cleanTitle = input.title.replace(/^\[(Code Review|Rule|编码规范|规范|约定|Bug|故障)[^[\]]*\]\s*/i, '');

    // 标题质量校验：过短或无描述性的标题自动从内容中提取
    if (!isQualifiedTitle(cleanTitle)) {
      const extracted = extractTitleFromContent(input.content);
      if (extracted) {
        logger.info({ originalTitle: cleanTitle, extractedTitle: extracted }, '原始标题不合格，已从内容中提取');
        cleanTitle = extracted;
      } else {
        logger.warn({ title: cleanTitle }, '标题不合格且无法从内容提取有意义标题，跳过桥接');
        return null;
      }
    }

    // 标题精确匹配去重
    const existingByTitle = await pool.query(
      `SELECT id FROM memory.rules WHERE LOWER(title) = LOWER($1) AND status IN ('active', 'candidate', 'voting') LIMIT 1`,
      [cleanTitle],
    );
    if (existingByTitle.rows.length > 0) {
      logger.debug({ title: input.title, existingId: existingByTitle.rows[0].id }, '同名规则已存在，跳过桥接');
      return null;
    }

    // C: 语义相似度去重——防止内容相近的规则重复入库
    const semanticDup = await checkRuleSemanticDuplicate(input.embedding, SEMANTIC_DEDUP_THRESHOLD);
    if (semanticDup) {
      logger.debug({ title: input.title, similarRuleId: semanticDup }, '语义相似规则已存在，跳过桥接');
      return null;
    }

    const condensed = condenseForRule(input.content);
    const ruleId = randomUUID();
    const now = new Date().toISOString();
    const pgvector = `[${input.embedding.join(',')}]`;

    // B: P0 快速通道直接设为 active，否则为 candidate
    const status = input.forceActive ? 'active' : 'candidate';

    await pool.query(
      `INSERT INTO memory.rules
        (id, project_id, rule_type, title, description, rationale, example_good, example_bad,
         auto_fix, category, language, severity, status, source, source_ref,
         embedding, created_by, created_at, updated_at)
       VALUES ($1,$2,'coding',$3,$4,NULL,NULL,NULL,NULL,$5,NULL,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [
        ruleId,
        input.projectId,
        cleanTitle,
        condensed,
        inferCategory(combined),
        'warning',
        status,
        'ai_suggestion',
        JSON.stringify({ bridgedFrom: input.memoryId }),
        pgvector,
        input.createdBy,
        now,
      ],
    );

    logger.info({
      ruleId,
      memoryId: input.memoryId,
      title: cleanTitle,
      status,
      originalLen: input.content.length,
      condensedLen: condensed.length,
    }, `规则已自动桥接到 memory.rules (${status})，内容已精简`);
    return ruleId;
  } catch (err) {
    logger.warn({ err, memoryId: input.memoryId }, '规则桥接失败（不影响记忆存储）');
    return null;
  }
}

/**
 * B: P0 快速通道——直接激活规则（跳过 candidate/voting 流程）
 */
export async function tryBridgeP0Finding(input: Omit<BridgeInput, 'forceActive'>): Promise<string | null> {
  return tryBridgeToRule({ ...input, forceActive: true });
}

/**
 * A: 检查同类 bug_pattern 记忆的频率是否达到阈值
 * 通过向量相似度查询 memory.entries 中同 scope 的相似记忆数量
 */
async function checkBugPatternFrequency(
  embedding: number[],
  scope: string,
  threshold: number,
): Promise<boolean> {
  try {
    const pool = getPool();
    const pgvec = `[${embedding.join(',')}]`;
    const { rows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::int as cnt
       FROM memory.entries
       WHERE is_archived = FALSE
         AND scope = $1
         AND embedding IS NOT NULL
         AND (1 - (embedding <=> $2)) >= $3`,
      [scope, pgvec, BUG_PATTERN_SIMILARITY_THRESHOLD],
    );
    const cnt = Number(rows[0]?.cnt ?? 0);
    return cnt >= threshold;
  } catch (err) {
    logger.warn({ err }, '检查 bug_pattern 频率失败，跳过');
    return false;
  }
}

/**
 * C: 检查是否已有语义相似的规则（active / candidate / voting）
 * 返回相似规则的 id，如果不存在则返回 null
 */
async function checkRuleSemanticDuplicate(
  embedding: number[],
  similarityThreshold: number,
): Promise<string | null> {
  try {
    const pool = getPool();
    const pgvec = `[${embedding.join(',')}]`;
    const { rows } = await pool.query<{ id: string; similarity: number }>(
      `SELECT id, (1 - (embedding <=> $1)) as similarity
       FROM memory.rules
       WHERE status IN ('active', 'candidate', 'voting')
         AND embedding IS NOT NULL
         AND (1 - (embedding <=> $1)) >= $2
       ORDER BY embedding <=> $1 ASC
       LIMIT 1`,
      [pgvec, similarityThreshold],
    );
    if (rows.length > 0) {
      logger.debug({ id: rows[0].id, similarity: rows[0].similarity }, '发现语义相似规则');
      return rows[0].id;
    }
    return null;
  } catch (err) {
    logger.warn({ err }, '语义去重检查失败，跳过（不阻止桥接）');
    return null;
  }
}

/**
 * 从 Code Review 原始内容中提取核心规范点，去除文件路径、行号、审查背景等冗余信息。
 * 输入格式（由 buildCategoryContent 生成）：
 *   审查背景: ...
 *   问题分类: ...
 *   [P0] file.java:42
 *     问题: ...
 *     建议: ...
 *     状态: 已修复
 *
 * 输出：精简的规范要点列表
 */
function condenseForRule(content: string): string {
  const lines = content.split('\n');
  const rulePoints: string[] = [];
  let currentProblem = '';
  let currentSuggestion = '';
  let category = '';

  for (const line of lines) {
    const trimmed = line.trim();

    const catMatch = trimmed.match(/^问题分类:\s*(.+)/);
    if (catMatch) {
      category = catMatch[1].trim();
      continue;
    }

    // 跳过审查背景、问题数量、文件路径行、状态行
    if (trimmed.startsWith('审查背景:') || trimmed.startsWith('问题数量:')) continue;
    if (/^\[P[012]\]\s/.test(trimmed)) continue;
    if (trimmed.startsWith('状态:')) continue;

    const probMatch = trimmed.match(/^问题:\s*(.+)/);
    if (probMatch) {
      // 保存上一组
      if (currentProblem) {
        rulePoints.push(formatRulePoint(currentProblem, currentSuggestion));
      }
      currentProblem = probMatch[1].trim();
      currentSuggestion = '';
      continue;
    }

    const sugMatch = trimmed.match(/^建议:\s*(.+)/);
    if (sugMatch) {
      currentSuggestion = sugMatch[1].trim();
      continue;
    }
  }

  // 最后一组
  if (currentProblem) {
    rulePoints.push(formatRulePoint(currentProblem, currentSuggestion));
  }

  if (rulePoints.length === 0) {
    // 无法解析结构化格式时，移除文件路径等噪声后返回原始内容（截断）
    return stripFileReferences(content).slice(0, 2000);
  }

  const header = category ? `${category}相关规范：` : '编码规范：';
  return `${header}\n${rulePoints.map(p => `- ${p}`).join('\n')}`;
}

function formatRulePoint(problem: string, suggestion: string): string {
  // 优先用建议（更具规范性），否则将问题描述转为规范语句
  if (suggestion) return suggestion;
  return problem;
}

function stripFileReferences(text: string): string {
  return text
    .replace(/\[P[012]\]\s*\S+\.(java|php|ts|js|py|go|cpp|xml|yml|yaml)(:\d+)?/g, '')
    .replace(/^\s*状态:\s*(已修复|未修复)\s*$/gm, '')
    .replace(/^\s*审查背景:.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inferCategory(text: string): string {
  if (/安全|注入|xss|csrf|token|密码|敏感|越权/.test(text)) return 'security';
  if (/性能|n\+1|超时|缓存|慢查询|连接池/.test(text)) return 'performance';
  if (/架构|分层|模块|依赖|解耦/.test(text)) return 'architecture';
  if (/命名|格式|风格|缩进|注释/.test(text)) return 'style';
  if (/逻辑|边界|并发|一致性|事务/.test(text)) return 'logic';
  return 'convention';
}

const MIN_TITLE_LENGTH = 6;
const VAGUE_TITLE_PATTERNS = [
  /^\d+\s*个?(问题|issue|bug|发现|点)/i,
  /^(问题|issue|bug|发现|修复|review|检查|审查)$/i,
  /^(P[012]\s*[:：]?\s*)+$/,
  /^(无|暂无|略|N\/A|none|null)$/i,
];

/**
 * 判断标题是否足够有描述性。
 * 拒绝：过短（<6 字符）、纯数字计数（"2 个问题"）、
 * 纯通用词（"问题"/"review"）等无意义标题。
 */
function isQualifiedTitle(title: string): boolean {
  const t = title.trim();
  if (t.length < MIN_TITLE_LENGTH) return false;
  if (VAGUE_TITLE_PATTERNS.some(p => p.test(t))) return false;
  return true;
}

/**
 * 从 Code Review 内容中提取第一条有意义的规范描述作为标题。
 * 优先取"建议"行，其次"问题"行。
 */
function extractTitleFromContent(content: string): string | null {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const sugMatch = trimmed.match(/^建议:\s*(.{6,})/);
    if (sugMatch) return sugMatch[1].slice(0, 80);
    const probMatch = trimmed.match(/^问题:\s*(.{6,})/);
    if (probMatch) return probMatch[1].slice(0, 80);
  }

  // 回退：取带规范关键词的第一行非空内容
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= MIN_TITLE_LENGTH && RULE_PATTERN_KEYWORDS.some(kw => trimmed.includes(kw))) {
      return trimmed.replace(/^[-*•]\s*/, '').slice(0, 80);
    }
  }
  return null;
}
