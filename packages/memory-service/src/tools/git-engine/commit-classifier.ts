// Created by dev on 2026/05/09
// Git 历史知识引擎 — 增强版提交分类器
// Layer 1: Conventional Commits 解析 + 关键词 + 文件变更统计

import type { CommitInfo, CommitClassification, CommitCategory, FileChange } from './types.js';

const DEP_FILES = new Set([
  'pom.xml', 'build.gradle', 'build.gradle.kts',
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'composer.json', 'composer.lock',
  'go.mod', 'go.sum',
  'Cargo.toml', 'Cargo.lock',
  'requirements.txt', 'Pipfile', 'pyproject.toml',
]);

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);

const SECURITY_KEYWORDS = [
  'security', 'cve', 'xss', 'csrf', 'sql injection', 'sqli',
  'vulnerability', 'auth bypass', '越权', '安全', '漏洞', '注入',
];

const PERF_KEYWORDS = [
  'perf', 'performance', 'optimize', 'slow', 'latency', 'cache',
  '性能', '优化', '慢查询', '缓存',
];

const MIGRATION_KEYWORDS = [
  'breaking', 'migration', 'migrate', 'deprecat',
  '迁移', '废弃', '不兼容',
];

interface ConventionalParsed {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
}

function parseConventionalCommit(subject: string): ConventionalParsed | null {
  const match = subject.match(
    /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/,
  );
  if (!match) return null;
  return {
    type: match[1].toLowerCase(),
    scope: match[2] ?? null,
    breaking: match[3] === '!' || subject.includes('BREAKING CHANGE'),
    description: match[4],
  };
}

function hasKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

function getFileExtension(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot >= 0 ? file.substring(dot) : '';
}

function hasDependencyChange(files: FileChange[]): boolean {
  return files.some(f => {
    const name = f.file.split('/').pop() ?? '';
    return DEP_FILES.has(name);
  });
}

function hasNewDirectory(files: FileChange[]): boolean {
  const dirs = new Set<string>();
  for (const f of files) {
    if (f.status === 'A') {
      const parts = f.file.split('/');
      if (parts.length > 1) dirs.add(parts.slice(0, -1).join('/'));
    }
  }
  return dirs.size > 0;
}

function isDocOnlyChange(files: FileChange[]): boolean {
  return files.length > 0 && files.every(f => DOC_EXTENSIONS.has(getFileExtension(f.file)));
}

/**
 * Layer 2 触发条件判定
 */
function shouldTriggerDeepAnalysis(
  commit: CommitInfo,
  classification: CommitClassification,
): { trigger: boolean; reason?: string } {
  if (commit.filesChanged >= 15) {
    return { trigger: true, reason: `大规模变更 (${commit.filesChanged} 个文件)` };
  }
  if (commit.insertions + commit.deletions >= 300) {
    return { trigger: true, reason: `大量代码变更 (+${commit.insertions} -${commit.deletions})` };
  }
  if (classification.category === 'security') {
    return { trigger: true, reason: '安全相关变更' };
  }
  if (classification.category === 'migration') {
    return { trigger: true, reason: '迁移/Breaking Change' };
  }
  if (hasDependencyChange(commit.files)) {
    return { trigger: true, reason: '依赖文件变更' };
  }
  if (hasNewDirectory(commit.files)) {
    return { trigger: true, reason: '新目录/模块出现' };
  }
  if (commit.body.length > 200) {
    return { trigger: true, reason: '提交描述丰富（>200字）' };
  }
  return { trigger: false };
}

/**
 * 增强版提交分类器
 * 支持 Conventional Commits 格式 + 关键词匹配 + 文件变更统计
 */
export function classifyCommit(commit: CommitInfo): CommitClassification | null {
  const msg = commit.subject;
  const body = commit.body;
  const fullText = `${msg} ${body}`;

  // 1. 尝试 Conventional Commits 解析
  const cc = parseConventionalCommit(msg);
  if (cc) {
    const classification = classifyFromConventional(cc, commit);
    if (classification) {
      const { trigger, reason } = shouldTriggerDeepAnalysis(commit, classification);
      classification.shouldDeepAnalyze = trigger;
      classification.deepAnalyzeReason = reason;
      return classification;
    }
  }

  // 2. 关键词匹配（兼容非 Conventional 格式）
  let result: CommitClassification | null = null;

  if (hasKeyword(fullText, SECURITY_KEYWORDS)) {
    result = {
      category: 'security', scope: 'coding_standard',
      source: 'code_review', visibility: 'global',
      shouldDeepAnalyze: false,
    };
  } else if (hasKeyword(fullText, PERF_KEYWORDS)) {
    result = {
      category: 'performance', scope: 'performance_insight',
      source: 'code_review', visibility: 'product_line',
      shouldDeepAnalyze: false,
    };
  } else if (hasKeyword(fullText, MIGRATION_KEYWORDS)) {
    result = {
      category: 'migration', scope: 'lesson_learned',
      source: 'architecture_decision', visibility: 'product_line',
      shouldDeepAnalyze: false,
    };
  } else if (hasKeyword(msg, ['fix', 'bug', '修复', 'hotfix', '修正'])) {
    result = {
      category: 'bugfix', scope: 'bug_pattern',
      source: 'bug_fix', visibility: 'personal',
      shouldDeepAnalyze: false,
    };
  } else if (hasKeyword(msg, ['refactor', '重构'])) {
    result = {
      category: 'refactor', scope: 'architecture',
      source: 'architecture_decision', visibility: 'product_line',
      shouldDeepAnalyze: false,
    };
  } else if (hasKeyword(msg, ['feat', 'feature', '新增', '添加', '实现'])) {
    result = {
      category: 'feature', scope: 'architecture',
      source: 'architecture_decision', visibility: 'personal',
      shouldDeepAnalyze: false,
    };
  } else if (isDocOnlyChange(commit.files)) {
    result = {
      category: 'docs', scope: 'domain_knowledge',
      source: 'manual', visibility: 'personal',
      shouldDeepAnalyze: false,
    };
  } else if (body.length > 100 || commit.filesChanged >= 5) {
    result = {
      category: 'notable', scope: 'context',
      source: 'git_monitor', visibility: 'personal',
      shouldDeepAnalyze: false,
    };
  }

  if (!result) return null;

  const { trigger, reason } = shouldTriggerDeepAnalysis(commit, result);
  result.shouldDeepAnalyze = trigger;
  result.deepAnalyzeReason = reason;
  return result;
}

function classifyFromConventional(cc: ConventionalParsed, commit: CommitInfo): CommitClassification | null {
  const categoryMap: Record<string, { category: CommitCategory; scope: CommitClassification['scope']; source: CommitClassification['source']; visibility: CommitClassification['visibility'] }> = {
    feat:     { category: 'feature',     scope: 'architecture',        source: 'architecture_decision', visibility: 'personal' },
    fix:      { category: 'bugfix',      scope: 'bug_pattern',         source: 'bug_fix',               visibility: 'personal' },
    refactor: { category: 'refactor',    scope: 'architecture',        source: 'architecture_decision', visibility: 'product_line' },
    perf:     { category: 'performance', scope: 'performance_insight', source: 'code_review',           visibility: 'product_line' },
    docs:     { category: 'docs',        scope: 'domain_knowledge',    source: 'manual',                visibility: 'personal' },
    style:    { category: 'style',       scope: 'coding_standard',     source: 'code_review',           visibility: 'personal' },
    test:     { category: 'test',        scope: 'coding_standard',     source: 'code_review',           visibility: 'personal' },
    ci:       { category: 'infra',       scope: 'tool_usage',          source: 'manual',                visibility: 'personal' },
    build:    { category: 'infra',       scope: 'tool_usage',          source: 'manual',                visibility: 'personal' },
    chore:    { category: 'chore',       scope: 'context',             source: 'git_monitor',           visibility: 'personal' },
  };

  const mapped = categoryMap[cc.type];
  if (!mapped) return null;

  let { visibility } = mapped;
  if (cc.breaking) {
    visibility = 'product_line';
  }
  if (hasKeyword(`${commit.subject} ${commit.body}`, SECURITY_KEYWORDS)) {
    return {
      category: 'security', scope: 'coding_standard',
      source: 'code_review', visibility: 'global',
      shouldDeepAnalyze: false,
    };
  }

  return {
    ...mapped,
    visibility,
    shouldDeepAnalyze: false,
  };
}

/**
 * 从 git log 输出解析提交信息
 * 格式: %H|||%s|||%an|||%aI|||%b
 */
export function parseCommitLog(output: string): Omit<CommitInfo, 'filesChanged' | 'insertions' | 'deletions' | 'files'>[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const parts = line.split('|||');
      return {
        hash: parts[0] ?? '',
        subject: parts[1] ?? '',
        author: parts[2] ?? '',
        date: parts[3] ?? '',
        body: parts[4] ?? '',
      };
    })
    .filter(c => c.hash && c.subject);
}

/**
 * 从 git diff --numstat 输出解析文件变更统计
 */
export function parseDiffNumstat(output: string): { insertions: number; deletions: number; files: FileChange[] } {
  const files: FileChange[] = [];
  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const line of output.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const ins = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
    const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
    const file = parts[2];
    totalInsertions += ins;
    totalDeletions += del;
    files.push({ status: 'M', file });
  }

  return { insertions: totalInsertions, deletions: totalDeletions, files };
}

/**
 * 从 git diff --name-status 输出解析文件变更列表
 */
export function parseNameStatus(output: string): FileChange[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [statusRaw, ...fileParts] = line.split('\t');
      const status = (statusRaw?.charAt(0) ?? 'M') as FileChange['status'];
      const file = fileParts[fileParts.length - 1] ?? fileParts[0] ?? '';
      const oldFile = fileParts.length > 1 ? fileParts[0] : undefined;
      return { status, file, oldFile };
    })
    .filter(f => f.file);
}

/**
 * 构建用于存储的记忆内容
 */
export function buildMemoryContent(
  commit: CommitInfo,
  classification: CommitClassification,
): string {
  const parts = [
    `提交: ${commit.subject}`,
    `作者: ${commit.author}`,
    `日期: ${commit.date.split('T')[0]}`,
    `类型: ${classification.category}`,
    `影响: ${commit.filesChanged} 个文件, +${commit.insertions} -${commit.deletions}`,
  ];

  if (commit.body.trim()) {
    parts.push(`\n详情:\n${commit.body.trim()}`);
  }

  if (commit.files.length > 0 && commit.files.length <= 20) {
    const fileList = commit.files
      .map(f => `  ${f.status} ${f.file}`)
      .join('\n');
    parts.push(`\n变更文件:\n${fileList}`);
  }

  return parts.join('\n');
}
