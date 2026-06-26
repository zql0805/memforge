import { getLogger, loadLlmConfig } from '@memforgeai/shared';
import type { ReviewContext } from './context-collector.js';
import type { StaticFinding } from './static-scanner.js';
import { buildSecurityContext } from './context-collector.js';

const logger = getLogger('review:llm');

export const MAX_DIFF_BYTES = 50 * 1024;
const LLM_TEMPERATURE = 0.1;
const LLM_MAX_TOKENS = 2000;
const LLM_TIMEOUT_MS = 120_000;

export interface LLMFinding {
  severity: 'P0' | 'P1' | 'P2';
  category: 'security' | 'exception' | 'logic' | 'performance' | 'compatibility' | 'convention';
  source: 'llm_review';
  file: string;
  line?: number;
  description: string;
  suggestion: string;
}

export interface LlmReviewResult {
  findings: LLMFinding[];
  skipped: boolean;
  skipReason?: string;
}

interface LlmReviewOptions {
  staticFindings?: StaticFinding[];
  commitMessage?: string;
}

function buildPrompt(diff: string, context: ReviewContext, options?: LlmReviewOptions): string {
  const parts: string[] = [];

  parts.push('你是资深代码审查专家。请审查以下 diff，输出 JSON 数组格式的发现。');
  parts.push('');

  if (options?.commitMessage) {
    parts.push(`## 提交信息\n${options.commitMessage}`);
    parts.push('');
  }

  if (context.codingRules.length > 0) {
    parts.push('## 团队编码规范');
    for (const rule of context.codingRules) {
      parts.push(`- ${rule.title}: ${rule.content.slice(0, 200)}`);
    }
    parts.push('');
  }

  if (context.bugPatterns.length > 0) {
    parts.push('## 该项目历史 Bug 模式');
    for (const bp of context.bugPatterns) {
      parts.push(`- ${bp.title}: ${bp.content.slice(0, 200)}`);
    }
    parts.push('');
  }

  if (context.securityDomains.length > 0) {
    parts.push(buildSecurityContext(context.securityDomains));
    parts.push('');
  }

  if (context.pastReviews.length > 0) {
    parts.push('## 该仓库近期审查发现（避免重复报告）');
    for (const pr of context.pastReviews.slice(0, 3)) {
      const findingsArr = Array.isArray(pr.findings) ? pr.findings : [];
      const summary = findingsArr.slice(0, 3).map((item: unknown) => {
        const f = item as Record<string, unknown>;
        return `[${f.severity}] ${f.category}: ${(f.description as string || '').slice(0, 60)}`;
      }).join('; ');
      if (summary) parts.push(`- commit ${pr.commit_hash.slice(0, 8)}: ${summary}`);
    }
    parts.push('');
  }

  if (options?.staticFindings && options.staticFindings.length > 0) {
    parts.push('## 静态扫描初步发现（请复核并补充遗漏的逻辑/语义问题）');
    for (const sf of options.staticFindings.slice(0, 10)) {
      parts.push(`- [${sf.severity}] ${sf.category} @ ${sf.file}${sf.line ? ':' + sf.line : ''}: ${sf.description}`);
    }
    parts.push('');
  }

  parts.push('## 审查 diff');
  parts.push('');
  parts.push(diff);
  parts.push('');
  parts.push('请以 JSON 对象格式返回（无发现时 findings 为空数组）：');
  parts.push('```json');
  parts.push('{ "findings": [{ "severity": "P0|P1|P2", "category": "security|exception|logic|performance|compatibility|convention", "file": "文件路径", "line": 行号或null, "description": "问题描述", "suggestion": "修复建议" }] }');
  parts.push('```');

  return parts.join('\n');
}

function truncateDiff(diff: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(diff, 'utf-8') <= MAX_DIFF_BYTES) {
    return { text: diff, truncated: false };
  }

  const lines = diff.split('\n');
  const kept: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf-8') + 1;
    if (bytes + lineBytes > MAX_DIFF_BYTES) break;
    kept.push(line);
    bytes += lineBytes;
  }

  return { text: kept.join('\n'), truncated: true };
}

export async function reviewWithLlm(
  diff: string,
  context: ReviewContext,
  options?: LlmReviewOptions,
): Promise<LlmReviewResult> {
  const llmConfig = loadLlmConfig();
  if (!llmConfig) {
    return { findings: [], skipped: true, skipReason: 'LLM 配置不可用' };
  }

  const { text: truncatedDiff, truncated } = truncateDiff(diff);
  const prompt = buildPrompt(truncatedDiff, context, options);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    const resp = await fetch(`${llmConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: llmConfig.model,
        messages: [
          { role: 'system', content: '你是资深代码审查专家，返回 JSON 格式结果。' },
          { role: 'user', content: prompt },
        ],
        temperature: LLM_TEMPERATURE,
        max_tokens: LLM_MAX_TOKENS,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (resp.status === 429) {
      logger.warn('DeepSeek API 限速 (429)，跳过 LLM 审查');
      return { findings: [], skipped: true, skipReason: 'API rate limited' };
    }

    if (!resp.ok) {
      const body = await resp.text();
      logger.error({ status: resp.status, body: body.slice(0, 500) }, 'LLM API 错误');
      return { findings: [], skipped: true, skipReason: `HTTP ${resp.status}` };
    }

    const data = await resp.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const content = data.choices?.[0]?.message?.content || '[]';
    const findings = parseFindings(content);

    logger.info({
      findingCount: findings.length,
      truncated,
      model: llmConfig.model,
    }, 'LLM 审查完成');

    return { findings, skipped: false };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      logger.warn('LLM 审查超时 (>120s)');
      return { findings: [], skipped: true, skipReason: 'timeout' };
    }
    logger.error({ err }, 'LLM 审查异常');
    return { findings: [], skipped: true, skipReason: (err as Error).message };
  }
}

function parseFindings(content: string): LLMFinding[] {
  try {
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = codeBlockMatch ? codeBlockMatch[1] : content;
    const parsed = JSON.parse(jsonStr.trim());

    const arr = Array.isArray(parsed) ? parsed : (parsed.findings || parsed.results || []);

    return arr
      .filter((f: Record<string, unknown>) => f.severity && f.description)
      .map((f: Record<string, unknown>) => ({
        severity: (['P0', 'P1', 'P2'].includes(f.severity as string) ? f.severity : 'P2') as LLMFinding['severity'],
        category: (f.category || 'logic') as LLMFinding['category'],
        source: 'llm_review' as const,
        file: (f.file || '') as string,
        line: typeof f.line === 'number' ? f.line : undefined,
        description: f.description as string,
        suggestion: (f.suggestion || '') as string,
      }));
  } catch (err) {
    logger.error({ err, contentPreview: content.slice(0, 300) }, 'LLM 返回 JSON 解析失败，丢弃本次 LLM 发现');
    return [];
  }
}
