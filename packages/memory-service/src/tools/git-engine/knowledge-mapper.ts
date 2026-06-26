// Created by dev on 2026/06/01
// 知识维度映射器 — 从 LLM 分析结果中提取 8 大维度知识并附带隔离字段

import { getLogger } from '@memforgeai/shared';
import type { MemoryScope } from '@memforgeai/shared';
import type { CommitInfo, CommitClassification, RepoTarget, FileChange } from './types.js';

const logger = getLogger('knowledge-mapper');

export type KnowledgeDimension =
  | 'architecture'
  | 'api_signature'
  | 'data_model'
  | 'business_logic'
  | 'configuration'
  | 'dependency'
  | 'coding_convention'
  | 'operational';

export interface KnowledgeExtract {
  dimension: KnowledgeDimension;
  title: string;
  content: string;
  scope: MemoryScope;
  knowledgeType: string;
  tags: string[];
  visibility: 'global' | 'product_line' | 'personal';
}

const DIMENSION_CONFIG: Record<KnowledgeDimension, {
  scope: MemoryScope;
  knowledgeType: string;
  defaultVisibility: 'global' | 'product_line' | 'personal';
}> = {
  architecture: { scope: 'architecture', knowledgeType: 'technical', defaultVisibility: 'product_line' },
  api_signature: { scope: 'api_reference', knowledgeType: 'api_reference', defaultVisibility: 'product_line' },
  data_model: { scope: 'domain_knowledge', knowledgeType: 'technical', defaultVisibility: 'product_line' },
  business_logic: { scope: 'domain_knowledge', knowledgeType: 'technical', defaultVisibility: 'personal' },
  configuration: { scope: 'convention', knowledgeType: 'technical', defaultVisibility: 'product_line' },
  dependency: { scope: 'domain_knowledge', knowledgeType: 'technical', defaultVisibility: 'product_line' },
  coding_convention: { scope: 'coding_standard', knowledgeType: 'technical', defaultVisibility: 'global' },
  operational: { scope: 'lesson_learned', knowledgeType: 'troubleshooting', defaultVisibility: 'product_line' },
};

const ARCH_FILE_PATTERNS = [
  /\.proto$/, /\.thrift$/, /\.avsc$/,
  /src\/main\/.*config/i, /application\.yml/, /application\.properties/,
  /docker-compose/, /Dockerfile/, /\.github\/workflows/,
  /build\.gradle/, /pom\.xml/,
];

const API_FILE_PATTERNS = [
  /Controller\.(java|kt)$/, /controller\.(ts|js)$/,
  /Service\.(java|kt)$/, /Interface\.(java|kt)$/,
  /routes?\.(ts|js)$/, /api\.(ts|js)$/,
  /\.proto$/, /\.thrift$/,
];

const DATA_MODEL_PATTERNS = [
  /Entity\.(java|kt)$/, /model\.(ts|js|py)$/,
  /migration/, /schema/, /\.sql$/,
  /DTO\.(java|kt)$/, /VO\.(java|kt)$/,
];

const CONFIG_FILE_PATTERNS = [
  /application\.(yml|yaml|properties)$/,
  /\.env/, /config\.(ts|js|json|yml)$/,
  /nginx\.conf/, /\.ini$/, /\.toml$/,
];

const DEP_FILES = new Set([
  'pom.xml', 'build.gradle', 'build.gradle.kts',
  'package.json', 'composer.json', 'go.mod',
  'Cargo.toml', 'requirements.txt', 'pyproject.toml',
]);

const OPERATIONAL_KEYWORDS = [
  'hotfix', 'rollback', 'revert', 'incident',
  '回滚', '紧急修复', '故障', 'outage',
];

function matchesPatterns(file: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(file));
}

function detectDimensions(commit: CommitInfo, classification: CommitClassification): Set<KnowledgeDimension> {
  const dims = new Set<KnowledgeDimension>();
  const changedFiles = commit.files.map(f => f.file);

  if (changedFiles.some(f => matchesPatterns(f, ARCH_FILE_PATTERNS))) {
    dims.add('architecture');
  }
  if (changedFiles.some(f => matchesPatterns(f, API_FILE_PATTERNS))) {
    dims.add('api_signature');
  }
  if (changedFiles.some(f => matchesPatterns(f, DATA_MODEL_PATTERNS))) {
    dims.add('data_model');
  }
  if (changedFiles.some(f => matchesPatterns(f, CONFIG_FILE_PATTERNS))) {
    dims.add('configuration');
  }
  if (changedFiles.some(f => DEP_FILES.has(f.split('/').pop() ?? ''))) {
    dims.add('dependency');
  }
  if (OPERATIONAL_KEYWORDS.some(kw => commit.subject.toLowerCase().includes(kw))) {
    dims.add('operational');
  }

  // 大型重构往往涉及编码规范
  if (classification.category === 'refactor' && commit.filesChanged >= 5) {
    dims.add('coding_convention');
  }

  // 有业务逻辑改动但未匹配到其他维度时
  const codeFiles = changedFiles.filter(f =>
    /\.(ts|js|java|php|py|go|rs|kt|vue|tsx|jsx)$/.test(f),
  );
  if (codeFiles.length > 0 && dims.size === 0) {
    dims.add('business_logic');
  }

  return dims;
}

export function mapToKnowledgeExtracts(
  commit: CommitInfo,
  classification: CommitClassification,
  repo: RepoTarget,
  llmAnalysis?: { summary: string; impact: string; patterns: string[]; risks: string[] },
): KnowledgeExtract[] {
  const dimensions = detectDimensions(commit, classification);
  if (dimensions.size === 0) return [];

  const extracts: KnowledgeExtract[] = [];

  for (const dim of dimensions) {
    const config = DIMENSION_CONFIG[dim];
    const content = buildDimensionContent(dim, commit, repo, llmAnalysis);
    if (!content) continue;

    extracts.push({
      dimension: dim,
      title: `[${dim}] ${commit.subject.slice(0, 120)}`,
      content,
      scope: config.scope,
      knowledgeType: config.knowledgeType,
      tags: [`dim:${dim}`, `repo:${repo.repoId}`, classification.category],
      visibility: config.defaultVisibility,
    });
  }

  return extracts;
}

function buildDimensionContent(
  dim: KnowledgeDimension,
  commit: CommitInfo,
  repo: RepoTarget,
  analysis?: { summary: string; impact: string; patterns: string[]; risks: string[] },
): string | null {
  const base = `仓库: ${repo.repoId}\n提交: ${commit.hash.slice(0, 8)} by ${commit.author}\n`;
  const files = commit.files
    .filter(f => {
      switch (dim) {
        case 'architecture': return matchesPatterns(f.file, ARCH_FILE_PATTERNS);
        case 'api_signature': return matchesPatterns(f.file, API_FILE_PATTERNS);
        case 'data_model': return matchesPatterns(f.file, DATA_MODEL_PATTERNS);
        case 'configuration': return matchesPatterns(f.file, CONFIG_FILE_PATTERNS);
        case 'dependency': return DEP_FILES.has(f.file.split('/').pop() ?? '');
        default: return true;
      }
    })
    .map(f => `  ${f.status} ${f.file}`)
    .join('\n');

  const parts = [base, `变更文件:\n${files || '  (无特定文件匹配)'}`];

  if (analysis?.summary) {
    parts.push(`\n分析: ${analysis.summary}`);
  }
  if (analysis?.impact) {
    parts.push(`影响: ${analysis.impact}`);
  }
  if (dim === 'coding_convention' && analysis?.patterns?.length) {
    parts.push(`编码模式:\n${analysis.patterns.map(p => `  - ${p}`).join('\n')}`);
  }
  if (analysis?.risks?.length) {
    parts.push(`风险点:\n${analysis.risks.map(r => `  - ${r}`).join('\n')}`);
  }

  return parts.join('\n');
}
