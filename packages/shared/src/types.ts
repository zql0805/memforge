// Created by dev on 2026/04/04
// Copyright © 2026

import { z } from 'zod';

export const MemoryScope = z.enum([
  'coding_standard',
  'architecture',
  'lesson_learned',
  'bug_pattern',
  'performance_insight',
  'task_progress',
  'review_insight',
  'convention',
  'context',
  'domain_knowledge',
  'debugging_strategy',
  'design_pattern',
  'tool_usage',
  'problem_solution',
  'skill_milestone',
  'learning_note',
  'mentoring_record',
  'failure_postmortem',
  'api_reference',
  'project_history',
  'user_profile',
  'entity_reference',
]);

export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemorySource = z.enum([
  'manual',
  'code_review',
  'bug_fix',
  'architecture_decision',
  'ai_suggestion',
  'rule_engine',
  'git_monitor',
  'session_extraction',
  'codebase_scan',
]);

export type MemorySource = z.infer<typeof MemorySource>;

export const ProjectScope = z.enum(['branch', 'project', 'organization']);
export type ProjectScope = z.infer<typeof ProjectScope>;

export const MemoryVisibility = z.enum(['personal', 'team', 'product_line', 'global']);
export type MemoryVisibility = z.infer<typeof MemoryVisibility>;

export interface MemoryEntry {
  id: string;
  projectId: string;
  branchId: string | null;
  title: string;
  content: string;
  scope: MemoryScope;
  source: MemorySource;
  tags: string[];
  embedding: number[] | null;
  metadata: Record<string, unknown>;
  isArchived: boolean;
  archivedReason: string | null;
  createdBy: string | null;
  /** 是否经过 lead/admin 审核确认 */
  isVerified: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  /** 所属组织 ID（org 级硬隔离） */
  orgId: string | null;
  /** 所属团队 ID（team 级软隔离，personal 级为 null） */
  teamId: string | null;
  /** 一句话摘要（<200字符），recall_memory 轻量返回时使用 */
  abstract?: string | null;
  /** 可见性级别 */
  visibility: MemoryVisibility;
}

export interface GitContext {
  /** 稳定项目标识，优先从 remoteUrl 派生（如 'org/team/service-name'），回退到目录名 */
  projectName: string;
  projectPath: string;
  branchName: string;
  isWorktree: boolean;
  worktreePath: string | null;
  remoteUrl: string | null;
}

export interface SearchResult {
  entry: MemoryEntry;
  similarity: number;
  scopeScore: number;
  finalScore: number;
}

export const StoreMemoryInput = z.object({
  title: z.string().max(500),
  content: z.string(),
  scope: MemoryScope,
  source: MemorySource.default('manual'),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
  projectScope: ProjectScope.default('project'),
});

export type StoreMemoryInput = z.infer<typeof StoreMemoryInput>;

export const RecallMemoryInput = z.object({
  query: z.string(),
  scopeFilter: z.array(MemoryScope).optional(),
  tagsFilter: z.array(z.string()).optional(),
  includeArchived: z.boolean().default(false),
  limit: z.number().min(1).max(50).default(15),
  minSimilarity: z.number().min(0).max(1).default(0.5),
  detailLevel: z.enum(['full', 'summary']).default('full'),
});

export type RecallMemoryInput = z.infer<typeof RecallMemoryInput>;

export const ListMemoriesInput = z.object({
  scope: MemoryScope.optional(),
  source: MemorySource.optional(),
  tags: z.array(z.string()).optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  sortBy: z.enum(['created_at', 'updated_at']).default('updated_at'),
  page: z.number().min(1).default(1),
  pageSize: z.number().min(1).max(100).default(20),
});

export type ListMemoriesInput = z.infer<typeof ListMemoriesInput>;

export const UpdateMemoryInput = z.object({
  memoryId: z.string(),
  title: z.string().max(500).optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type UpdateMemoryInput = z.infer<typeof UpdateMemoryInput>;

export const ArchiveMemoryInput = z.object({
  memoryId: z.string(),
  reason: z.string(),
});

export type ArchiveMemoryInput = z.infer<typeof ArchiveMemoryInput>;

// ─── Rules Engine 类型 ─────────────────────────────────────────────

export const RuleStatus = z.enum(['candidate', 'voting', 'active', 'deprecated', 'rejected']);
export type RuleStatus = z.infer<typeof RuleStatus>;

export const RuleSeverity = z.enum(['critical', 'error', 'warning', 'info']);
export type RuleSeverity = z.infer<typeof RuleSeverity>;

export const RuleCategory = z.enum([
  'security', 'performance', 'style', 'logic', 'convention', 'architecture',
  'tool_usage', 'retrieval', 'storage', 'topology', 'context_tracking',
  'code_review', 'git_ops', 'documentation', 'release',
  'payment', 'data_integrity', 'compliance', 'audit',
  'deployment', 'monitoring', 'server_access',
]);
export type RuleCategory = z.infer<typeof RuleCategory>;

export const RuleType = z.enum([
  'coding', 'ai_agent', 'workflow', 'business', 'infra',
]);
export type RuleType = z.infer<typeof RuleType>;

export const VoterRole = z.enum(['admin', 'lead', 'developer']);
export type VoterRole = z.infer<typeof VoterRole>;

export const RuleEventType = z.enum([
  'applied', 'violated', 'accepted', 'rejected', 'auto_fixed',
]);
export type RuleEventType = z.infer<typeof RuleEventType>;

export const RuleDiscoverSource = z.enum(['code_review', 'bug_fix', 'codebase_scan']);
export type RuleDiscoverSource = z.infer<typeof RuleDiscoverSource>;

export const RuleProposeSource = z.enum([
  'manual', 'code_review', 'bug_fix', 'ai_suggestion', 'codebase_scan',
]);
export type RuleProposeSource = z.infer<typeof RuleProposeSource>;

export const ApiKeyCreationScope = z.enum(['read', 'readwrite', 'admin']);
export type ApiKeyCreationScope = z.infer<typeof ApiKeyCreationScope>;

export type RuleVisibility = 'personal' | 'team' | 'product_line' | 'global';

export interface Rule {
  id: string;
  projectId: string;
  ruleType: RuleType;
  title: string;
  description: string;
  rationale: string | null;
  exampleGood: string | null;
  exampleBad: string | null;
  autoFix: string | null;
  category: RuleCategory;
  language: string | null;
  severity: RuleSeverity;
  status: RuleStatus;
  source: MemorySource;
  sourceRef: Record<string, unknown> | null;
  embedding: number[] | null;
  appliedCount: number;
  violatedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  activatedAt: string | null;
  deprecatedAt: string | null;
  createdBy: string | null;
  teamId: string | null;
  visibility: RuleVisibility;
  createdAt: string;
  updatedAt: string;
}

export interface RuleVote {
  id: string;
  ruleId: string;
  userId: string;
  role: VoterRole;
  vote: -1 | 0 | 1;
  comment: string | null;
  createdAt: string;
}

export interface RuleEvent {
  id: string;
  ruleId: string;
  eventType: RuleEventType;
  filePath: string | null;
  codeSnippet: string | null;
  userId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface VotingConfig {
  minVoters: number;
  passThreshold: number;
  roleWeights: Record<VoterRole, number>;
  timeoutDays: number;
}

export interface ConflictCheckResult {
  hasDuplicate: boolean;
  duplicateRule?: { id: string; title: string; similarity: number };
  hasContradiction: boolean;
  contradictionRule?: { id: string; title: string; detail: string };
  hasScopeConflict: boolean;
  scopeConflictDetail?: string;
  relatedRules: Array<{ id: string; title: string; similarity: number }>;
}

export interface RuleViolation {
  ruleId: string;
  ruleTitle: string;
  severity: RuleSeverity;
  category: RuleCategory;
  description: string;
  violationScore: number;
  autoFix: string | null;
}

export interface RuleCandidate {
  title: string;
  description: string;
  category: RuleCategory;
  language: string | null;
  severity: RuleSeverity;
  confidence: number;
  sourceRef: Record<string, unknown>;
  similarExistingRules: Array<{ id: string; title: string; similarity: number }>;
}

export interface RuleMetricsOverview {
  totalActiveRules: number;
  totalApplied: number;
  totalViolations: number;
  adoptionRate: number;
  violationTrend: { current: number; previous: number; changePercent: number };
  coverageRate: number;
  topViolatedRules: Array<{ id: string; title: string; violatedCount: number }>;
  leastAdoptedRules: Array<{ id: string; title: string; adoptionRate: number }>;
  suggestedDeprecations: Array<{ id: string; title: string; reason: string }>;
}

// ─── M6: 技能树与知识图谱类型 ─────────────────────────────────────

export const SkillCategory = z.enum([
  'backend', 'frontend', 'devops', 'architecture',
  'engineering', 'soft_skill', 'domain',
]);
export type SkillCategory = z.infer<typeof SkillCategory>;

export const EvidenceType = z.enum([
  'code_commit', 'code_review', 'bug_fix',
  'architecture_decision', 'mentoring', 'learning',
]);
export type EvidenceType = z.infer<typeof EvidenceType>;

export const SkillEventType = z.enum([
  'level_up', 'evidence_added', 'peer_endorsed', 'milestone_reached',
]);
export type SkillEventType = z.infer<typeof SkillEventType>;

export const RelationType = z.enum([
  'related_to', 'evolved_from', 'superseded_by',
  'derived_from', 'requires', 'demonstrates', 'contradicts',
]);
export type RelationType = z.infer<typeof RelationType>;

export const TargetRole = z.enum([
  'senior_developer', 'tech_lead', 'architect', 'engineering_manager',
]);
export type TargetRole = z.infer<typeof TargetRole>;

export interface SkillDefinition {
  id: string;
  orgId: string;
  parentId: string | null;
  name: string;
  description: string | null;
  category: SkillCategory;
  maxLevel: number;
  levelCriteria: Array<{ level: number; criteria: string }>;
  sortOrder: number;
  createdAt: string;
}

export interface UserSkill {
  id: string;
  userId: string;
  skillId: string;
  currentLevel: number;
  confidence: number;
  evidence: SkillEvidence[];
  assessedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillEvidence {
  level: number;
  evidenceType: EvidenceType;
  evidenceRef: string | null;
  description: string;
  observedAt: string;
  assessedBy: 'ai' | 'self' | 'peer' | 'lead';
}

export interface SkillEvent {
  id: string;
  userId: string;
  skillId: string;
  eventType: SkillEventType;
  oldLevel: number | null;
  newLevel: number | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface KnowledgeRelation {
  id: string;
  sourceId: string;
  sourceType: 'entry' | 'rule' | 'skill';
  targetId: string;
  targetType: 'entry' | 'rule' | 'skill';
  relationType: RelationType;
  confidence: number;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
}

export interface SkillRadarPoint {
  skill: string;
  level: number;
  maxLevel: number;
  confidence: number;
}

export interface GrowthPathResult {
  currentProfile: {
    overallLevel: string;
    strengths: string[];
    gaps: string[];
  };
  pathToTarget: {
    target: string;
    estimatedMonths: number;
    milestones: Array<{
      skill: string;
      current: number;
      target: number;
      suggestions: string[];
    }>;
  };
}

export interface TeamSkillMatrix {
  skills: string[];
  members: Array<{
    userId: string;
    displayName: string;
    levels: Record<string, number>;
  }>;
  gaps: Array<{
    skill: string;
    avgLevel: number;
    recommendation: string;
  }>;
}

// MCP 工具输入

export const AssessSkillInput = z.object({
  skillName: z.string(),
  userId: z.string().optional(),
});
export type AssessSkillInput = z.infer<typeof AssessSkillInput>;

export const GetGrowthPathInput = z.object({
  targetRole: TargetRole.optional(),
  focusArea: z.string().optional(),
});
export type GetGrowthPathInput = z.infer<typeof GetGrowthPathInput>;

export const RecordMilestoneInput = z.object({
  skillName: z.string(),
  description: z.string(),
  evidenceType: EvidenceType.optional(),
  evidenceRef: z.string().optional(),
});
export type RecordMilestoneInput = z.infer<typeof RecordMilestoneInput>;

export const GetSkillRadarInput = z.object({
  userId: z.string().optional(),
  category: SkillCategory.optional(),
});
export type GetSkillRadarInput = z.infer<typeof GetSkillRadarInput>;

export const GetTeamMatrixInput = z.object({
  orgId: z.string().optional(),
  category: SkillCategory.optional(),
});
export type GetTeamMatrixInput = z.infer<typeof GetTeamMatrixInput>;

export const AddKnowledgeRelationInput = z.object({
  sourceId: z.string(),
  sourceType: z.enum(['entry', 'rule', 'skill']),
  targetId: z.string(),
  targetType: z.enum(['entry', 'rule', 'skill']),
  relationType: RelationType,
  confidence: z.number().min(0).max(1).default(0.8),
});
export type AddKnowledgeRelationInput = z.infer<typeof AddKnowledgeRelationInput>;

export const GetKnowledgeGraphInput = z.object({
  centerId: z.string(),
  centerType: z.enum(['entry', 'rule', 'skill']),
  depth: z.number().min(1).max(3).default(2),
  relationTypes: z.array(RelationType).optional(),
});
export type GetKnowledgeGraphInput = z.infer<typeof GetKnowledgeGraphInput>;


// ═══════════════════════════════════════════════════
//  Knowledge Base 类型定义
// ═══════════════════════════════════════════════════

export const KnowledgeType = z.enum(['faq', 'how_to', 'troubleshooting', 'technical', 'project', 'incident', 'runbook', 'api_reference']);
export type KnowledgeType = z.infer<typeof KnowledgeType>;

export const KnowledgeStatus = z.enum(['draft', 'published', 'archived']);
export type KnowledgeStatus = z.infer<typeof KnowledgeStatus>;

export const AnswerType = z.enum(['direct', 'guide', 'escalate']);
export type AnswerType = z.infer<typeof AnswerType>;

export const KnowledgeVisibility = z.enum(['personal', 'team', 'product_line', 'global']);
export type KnowledgeVisibility = z.infer<typeof KnowledgeVisibility>;

export const KnowledgeSourceType = z.enum(['manual', 'ticket', 'document', 'api_scan', 'auto_promote']);
export type KnowledgeSourceType = z.infer<typeof KnowledgeSourceType>;

export interface KnowledgeMedia {
  type: 'image' | 'video';
  url: string;
  visible_text?: string;
  description?: string;
}

export interface KnowledgeItem {
  id: string;
  projectId: string;
  productLine: string | null;
  knowledgeType: KnowledgeType;
  category: string | null;
  title: string;
  summary: string | null;
  content: string;
  question: string | null;
  metadata: Record<string, unknown>;
  tags: string[];
  answerType: AnswerType;
  embedding: number[] | null;
  mediaText: string;
  status: KnowledgeStatus;
  version: number;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  helpfulCount: number;
  unhelpfulCount: number;
  queryCount: number;
  media: KnowledgeMedia[];
  sourceType: KnowledgeSourceType | null;
  sourceRef: string | null;
  visibility: KnowledgeVisibility;
  teamId: string | null;
  orgId: string | null;
  slug: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KBSearchResult {
  id: string;
  title: string;
  question?: string | null;
  content: string;
  summary: string | null;
  knowledgeType: string;
  category: string | null;
  tags: string[];
  answerType: AnswerType;
  confidence: number;
  helpfulRatio: number;
  verified: boolean;
  media: KnowledgeMedia[];
}

export interface KBSearchResponse {
  results: KBSearchResult[];
  autoReplySuggested: boolean;
  total: number;
}

export const StoreKnowledgeInput = z.object({
  projectId: z.string(),
  productLine: z.string().optional(),
  knowledgeType: KnowledgeType.default('faq'),
  category: z.string().optional(),
  title: z.string().max(200),
  summary: z.string().max(500).optional(),
  content: z.string().max(20000),
  question: z.string().max(2000).optional(),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string().max(100)).max(20).default([]),
  answerType: AnswerType.default('direct'),
  media: z.array(z.object({
    type: z.enum(['image', 'video']),
    url: z.string().url(),
    visible_text: z.string().optional(),
    description: z.string().optional(),
  })).default([]),
  sourceType: KnowledgeSourceType.optional(),
  sourceRef: z.string().optional(),
  visibility: KnowledgeVisibility.default('product_line'),
  status: z.enum(['draft', 'published']).optional(),
  teamId: z.string().optional(),
  orgId: z.string().optional(),
});
export type StoreKnowledgeInput = z.infer<typeof StoreKnowledgeInput>;

export interface KnowledgeCategory {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  description: string | null;
  productLine: string | null;
  icon: string | null;
  sortOrder: number;
  fullPath: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const StoreCategoryInput = z.object({
  name: z.string(),
  slug: z.string(),
  parentId: z.string().uuid().optional(),
  description: z.string().optional(),
  productLine: z.string().optional(),
  icon: z.string().optional(),
  sortOrder: z.number().optional(),
});
export type StoreCategoryInput = z.infer<typeof StoreCategoryInput>;

export const SearchKnowledgeInput = z.object({
  query: z.string(),
  projectId: z.string().optional(),
  productLine: z.string().optional(),
  knowledgeType: KnowledgeType.optional(),
  category: z.string().optional(),
  limit: z.number().min(1).max(20).default(5),
  minConfidence: z.number().min(0).max(1).default(0.3),
  teamId: z.string().optional(),
  orgId: z.string().optional(),
});
export type SearchKnowledgeInput = z.infer<typeof SearchKnowledgeInput>;

export const KnowledgeFeedbackInput = z.object({
  knowledgeId: z.string().uuid(),
  ticketId: z.string().optional(),
  helpful: z.boolean(),
  comment: z.string().max(500).optional(),
});
export type KnowledgeFeedbackInput = z.infer<typeof KnowledgeFeedbackInput>;

export const ImportTicketsInput = z.object({
  productLine: z.string(),
  tickets: z.array(z.object({
    ticketId: z.string(),
    title: z.string(),
    description: z.string(),
    resolution: z.string(),
    category: z.string().optional(),
    tags: z.array(z.string()).default([]),
    resolvedAt: z.string().optional(),
    media: z.array(z.object({
      type: z.enum(['image', 'video']),
      url: z.string(),
    })).default([]),
  })).min(1).max(100),
  extractMode: z.enum(['llm', 'direct']).default('llm'),
  dryRun: z.boolean().default(false),
});
export type ImportTicketsInput = z.infer<typeof ImportTicketsInput>;
