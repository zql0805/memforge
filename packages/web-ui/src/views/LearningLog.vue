<script setup lang="ts">
// Created by dev on 2026/04/05
import { ref, computed, onMounted, watch } from 'vue'
import {
  learnFromCommits, learnFromReview, listLearningHistory,
  type CommitInsight, type ReviewInsight, type MemoryListResult,
} from '../api/mcp-tools'
import { useAuthStore } from '../stores/auth'
import { useProjectContext } from '../stores/project-context'
import { ElMessage } from 'element-plus'

const authStore = useAuthStore()
const projectCtx = useProjectContext()
const activeTab = ref('history')

// ─── 历史学习记录 ────────────────────
const historyLoading = ref(false)
const historyData = ref<MemoryListResult['entries']>([])
const historyPagination = ref({ total: 0, page: 1, pageSize: 20, totalPages: 0 })
const historySourceFilter = ref('')

const sourceOptions = [
  { value: '', label: '全部来源' },
  { value: 'code_review', label: 'Code Review' },
  { value: 'commit_analysis', label: 'Commit 分析' },
]

async function loadHistory(page = 1): Promise<void> {
  if (!authStore.isAuthenticated) return
  historyLoading.value = true
  try {
    const params: Record<string, unknown> = {
      page,
      page_size: historyPagination.value.pageSize,
      cross_project: true,
    }
    if (historySourceFilter.value) params.source = historySourceFilter.value
    if (projectCtx.selectedProductLine) params.product_line = projectCtx.selectedProductLine

    const result = await listLearningHistory(params)
    historyData.value = result.entries ?? []
    historyPagination.value = result.pagination ?? { total: 0, page, pageSize: 20, totalPages: 0 }
  } catch (err) {
    ElMessage.error(`加载历史记录失败: ${(err as Error).message}`)
  } finally {
    historyLoading.value = false
  }
}

function handleHistoryPageChange(page: number): void {
  loadHistory(page)
}

watch(historySourceFilter, () => loadHistory(1))

const historyScopeLabelMap: Record<string, string> = {
  review_insight: 'Review 洞察',
  coding_standard: '编码规范',
  bug_pattern: 'Bug 模式',
  performance_insight: '性能洞察',
  convention: '团队约定',
  architecture: '架构',
  lesson_learned: '经验教训',
}

const historyStats = computed(() => {
  const total = historyPagination.value.total
  const byScope = new Map<string, number>()
  for (const entry of historyData.value) {
    byScope.set(entry.scope, (byScope.get(entry.scope) ?? 0) + 1)
  }
  return { total, byScope }
})

function getScopeColor(scope: string): string {
  const colors: Record<string, string> = {
    review_insight: '',
    coding_standard: 'warning',
    bug_pattern: 'danger',
    performance_insight: 'success',
    architecture: 'info',
  }
  return colors[scope] ?? 'info'
}

function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  return dateStr.replace('T', ' ').replace(/\.\d+.*$/, '')
}

function extractSeverities(entry: MemoryListResult['entries'][0]): string {
  const meta = entry.metadata as Record<string, unknown> | undefined
  const count = meta?.findingCount as number | undefined
  const cat = meta?.category as string | undefined
  if (count && cat) return `${count} 个 ${cat} 问题`
  return ''
}

// ─── Commit 学习 ────────────────────
const commitForm = ref({
  count: 20,
  since: '',
  author: '',
  projectRoot: '',
  dryRun: false,
})
const commitInsights = ref<CommitInsight[]>([])
const commitStats = ref({ commitsAnalyzed: 0, insightsFound: 0, stored: 0, duplicates: 0, mode: '' })
const commitLoading = ref(false)

async function handleLearnFromCommits(): Promise<void> {
  if (!authStore.isAuthenticated) {
    ElMessage.warning('请先连接 Gateway')
    return
  }
  commitLoading.value = true
  try {
    const params: Record<string, unknown> = { count: commitForm.value.count }
    if (commitForm.value.since) params.since = commitForm.value.since
    if (commitForm.value.author) params.author = commitForm.value.author
    if (commitForm.value.projectRoot) params.project_root = commitForm.value.projectRoot
    if (projectCtx.selectedProductLine) params.product_line = projectCtx.selectedProductLine
    if (commitForm.value.dryRun) params.dry_run = true

    const result = await learnFromCommits(params as Parameters<typeof learnFromCommits>[0])
    commitInsights.value = result.insights ?? []
    commitStats.value = {
      commitsAnalyzed: result.commitsAnalyzed ?? 0,
      insightsFound: result.insightsFound ?? 0,
      stored: result.stored ?? 0,
      duplicates: result.duplicates ?? 0,
      mode: result.mode ?? '',
    }
    ElMessage.success(`分析完成：${result.insightsFound} 条洞察，${result.stored} 条已存储`)
  } catch (err) {
    ElMessage.error(`Commit 学习失败: ${(err as Error).message}`)
  } finally {
    commitLoading.value = false
  }
}

// ─── Review 学习 ────────────────────
const reviewForm = ref({
  prTitle: '',
  prUrl: '',
  comments: '',
})
const reviewInsights = ref<ReviewInsight[]>([])
const reviewStats = ref({ totalComments: 0, insightsExtracted: 0, ruleCandidateHint: '' })
const reviewLoading = ref(false)

async function handleLearnFromReview(): Promise<void> {
  if (!authStore.isAuthenticated) {
    ElMessage.warning('请先连接 Gateway')
    return
  }
  if (!reviewForm.value.comments.trim()) {
    ElMessage.warning('请输入 Review 评论')
    return
  }

  reviewLoading.value = true
  try {
    let comments: Array<{ reviewer: string; comment: string; file_path?: string; severity?: 'must-fix' | 'suggestion' | 'nit' }>
    try {
      comments = JSON.parse(reviewForm.value.comments)
      if (!Array.isArray(comments)) throw new Error('格式错误')
    } catch {
      comments = reviewForm.value.comments.split('\n').filter(Boolean).map(line => ({
        reviewer: 'reviewer',
        comment: line.trim(),
      }))
    }

    const result = await learnFromReview({
      comments,
      pr_title: reviewForm.value.prTitle || undefined,
      pr_url: reviewForm.value.prUrl || undefined,
      product_line: projectCtx.selectedProductLine || undefined,
    })
    reviewInsights.value = result.results ?? []
    reviewStats.value = {
      totalComments: result.totalComments ?? 0,
      insightsExtracted: result.insightsExtracted ?? 0,
      ruleCandidateHint: result.ruleCandidateHint ?? '',
    }
    ElMessage.success(`提取完成：${result.insightsExtracted} 条规范洞察`)
  } catch (err) {
    ElMessage.error(`Review 学习失败: ${(err as Error).message}`)
  } finally {
    reviewLoading.value = false
  }
}

function getTypeTagColor(type: string): string {
  const colors: Record<string, string> = {
    'bug-fix': 'danger',
    'refactor': 'warning',
    'performance': 'success',
    'feature': '',
    'security': 'danger',
    'migration': 'info',
    'notable': 'info',
  }
  return colors[type] ?? 'info'
}

onMounted(() => {
  projectCtx.loadProjects()
  if (authStore.isAuthenticated) loadHistory()
})
</script>

<template>
  <div>
    <el-row :gutter="16" style="margin-bottom: 16px">
      <el-col :span="6">
        <el-card shadow="never" body-style="padding: 16px">
          <el-statistic title="累计学习记录" :value="historyStats.total">
            <template #suffix>条</template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" body-style="padding: 16px">
          <el-statistic title="Commit 洞察" :value="commitStats.insightsFound">
            <template #suffix>条</template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" body-style="padding: 16px">
          <el-statistic title="Review 洞察" :value="reviewStats.insightsExtracted">
            <template #suffix>条</template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" body-style="padding: 16px">
          <div style="color: #909399; font-size: 12px; margin-bottom: 8px">运行模式</div>
          <div style="font-size: 14px; font-weight: 500">{{ commitStats.mode || '未执行' }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-tabs v-model="activeTab" type="border-card">
      <!-- 历史学习记录 Tab -->
      <el-tab-pane label="历史学习记录" name="history">
        <el-row :gutter="16" style="margin-bottom: 16px" align="middle">
          <el-col :span="6">
            <el-select v-model="historySourceFilter" placeholder="来源筛选" style="width: 100%">
              <el-option v-for="opt in sourceOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
            </el-select>
          </el-col>
          <el-col :span="6">
            <el-select
              :model-value="projectCtx.selectedProductLine"
              placeholder="全部产品线"
              clearable
              style="width: 100%"
              @update:model-value="(v: string) => { v ? projectCtx.setProductLine(v) : projectCtx.clearFilter(); loadHistory(1) }"
            >
              <el-option v-for="pl in projectCtx.productLines" :key="pl" :label="pl" :value="pl" />
            </el-select>
          </el-col>
          <el-col :span="4">
            <el-button icon="Refresh" :loading="historyLoading" @click="loadHistory(1)">刷新</el-button>
          </el-col>
        </el-row>

        <el-empty v-if="!historyLoading && historyData.length === 0" description="暂无历史学习记录。AI 执行 Code Review 后会自动存储 P0/P1 问题到这里。" />

        <el-table v-else v-loading="historyLoading" :data="historyData" stripe size="small">
          <el-table-column label="时间" width="160">
            <template #default="{ row }">
              <span style="font-size: 12px; color: #606266">{{ formatDate(row.createdAt) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="title" label="标题" min-width="300">
            <template #default="{ row }">
              <el-text style="font-size: 13px">{{ row.title }}</el-text>
            </template>
          </el-table-column>
          <el-table-column label="分类" width="120">
            <template #default="{ row }">
              <el-tag :type="getScopeColor(row.scope)" size="small">
                {{ historyScopeLabelMap[row.scope] ?? row.scope }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="详情" width="150">
            <template #default="{ row }">
              <span style="font-size: 12px; color: #909399">{{ extractSeverities(row) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="来源" width="100">
            <template #default="{ row }">
              <el-tag type="info" size="small">{{ row.source }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="项目" width="120">
            <template #default="{ row }">
              <el-text type="info" size="small">{{ row.projectId ?? '—' }}</el-text>
            </template>
          </el-table-column>
          <el-table-column type="expand">
            <template #default="{ row }">
              <div style="padding: 12px 24px; white-space: pre-wrap; font-size: 12px; color: #606266; line-height: 1.6; background: #fafafa; border-radius: 4px">{{ row.content }}</div>
            </template>
          </el-table-column>
        </el-table>

        <el-pagination
          v-if="historyPagination.totalPages > 1"
          style="margin-top: 16px; justify-content: center"
          layout="prev, pager, next, total"
          :total="historyPagination.total"
          :page-size="historyPagination.pageSize"
          :current-page="historyPagination.page"
          @current-change="handleHistoryPageChange"
        />
      </el-tab-pane>

      <!-- Commit 学习 Tab -->
      <el-tab-pane label="Commit 学习" name="commits">
        <el-row :gutter="20">
          <el-col :span="8">
            <el-card shadow="never">
              <template #header>
                <span>分析配置</span>
              </template>
              <el-form :model="commitForm" label-width="80px" size="default">
                <el-form-item label="数量">
                  <el-input-number v-model="commitForm.count" :min="1" :max="100" style="width: 100%" />
                </el-form-item>
                <el-form-item label="起始日期">
                  <el-input v-model="commitForm.since" placeholder="如 2026-04-01" />
                </el-form-item>
                <el-form-item label="作者">
                  <el-input v-model="commitForm.author" placeholder="留空=全部作者" />
                </el-form-item>
                <el-form-item label="项目路径">
                  <el-select v-model="commitForm.projectRoot" placeholder="选择仓库" clearable filterable style="width: 100%">
                    <el-option v-for="proj in projectCtx.knownProjects" :key="proj.path" :label="proj.label" :value="proj.path">
                      <span>{{ proj.label }}</span>
                      <span style="color: #909399; font-size: 11px; margin-left: 8px">{{ proj.path }}</span>
                    </el-option>
                  </el-select>
                </el-form-item>
                <el-form-item label="产品线">
                  <el-select
                    :model-value="projectCtx.selectedProductLine"
                    placeholder="全部"
                    clearable
                    style="width: 100%"
                    @update:model-value="(v: string) => v ? projectCtx.setProductLine(v) : projectCtx.clearFilter()"
                  >
                    <el-option v-for="pl in projectCtx.productLines" :key="pl" :label="pl" :value="pl" />
                  </el-select>
                </el-form-item>
                <el-form-item label="试运行">
                  <el-switch v-model="commitForm.dryRun" />
                </el-form-item>
                <el-form-item>
                  <el-button type="primary" :loading="commitLoading" icon="Cpu" @click="handleLearnFromCommits">
                    开始学习
                  </el-button>
                </el-form-item>
              </el-form>
            </el-card>
          </el-col>

          <el-col :span="16">
            <el-card shadow="never">
              <template #header>
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <span>学习结果</span>
                  <el-tag v-if="commitStats.stored > 0" type="success" size="small">{{ commitStats.stored }} 条已存储</el-tag>
                </div>
              </template>
              <el-empty v-if="commitInsights.length === 0" description="点击「开始学习」分析 Git commit 历史" />
              <el-table v-else :data="commitInsights" stripe size="small">
                <el-table-column prop="hash" label="Hash" width="80">
                  <template #default="{ row }">
                    <el-text type="info" size="small" tag="code">{{ row.hash }}</el-text>
                  </template>
                </el-table-column>
                <el-table-column prop="message" label="提交信息" min-width="250" />
                <el-table-column label="类型" width="100">
                  <template #default="{ row }">
                    <el-tag :type="getTypeTagColor(row.type)" size="small">{{ row.type }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="author" label="作者" width="80" />
                <el-table-column prop="date" label="日期" width="100" />
                <el-table-column label="状态" width="90" align="center">
                  <template #default="{ row }">
                    <el-tag v-if="row.stored" type="success" size="small">已存储</el-tag>
                    <el-tag v-else-if="row.duplicate" type="warning" size="small">重复</el-tag>
                    <el-tag v-else type="info" size="small">跳过</el-tag>
                  </template>
                </el-table-column>
              </el-table>
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- Review 学习 Tab -->
      <el-tab-pane label="Review 学习" name="reviews">
        <el-row :gutter="20">
          <el-col :span="8">
            <el-card shadow="never">
              <template #header>
                <span>输入 Review 信息</span>
              </template>
              <el-form :model="reviewForm" label-width="80px" size="default">
                <el-form-item label="PR 标题">
                  <el-input v-model="reviewForm.prTitle" placeholder="PR 标题" />
                </el-form-item>
                <el-form-item label="PR 链接">
                  <el-input v-model="reviewForm.prUrl" placeholder="https://..." />
                </el-form-item>
                <el-form-item label="评论">
                  <el-input
                    v-model="reviewForm.comments"
                    type="textarea"
                    :rows="6"
                    placeholder="支持两种格式：&#10;1. JSON 数组: [{&quot;reviewer&quot;:&quot;张三&quot;,&quot;comment&quot;:&quot;...&quot;}]&#10;2. 纯文本: 每行一条评论"
                  />
                </el-form-item>
                <el-form-item>
                  <el-button type="primary" :loading="reviewLoading" icon="ChatDotRound" @click="handleLearnFromReview">
                    开始分析
                  </el-button>
                </el-form-item>
              </el-form>
            </el-card>
          </el-col>

          <el-col :span="16">
            <el-card shadow="never">
              <template #header>
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <span>提取的规范洞察</span>
                  <el-tag v-if="reviewInsights.filter(i => i.isRuleCandidate).length > 0" type="warning" size="small">
                    {{ reviewInsights.filter(i => i.isRuleCandidate).length }} 条规范候选
                  </el-tag>
                </div>
              </template>
              <el-empty v-if="reviewInsights.length === 0" description="输入 Code Review 评论后点击「开始分析」" />
              <el-table v-else :data="reviewInsights" stripe size="small">
                <el-table-column label="类别" width="130">
                  <template #default="{ row }">
                    <el-tag size="small">{{ row.category }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="summary" label="摘要" min-width="280" />
                <el-table-column label="状态" width="160">
                  <template #default="{ row }">
                    <el-tag :type="row.action.includes('已存入') ? 'success' : 'info'" size="small">
                      {{ row.action }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="规范候选" width="90" align="center">
                  <template #default="{ row }">
                    <el-icon v-if="row.isRuleCandidate" color="#E6A23C"><Star /></el-icon>
                    <span v-else style="color: #c0c4cc">—</span>
                  </template>
                </el-table-column>
              </el-table>
              <el-alert
                v-if="reviewStats.ruleCandidateHint"
                :title="reviewStats.ruleCandidateHint"
                type="warning"
                :closable="false"
                style="margin-top: 12px"
              />
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
