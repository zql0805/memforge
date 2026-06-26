// Created by dev on 2026/05/09
// Git 历史知识引擎 — Layer 2 LLM 深度分析
// 对重要提交调用 LLM 生成结构化洞察，控制每日预算

import { getLogger, getPool, loadLlmConfig } from '@memforgeai/shared';
import type { CommitInfo, CommitClassification } from './types.js';

const logger = getLogger('llm-analyzer');

interface LlmAnalysis {
  summary: string;
  impact: string;
  patterns: string[];
  risks: string[];
  tags: string[];
}

interface AnalyzerConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dailyBudget: number;
}

const SYSTEM_PROMPT = `你是一个资深代码审查专家。请根据以下 Git 提交信息进行深度分析，返回 JSON 格式：

{
  "summary": "一段话总结这次提交的核心变更和意图（50-150字）",
  "impact": "对项目/系统的影响评估（30-100字）",
  "patterns": ["提取的编码模式或架构决策，每条10-30字"],
  "risks": ["潜在风险点，每条10-30字"],
  "tags": ["2-5个技术标签"]
}

要求：
- 聚焦技术本质，避免复述 commit message
- patterns 只提取有学习价值的模式（架构决策、设计模式、性能优化策略等）
- risks 只列出真正值得关注的风险（安全、兼容性、数据一致性等）
- 无内容可提取的字段返回空数组`;

export class LlmAnalyzer {
  private config: AnalyzerConfig | null = null;
  private todayUsed = 0;
  private todayDate = '';

  constructor() {
    const shared = loadLlmConfig();
    if (shared) {
      this.config = { ...shared, dailyBudget: 50 };
      logger.info({ model: shared.model }, 'LLM 分析器已初始化');
    } else {
      logger.info('LLM 分析器未配置（缺少 LLM_BASE_URL/OPENAI_BASE_URL + API_KEY）');
    }
  }

  get isAvailable(): boolean {
    return this.config !== null;
  }

  setDailyBudget(budget: number): void {
    if (this.config) this.config.dailyBudget = budget;
  }

  async canAnalyze(): Promise<boolean> {
    if (!this.config) return false;
    await this.refreshDailyCounter();
    return this.todayUsed < this.config.dailyBudget;
  }

  async analyze(
    commit: CommitInfo,
    classification: CommitClassification,
    repoId: string,
    diff?: string,
  ): Promise<LlmAnalysis | null> {
    if (!this.config) return null;
    if (!(await this.canAnalyze())) {
      logger.debug({ budget: this.config.dailyBudget, used: this.todayUsed }, 'LLM 每日预算已用完');
      return null;
    }

    const userPrompt = buildUserPrompt(commit, classification, repoId, diff);

    try {
      const result = await this.callLlm(userPrompt);
      return result;
    } catch (err) {
      logger.warn({ err: (err as Error).message, commit: commit.hash }, 'LLM 分析失败');
      return null;
    }
  }

  /**
   * 确认 LLM 分析结果已成功落库后才消耗预算计数，
   * 避免 store 失败时预算已扣但无记录的不一致。
   */
  confirmUsed(): void {
    this.todayUsed++;
    // 失效日期缓存，下次 canAnalyze() 强制从 DB 重读计数，确保多进程一致性
    this.todayDate = '';
  }

  private async callLlm(userPrompt: string): Promise<LlmAnalysis> {
    const cfg = this.config!;
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 800,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`LLM API ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const content = data.choices?.[0]?.message?.content ?? '{}';
    let parsed: Partial<LlmAnalysis>;
    try {
      parsed = JSON.parse(content) as Partial<LlmAnalysis>;
    } catch {
      logger.warn({ contentPreview: content.substring(0, 200) }, 'LLM 返回非法 JSON，回退为空分析');
      parsed = {};
    }

    return {
      summary: parsed.summary ?? '',
      impact: parsed.impact ?? '',
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    };
  }

  private async refreshDailyCounter(): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    if (today === this.todayDate) return;

    this.todayDate = today;
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM memory.entries
         WHERE metadata->>'llm_analyzed' = 'true'
         AND tags @> ARRAY['from-commit']
         AND created_at >= $1::date AND created_at < ($1::date + INTERVAL '1 day')`,
        [today],
      );
      const parsed = parseInt(rows[0]?.cnt ?? '0', 10);
      this.todayUsed = Number.isNaN(parsed) ? 0 : parsed;
    } catch {
      this.todayUsed = 0;
    }
  }

}

function buildUserPrompt(
  commit: CommitInfo,
  classification: CommitClassification,
  repoId: string,
  diff?: string,
): string {
  const parts = [
    `## 仓库: ${repoId}`,
    `## 提交: ${commit.hash.substring(0, 8)}`,
    `## 作者: ${commit.author}`,
    `## 日期: ${commit.date.split('T')[0]}`,
    `## 分类: ${classification.category}`,
    `## 分析触发原因: ${classification.deepAnalyzeReason ?? '未知'}`,
    `\n### 提交信息\n${commit.subject}`,
  ];

  if (commit.body.trim()) {
    parts.push(`\n### 详细描述\n${commit.body.trim()}`);
  }

  parts.push(`\n### 统计\n文件变更: ${commit.filesChanged}，+${commit.insertions} -${commit.deletions}`);

  if (commit.files.length > 0) {
    const fileList = commit.files
      .slice(0, 30)
      .map(f => `${f.status} ${f.file}`)
      .join('\n');
    parts.push(`\n### 变更文件\n${fileList}`);
    if (commit.files.length > 30) {
      parts.push(`...及其他 ${commit.files.length - 30} 个文件`);
    }
  }

  if (diff) {
    const truncated = diff.length > 4000 ? diff.substring(0, 4000) + '\n...(截断)' : diff;
    parts.push(`\n### 代码差异（部分）\n\`\`\`\n${truncated}\n\`\`\``);
  }

  return parts.join('\n');
}

export function enrichContentWithAnalysis(
  originalContent: string,
  analysis: LlmAnalysis,
): string {
  const parts = [originalContent, '\n---\n## LLM 深度分析'];

  if (analysis.summary) {
    parts.push(`\n### 摘要\n${analysis.summary}`);
  }
  if (analysis.impact) {
    parts.push(`\n### 影响评估\n${analysis.impact}`);
  }
  if (analysis.patterns.length > 0) {
    parts.push(`\n### 编码模式/架构决策\n${analysis.patterns.map(p => `- ${p}`).join('\n')}`);
  }
  if (analysis.risks.length > 0) {
    parts.push(`\n### 潜在风险\n${analysis.risks.map(r => `- ${r}`).join('\n')}`);
  }

  return parts.join('\n');
}
