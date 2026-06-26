// Created by dev on 2026/04/05
// Copyright © 2026

import { mcpCall } from './client'

interface ToolCallResult {
  content: Array<{ type: string; text: string }>
}

async function callTool<T>(
  name: string,
  args: Record<string, unknown> = {},
  opts?: { timeout?: number },
): Promise<T> {
  const result = await mcpCall<ToolCallResult>(
    'tools/call',
    {
      name,
      arguments: args,
    },
    { timeout: opts?.timeout },
  )
  const text = result.content?.[0]?.text
  if (text === undefined || text === '') {
    return result as unknown as T
  }
  let parsed: T
  try {
    parsed = JSON.parse(text) as T
  } catch {
    throw new Error(
      typeof text === 'string' && text.length > 0
        ? (text.length > 600 ? `${text.slice(0, 600)}…` : text)
        : '接口返回内容无法解析为 JSON',
    )
  }
  if (parsed && typeof parsed === 'object' && 'success' in parsed && (parsed as Record<string, unknown>).success === false) {
    const errMsg = (parsed as Record<string, unknown>).error ?? (parsed as Record<string, unknown>).message ?? '操作失败'
    throw new Error(String(errMsg))
  }
  return parsed
}

// ─── Memory Service 工具 ────────────────────

export interface MemoryListResult {
  success: boolean
  entries: Array<{
    id: string
    title: string
    content: string
    scope: string
    source: string
    tags: string[]
    projectId?: string
    metadata: Record<string, unknown>
    isArchived: boolean
    visibility?: 'personal' | 'team' | 'product_line' | 'global'
    createdBy?: string
    createdByName?: string
    createdAt: string
    updatedAt: string
  }>
  pagination: { total: number; page: number; pageSize: number; totalPages: number }
}

export interface MemoryRecallResult {
  success: boolean
  results: Array<{
    id: string
    title: string
    content: string
    scope: string
    tags: string[]
    similarity: number
    createdAt: string
  }>
}

export interface MemoryStoreResult {
  success: boolean
  id: string
  deduplicated?: boolean
}

export function listMemories(params: {
  page?: number
  page_size?: number
  scope?: string
  tags?: string[]
  product_line?: string
  cross_project?: boolean
} = {}): Promise<MemoryListResult> {
  return callTool('list_memories', params)
}

export function recallMemory(query: string, limit = 10, opts?: {
  tags_filter?: string[]
  scope_filter?: string[]
  min_similarity?: number
  product_line?: string
  max_content_length?: number
}): Promise<MemoryRecallResult> {
  return callTool('recall_memory', { query, limit, ...opts })
}

export function storeMemory(params: {
  title: string
  content: string
  scope: string
  source?: string
  tags?: string[]
}): Promise<MemoryStoreResult> {
  return callTool('store_memory', { source: 'manual', ...params })
}

export function updateMemory(id: string, updates: {
  title?: string
  content?: string
  tags?: string[]
  visibility?: 'global' | 'product_line' | 'project'
  product_line?: string
}): Promise<{ success: boolean }> {
  return callTool('update_memory', { memory_id: id, ...updates })
}

export function archiveMemory(id: string, reason: string): Promise<{ success: boolean }> {
  return callTool('archive_memory', { memory_id: id, reason })
}

// ─── Rules Engine 工具 ────────────────────

export interface RuleListResult {
  success: boolean
  rules: Array<{
    id: string
    title: string
    description?: string
    ruleType: string
    category: string
    language: string | null
    severity: string
    status: string
    projectId?: string
    visibility?: string
    metadata?: { source_product_line?: string }
    source?: string
    sourceRef?: Record<string, unknown>
    appliedCount: number
    violatedCount: number
    createdBy?: string
    createdByName?: string | null
    createdAt: string
    updatedAt?: string
  }>
  pagination: { total: number; page: number; pageSize: number; totalPages: number }
}

export interface RuleDetailResult {
  success: boolean
  rule: {
    id: string
    projectId: string
    ruleType: string
    title: string
    description: string
    rationale: string | null
    example_bad: string | null
    example_good: string | null
    auto_fix: string | null
    category: string
    language: string | null
    severity: string
    status: string
    source: string | null
    metrics: {
      appliedCount: number
      violatedCount: number
      acceptedCount: number
      rejectedCount: number
      adoptionRate: number | null
    }
    voting: {
      summary: { approve: number; reject: number; abstain: number }
      votes: Array<{ userId: string; vote: string; role: string; comment: string | null; createdAt: string }>
    }
    recentEvents: Array<{ eventType: string; filePath: string | null; createdAt: string }>
    createdBy: string | null
    createdAt: string
    updatedAt: string
  }
}

export interface MeasureResult {
  success: boolean
  overview?: {
    totalActiveRules: number
    totalApplied: number
    totalViolations: number
    adoptionRate: number
    violationTrend: { current: number; previous: number; changePercent: number }
    coverageRate: number
    topViolatedRules: Array<{ id: string; title: string; violatedCount: number }>
    leastAdoptedRules: Array<{ id: string; title: string; adoptionRate: number }>
    suggestedDeprecations: Array<{ id: string; title: string; reason: string }>
  }
}

export function listRules(params: {
  page?: number
  page_size?: number
  status?: string
  category?: string
  language?: string
  severity?: string
  product_line?: string
  cross_project?: boolean
  rule_types?: Array<'coding' | 'ai_agent' | 'workflow' | 'business' | 'infra'>
  search?: string
  sort_by?: 'created_at' | 'updated_at'
} = {}): Promise<RuleListResult> {
  return callTool('list_rules', params)
}

export function getRule(ruleId: string): Promise<RuleDetailResult> {
  return callTool('get_rule', { rule_id: ruleId })
}

export function measureRules(timeRange = '30d'): Promise<MeasureResult> {
  return callTool('measure_rules', { time_range: timeRange })
}

export interface ProposeRuleResult {
  success: boolean
  ruleId: string
  status: string
  conflicts?: Array<{ type: string; existingRuleId: string; existingTitle: string; similarity?: number }>
  message: string
}

export function proposeRule(params: {
  title: string
  description: string
  rationale?: string
  example_good?: string
  example_bad?: string
  category: string
  severity: string
  language?: string
  source?: string
  auto_activate?: boolean
  visibility?: 'global' | 'product_line' | 'project'
  product_line?: string
  rule_type?: 'coding' | 'ai_agent' | 'workflow' | 'business' | 'infra'
}): Promise<ProposeRuleResult> {
  return callTool('propose_rule', { source: 'manual', ...params })
}

export function voteRule(params: {
  rule_id: string
  user_id: string
  role: string
  vote: number
  comment?: string
}): Promise<{ success: boolean; newStatus?: string; message: string }> {
  return callTool('vote_rule', params)
}

export function updateRule(ruleId: string, updates: {
  title?: string
  description?: string
  rationale?: string
  example_good?: string
  example_bad?: string
  category?: string
  severity?: string
  language?: string
  rule_type?: 'coding' | 'ai_agent' | 'workflow' | 'business' | 'infra'
}): Promise<{ success: boolean; message: string }> {
  return callTool('update_rule', { rule_id: ruleId, ...updates })
}

export function deprecateRule(ruleId: string, reason: string): Promise<{ success: boolean; message: string }> {
  return callTool('deprecate_rule', { rule_id: ruleId, reason })
}

export function activateRule(ruleId: string, reason?: string): Promise<{ success: boolean; message: string }> {
  const args: Record<string, unknown> = { rule_id: ruleId }
  if (reason) args.reason = reason
  return callTool('activate_rule', args)
}

// ─── Skill & Knowledge 工具 ────────────────

export interface SkillRadarResult {
  success: boolean
  axes: Array<{ name: string; level: number; max: number }>
}

export interface TeamMatrixResult {
  success: boolean
  matrix: Array<{
    userId: string
    displayName: string
    skills: Array<{ name: string; level: number }>
  }>
}

export interface KnowledgeGraphResult {
  success: boolean
  nodes: Array<{
    id: string
    type: string
    label: string
    metadata: Record<string, unknown>
  }>
  edges: Array<{
    source: string
    sourceType: string
    target: string
    targetType: string
    relation: string
    confidence: number
  }>
}

export function getSkillRadar(userId: string): Promise<SkillRadarResult> {
  return callTool('get_skill_radar', { user_id: userId })
}

export interface DeveloperProfileResult {
  success: boolean
  overview: {
    totalMemories: number
    totalRules: number
    totalRelations: number
    totalWorkContexts: number
    memberSince: string | null
    lastActivity: string | null
  }
  knowledgeDomains: Array<{ scope: string; count: number }>
  techStack: Array<{ tag: string; count: number }>
  monthlyActivity: Array<{ month: string; count: number }>
  reviewInsights: Array<{ category: string; severity: string; count: number }>
  workPatterns: Array<{ work_type: string; status: string; count: number; avg_hours: number | null }>
  strengths: string[]
  improvements: string[]
}

export function getDeveloperProfile(productLine?: string): Promise<DeveloperProfileResult> {
  return callTool('get_developer_profile', productLine ? { product_line: productLine } : {})
}

export function getTeamMatrix(): Promise<TeamMatrixResult> {
  return callTool('get_team_matrix', {})
}

export function getKnowledgeGraph(centerId: string, centerType: string, depth = 2): Promise<KnowledgeGraphResult> {
  return callTool('get_knowledge_graph', { center_id: centerId, center_type: centerType, depth })
}

// ─── 文档索引工具 ────────────────────

export interface IndexResult {
  success: boolean
  totalFiles: number
  totalStored: number
  totalDuplicates: number
  totalErrors: number
  results: Array<{
    file: string
    stored: number
    duplicates: number
    errors: number
  }>
}

export function indexDocuments(params: {
  directory: string
  project_root?: string
  scope?: string
  tags?: string[]
  recursive?: boolean
  dry_run?: boolean
  product_line?: string
}): Promise<IndexResult> {
  return callTool('index_documents', params)
}

export function syncDocuments(params: { since?: string; directory?: string; project_root?: string; dry_run?: boolean } = {}): Promise<{
  success: boolean
  synced: number
  changes: Array<{ file: string; action: string }>
}> {
  return callTool('sync_documents', params)
}

export function watchDocs(params: { action?: string; directory?: string; project_root?: string } = {}): Promise<{
  success: boolean
  status: string
  directory: string
  filesProcessed: number
}> {
  return callTool('watch_docs', params)
}

// ─── 学习工具 ────────────────────

export interface CommitInsight {
  hash: string
  message: string
  author: string
  date: string
  type: string
  scope: string
  stored?: boolean
  duplicate?: boolean
}

export interface CommitLearnResult {
  mode: string
  commitsAnalyzed: number
  insightsFound: number
  stored: number
  duplicates: number
  insights: CommitInsight[]
}

export function learnFromCommits(params: {
  count?: number
  since?: string
  author?: string
  project_root?: string
  product_line?: string
  dry_run?: boolean
} = {}): Promise<CommitLearnResult> {
  return callTool('learn_from_commits', params)
}

export interface ReviewInsight {
  category: string
  summary: string
  action: string
  isRuleCandidate?: boolean
  duplicateOf?: string
}

export interface ReviewLearnResult {
  totalComments: number
  insightsExtracted: number
  results: ReviewInsight[]
  ruleCandidateHint?: string
}

export function learnFromReview(params: {
  comments: Array<{
    reviewer: string
    comment: string
    file_path?: string
    code_snippet?: string
    severity?: 'must-fix' | 'suggestion' | 'nit'
  }>
  pr_title?: string
  pr_url?: string
  product_line?: string
}): Promise<ReviewLearnResult> {
  return callTool('learn_from_review', params)
}

export function listLearningHistory(params: {
  page?: number
  page_size?: number
  source?: string
  scope?: string
  product_line?: string
  cross_project?: boolean
  view_as_user?: string
} = {}): Promise<MemoryListResult> {
  const merged: Record<string, unknown> = {
    ...params,
    cross_project: params.cross_project ?? true,
  }
  if (params.source) merged.source = params.source
  return callTool('list_memories', merged)
}

// ─── 工作上下文追踪 ────────────────────

export interface WorkContextProject {
  name: string
  branch: string | null
  files_changed: number
  lines_added: number
  lines_deleted: number
  commits: number
}

export interface WorkContextMetadata {
  type: 'work_context'
  work_type: string
  status: string
  started_at: string
  completed_at: string | null
  estimated_hours: number | null
  priority: string | null
  projects: WorkContextProject[]
  documents: string[]
  related_memories: string[]
  source_project: string
  source_product_line: string | null
  visibility: string
  last_updated?: string
  evaluation?: {
    duration_hours: number
    total_files_changed: number
    total_lines_added: number
    total_lines_deleted: number
    total_commits: number
    memories_referenced: number
    lessons_generated: number
    outcome: string
  }
}

export interface WorkContextEntry {
  id: string
  title: string
  content: string
  scope: string
  source: string
  tags: string[]
  projectId?: string
  metadata: WorkContextMetadata
  isArchived: boolean
  createdAt: string
  updatedAt: string
}

export interface StartWorkContextResult {
  success: boolean
  context_id: string
  title: string
  work_type: string
  projects: string[]
  related_memories: Array<{ id: string; title: string; scope: string; similarity: string }>
  message: string
}

export interface UpdateWorkContextResult {
  success: boolean
  context_id: string
  projects: WorkContextProject[]
  documents: string[]
  message: string
}

export interface EvaluateWorkContextResult {
  success: boolean
  context_id: string
  title: string
  outcome: string
  duration: { started_at: string; completed_at: string; total_hours: number }
  projects: WorkContextProject[]
  totals: { files_changed: number; lines_added: number; lines_deleted: number; commits: number }
  memories_referenced: number
  lessons_stored: number
  message: string
}

export function listWorkContexts(params: {
  page?: number
  page_size?: number
  product_line?: string
  cross_project?: boolean
} = {}): Promise<MemoryListResult> {
  return callTool('list_memories', {
    ...params,
    scope: 'task_progress',
    tags: ['work-context'],
  })
}

export function startWorkContext(params: {
  title: string
  type: string
  description?: string
  projects?: Array<{ name: string; branch?: string }>
  estimated_hours?: number
  priority?: string
  related_doc_urls?: string[]
  product_line?: string
  tags?: string[]
}): Promise<StartWorkContextResult> {
  return callTool('start_work_context', params)
}

export function updateWorkContext(params: {
  context_id: string
  add_project?: { name: string; branch?: string; project_root?: string }
  add_documents?: string[]
  progress_note?: string
  collect_git_stats?: boolean
}): Promise<UpdateWorkContextResult> {
  return callTool('update_work_context', params)
}

export function evaluateWorkContext(params: {
  context_id: string
  outcome: 'completed' | 'cancelled' | 'deferred'
  summary?: string
  lessons?: string[]
  project_roots?: Record<string, string>
}): Promise<EvaluateWorkContextResult> {
  return callTool('evaluate_work_context', params)
}

// ─── Topology 工具 ─────────────────────────────

export interface ScanTopologyResult {
  engine: string
  scanned: number
  results: Array<{
    productLine: string
    repoCount: number
    edgeCount: number
    filePath: string
    stored: number
  }>
  totalRepos: number
  totalEdges: number
  totalStored: number
}

/** 全仓库扫描常超过 30s，与 Gateway 上限对齐见 Topology 页 */
const SCAN_TOPOLOGY_TIMEOUT_MS = 15 * 60 * 1000

export function scanTopology(params: {
  product_line?: string
  scan_roots?: string[]
  git_patterns?: string[]
  skip_scan?: boolean
  force?: boolean
}): Promise<ScanTopologyResult> {
  return callTool('scan_topology', params, { timeout: SCAN_TOPOLOGY_TIMEOUT_MS })
}

// ─── Agent Task System ──────────────────────

export interface AgentTask {
  id: number
  user_id: string
  title: string
  description: string | null
  category: string
  priority: string
  status: string
  product_line: string | null
  project: string | null
  tags: string[]
  related_items: Array<{ type: string; id?: string; value?: string; path?: string; title?: string }>
  started_at: string | null
  completed_at: string | null
  execution_summary: string | null
  execution_issues: string | null
  conversation_id: string | null
  history_file_path: string | null
  last_heartbeat: string | null
  created_at: string
  updated_at: string
  created_by: string
  sort_order: number
}

export interface GetTasksResult {
  success: boolean
  tasks: AgentTask[]
  total: number
  has_more: boolean
}

export function getAgentTasks(params: {
  status?: string
  category?: string
  product_line?: string
  priority?: string
  limit?: number
  offset?: number
  sort_by?: string
  sort_order?: string
}): Promise<GetTasksResult> {
  return callTool('get_agent_tasks', { ...params, format: 'json' })
}

export function createAgentTask(params: {
  title: string
  description?: string
  category?: string
  priority?: string
  status?: 'pending' | 'suspended'
  product_line?: string
  project?: string
  tags?: string[]
}): Promise<{ success: boolean; task: AgentTask }> {
  return callTool('create_agent_task', params)
}

export function updateAgentTask(params: {
  task_id: number
  status?: string
  title?: string
  description?: string
  category?: string
  product_line?: string
  project?: string
  priority?: string
  sort_order?: number
  tags?: string[]
  related_items?: Array<{ type: string; id?: string; value?: string; path?: string; title?: string }>
  execution_summary?: string
  execution_issues?: string
  heartbeat?: boolean
  expected_updated_at?: string
}): Promise<{ success: boolean; task: AgentTask }> {
  return callTool('update_agent_task', params)
}

export function batchUpdateTasks(params: {
  task_ids: number[]
  updates: { status?: string; category?: string; priority?: string }
}): Promise<{ success: boolean; affected: number }> {
  return callTool('batch_update_tasks', params)
}

export function deleteAgentTask(taskId: number): Promise<{ success: boolean }> {
  return callTool('update_agent_task', { task_id: taskId, status: 'cancelled' })
}
