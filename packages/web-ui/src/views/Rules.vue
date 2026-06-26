<script setup lang="ts">
// Created by dev on 2026/04/05
import { ref, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  listRules, proposeRule, voteRule, deprecateRule, activateRule,
  type RuleListResult,
} from '../api/mcp-tools'
import { useAuthStore } from '../stores/auth'
import { useProjectContext } from '../stores/project-context'
import { useRouter } from 'vue-router'
import type { ElTagType } from '../types/element-plus'

const router = useRouter()
const authStore = useAuthStore()
const projectCtx = useProjectContext()
const loading = ref(false)
const activeTab = ref('active')
const currentPage = ref(1)
const pageSize = ref(20)
const total = ref(0)
const rules = ref<RuleListResult['rules']>([])
const searchKeyword = ref('')
const filterRuleType = ref('')
const filterCategory = ref('')
const filterLanguage = ref('')
const filterSeverity = ref('')

const proposeDialogVisible = ref(false)
const proposeSubmitting = ref(false)
const proposeForm = ref({
  title: '',
  description: '',
  rationale: '',
  example_good: '',
  example_bad: '',
  category: 'convention',
  severity: 'warning',
  language: '',
  auto_activate: false,
  visibility: 'project' as 'global' | 'product_line' | 'project',
})

const voteDialogVisible = ref(false)
const voteSubmitting = ref(false)
const voteTarget = ref<{ id: string; title: string } | null>(null)
const voteForm = ref({ vote: 1, comment: '' })

const ruleTypeOptions = [
  { value: 'coding', label: '编码规范' },
  { value: 'ai_agent', label: 'AI 行为' },
  { value: 'workflow', label: '工作流程' },
  { value: 'business', label: '业务规则' },
  { value: 'infra', label: '基础设施' },
]
const categoryOptions = [
  { value: 'security', label: '安全' },
  { value: 'performance', label: '性能' },
  { value: 'style', label: '代码风格' },
  { value: 'logic', label: '逻辑' },
  { value: 'convention', label: '约定' },
  { value: 'architecture', label: '架构' },
  { value: 'exception_handling', label: '异常处理' },
  { value: 'naming', label: '命名' },
  { value: 'testing', label: '测试' },
  { value: 'documentation', label: '文档' },
  { value: 'ai_behavior', label: 'AI 行为' },
  { value: 'git_ops', label: 'Git 操作' },
  { value: 'deployment', label: '部署' },
  { value: 'monitoring', label: '监控' },
]
const severityOptions = [
  { value: 'critical', label: 'P0 必须遵守' },
  { value: 'error', label: 'P1 强烈建议' },
  { value: 'warning', label: 'P2 建议' },
  { value: 'info', label: '参考' },
]

const sortByOptions = [
  { value: 'created_at', label: '创建时间' },
  { value: 'updated_at', label: '修改时间' },
]
const filterSortBy = ref('created_at')

const languageOptions = [
  { value: 'java', label: 'Java' },
  { value: 'php', label: 'PHP' },
  { value: 'go', label: 'Go' },
  { value: 'python', label: 'Python' },
  { value: 'cpp', label: 'C++' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
]

async function loadRules(): Promise<void> {
  if (!authStore.isAuthenticated) return
  loading.value = true
  try {
    const params: Record<string, unknown> = {
      status: activeTab.value,
      page: currentPage.value,
      page_size: pageSize.value,
      sort_by: filterSortBy.value,
      ...projectCtx.queryParams,
    }
    if (searchKeyword.value.trim()) params.search = searchKeyword.value.trim()
    if (filterRuleType.value) params.rule_types = [filterRuleType.value]
    if (filterCategory.value) params.category = filterCategory.value
    if (filterLanguage.value) params.language = filterLanguage.value
    if (filterSeverity.value) params.severity = filterSeverity.value

    const result = await listRules(params as Parameters<typeof listRules>[0])
    if (result.success) {
      rules.value = result.rules
      total.value = result.pagination?.total ?? result.rules.length
    }
  } catch (e) {
    console.error('加载规则列表失败:', e)
    ElMessage.error('加载规则列表失败')
  } finally {
    loading.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
function handleSearch(): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { currentPage.value = 1; loadRules() }, 300)
}

function getSeverityType(severity: string): string {
  const map: Record<string, string> = { critical: 'danger', error: 'warning', warning: '', info: 'info' }
  return map[severity] ?? 'info'
}

function getSeverityLabel(severity: string): string {
  const map: Record<string, string> = { critical: 'P0', error: 'P1', warning: 'P2', info: '参考' }
  return map[severity] ?? severity
}

function getCategoryLabel(category: string): string {
  const found = categoryOptions.find(o => o.value === category)
  return found?.label ?? category
}

function getLanguageLabel(lang: string | null): string {
  if (!lang) return '通用'
  const found = languageOptions.find(o => o.value === lang)
  return found?.label ?? lang
}

function getVisibilityLabel(row: RuleListResult['rules'][0]): string {
  if (row.visibility === 'global' || row.projectId === '_global_') return '全局'
  if (row.visibility === 'product_line') return row.metadata?.source_product_line ?? row.projectId ?? '产品线'
  if (row.visibility === 'project') return '项目'
  if (row.projectId && row.projectId !== 'default') return row.projectId
  return '默认'
}

function getVisibilityType(row: RuleListResult['rules'][0]): ElTagType {
  if (row.visibility === 'global' || row.projectId === '_global_') return 'danger'
  if (row.visibility === 'product_line') return 'warning'
  if (row.visibility === 'project') return 'success'
  return 'info'
}

function getRuleTypeLabel(ruleType: string): string {
  const map: Record<string, string> = {
    coding: '编码', ai_agent: 'AI', workflow: '流程', business: '业务', infra: '基础设施',
  }
  return map[ruleType] ?? ruleType
}

function getRuleTypeTagType(ruleType: string): string {
  const map: Record<string, string> = {
    coding: '', ai_agent: 'warning', workflow: 'success', business: 'info', infra: 'danger',
  }
  return map[ruleType] ?? 'info'
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function truncate(text?: string, max = 40): string {
  if (!text) return '-'
  return text.length > max ? text.slice(0, max) + '…' : text
}

function openProposeDialog(): void {
  proposeForm.value = {
    title: '', description: '', rationale: '', example_good: '', example_bad: '',
    category: 'convention', severity: 'warning', language: '', auto_activate: false,
    visibility: 'project',
  }
  proposeDialogVisible.value = true
}

async function submitPropose(): Promise<void> {
  if (!proposeForm.value.title || !proposeForm.value.description) {
    ElMessage.warning('标题和描述不能为空')
    return
  }
  proposeSubmitting.value = true
  try {
    const params: Record<string, unknown> = {
      title: proposeForm.value.title,
      description: proposeForm.value.description,
      category: proposeForm.value.category,
      severity: proposeForm.value.severity,
      visibility: proposeForm.value.visibility,
      auto_activate: proposeForm.value.auto_activate,
    }
    if (proposeForm.value.rationale) params.rationale = proposeForm.value.rationale
    if (proposeForm.value.example_good) params.example_good = proposeForm.value.example_good
    if (proposeForm.value.example_bad) params.example_bad = proposeForm.value.example_bad
    if (proposeForm.value.language) params.language = proposeForm.value.language
    if (projectCtx.selectedProductLine) params.product_line = projectCtx.selectedProductLine

    const result = await proposeRule(params as Parameters<typeof proposeRule>[0])
    if (result.success) {
      ElMessage.success(result.message || '规则已提议')
      proposeDialogVisible.value = false
      loadRules()
    } else {
      ElMessage.error('提议失败')
    }
  } catch (e) {
    ElMessage.error('提议失败: ' + (e instanceof Error ? e.message : '未知错误'))
  } finally {
    proposeSubmitting.value = false
  }
}

function openVoteDialog(row: { id: string; title: string }): void {
  voteTarget.value = row
  voteForm.value = { vote: 1, comment: '' }
  voteDialogVisible.value = true
}

async function submitVote(): Promise<void> {
  if (!voteTarget.value) return
  voteSubmitting.value = true
  try {
    const result = await voteRule({
      rule_id: voteTarget.value.id,
      user_id: authStore.userId ?? 'anonymous',
      role: authStore.role ?? 'developer',
      vote: voteForm.value.vote,
      comment: voteForm.value.comment || undefined,
    })
    if (result.success) {
      ElMessage.success(result.message || '投票成功')
      voteDialogVisible.value = false
      loadRules()
    } else {
      ElMessage.error(result.message || '投票失败')
    }
  } catch (e) {
    ElMessage.error('投票失败: ' + (e instanceof Error ? e.message : '未知错误'))
  } finally {
    voteSubmitting.value = false
  }
}

async function handleDeprecate(row: { id: string; title: string }): Promise<void> {
  try {
    const { value: reason } = await ElMessageBox.prompt(
      `确定废弃规则「${row.title}」？`, '废弃确认',
      { confirmButtonText: '废弃', cancelButtonText: '取消', inputPlaceholder: '请输入废弃理由', type: 'warning' },
    )
    if (!reason) {
      ElMessage.warning('废弃理由不能为空')
      return
    }
    const result = await deprecateRule(row.id, reason)
    if (result.success) {
      ElMessage.success(result.message || '规则已废弃')
      loadRules()
    } else {
      ElMessage.error(result.message || '废弃失败')
    }
  } catch {
    // 用户取消
  }
}

async function handleActivate(row: { id: string; title: string; status: string }): Promise<void> {
  const labelMap: Record<string, string> = { deprecated: '重新激活', voting: '强制激活', candidate: '直接激活' }
  const label = labelMap[row.status] ?? '激活'
  try {
    await ElMessageBox.confirm(
      `确定${label}规则「${row.title}」？`, `${label}确认`,
      { confirmButtonText: label, cancelButtonText: '取消', type: 'warning' },
    )
    const result = await activateRule(row.id)
    if (result.success) {
      ElMessage.success(result.message || '规则已激活')
      loadRules()
    } else {
      ElMessage.error(result.message || '激活失败')
    }
  } catch {
    // 用户取消
  }
}

async function handleStartVoting(row: { id: string; title: string }): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将候选规则「${row.title}」提交投票？`, '提交投票',
      { confirmButtonText: '确认', cancelButtonText: '取消', type: 'info' },
    )
    const result = await voteRule({
      rule_id: row.id,
      user_id: authStore.userId ?? 'anonymous',
      role: 'admin',
      vote: 1,
      comment: '发起投票',
    })
    if (result.success) {
      ElMessage.success('已提交投票')
      loadRules()
    } else {
      ElMessage.error(result.message || '操作失败')
    }
  } catch {
    // 用户取消
  }
}

watch(activeTab, () => { currentPage.value = 1; loadRules() })
watch(currentPage, () => loadRules())
watch(() => projectCtx.selectedProductLine, () => { currentPage.value = 1; loadRules() })
onMounted(() => {
  projectCtx.loadProjects()
  loadRules()
})
</script>

<template>
  <div>
    <el-card>
      <template #header>
        <div class="header">
          <span>规范管理</span>
          <div>
            <el-select
              :model-value="projectCtx.selectedProductLine"
              placeholder="全部产品线"
              clearable
              size="small"
              style="width: 160px; margin-right: 12px"
              @update:model-value="(v: string) => v ? projectCtx.setProductLine(v) : projectCtx.clearFilter()"
            >
              <el-option v-for="pl in projectCtx.productLines" :key="pl" :label="pl" :value="pl" />
            </el-select>
            <el-button type="primary" icon="Plus" @click="openProposeDialog">提议新规则</el-button>
          </div>
        </div>
      </template>

      <div class="filter-bar">
        <el-input
          v-model="searchKeyword"
          placeholder="搜索规则名称..."
          prefix-icon="Search"
          clearable
          style="width: 240px"
          @input="handleSearch"
          @clear="handleSearch"
        />
        <el-select v-model="filterRuleType" placeholder="类型" clearable size="default" style="width: 120px" @change="() => { currentPage = 1; loadRules() }">
          <el-option v-for="opt in ruleTypeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-select v-model="filterCategory" placeholder="分类" clearable size="default" style="width: 120px" @change="() => { currentPage = 1; loadRules() }">
          <el-option v-for="opt in categoryOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-select v-model="filterLanguage" placeholder="语言" clearable size="default" style="width: 120px" @change="() => { currentPage = 1; loadRules() }">
          <el-option v-for="opt in languageOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-select v-model="filterSeverity" placeholder="级别" clearable size="default" style="width: 140px" @change="() => { currentPage = 1; loadRules() }">
          <el-option v-for="opt in severityOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-select v-model="filterSortBy" size="default" style="width: 130px" @change="() => { currentPage = 1; loadRules() }">
          <el-option v-for="opt in sortByOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
      </div>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="生效规则" name="active" />
        <el-tab-pane label="待投票" name="voting" />
        <el-tab-pane label="候选规则" name="candidate" />
        <el-tab-pane label="已废弃" name="deprecated" />
      </el-tabs>

      <el-table v-loading="loading" :data="rules" stripe size="small">
        <el-table-column prop="title" label="规则名称" min-width="200" show-overflow-tooltip />
        <el-table-column label="描述" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <span style="font-size: 12px; color: #909399">{{ truncate(row.description, 50) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="级别" width="80">
          <template #default="{ row }">
            <el-tag :type="getSeverityType(row.severity)" size="small">{{ getSeverityLabel(row.severity) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="分类" width="100">
          <template #default="{ row }">
            <span style="font-size: 12px">{{ getCategoryLabel(row.category) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="80">
          <template #default="{ row }">
            <el-tag :type="getRuleTypeTagType(row.ruleType)" size="small">{{ getRuleTypeLabel(row.ruleType) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="语言" width="90">
          <template #default="{ row }">
            <span style="font-size: 12px">{{ getLanguageLabel(row.language) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="可见范围" width="90">
          <template #default="{ row }">
            <el-tag :type="getVisibilityType(row)" size="small">{{ getVisibilityLabel(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="应用/违反" width="100">
          <template #default="{ row }">
            <span style="color: #67c23a">{{ row.appliedCount }}</span> /
            <span style="color: #f56c6c">{{ row.violatedCount }}</span>
          </template>
        </el-table-column>
        <el-table-column label="创建者" width="120">
          <template #default="{ row }">
            <span style="font-size: 12px; color: #606266">{{ row.createdByName ?? (row.createdBy ? row.createdBy.slice(0, 8) + '…' : '-') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="110">
          <template #default="{ row }">
            <span style="font-size: 12px; color: #909399">{{ formatDate(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="router.push(`/rules/${row.id}`)">详情</el-button>
            <el-button v-if="row.status === 'voting'" text type="success" size="small" @click="openVoteDialog(row)">投票</el-button>
            <el-button v-if="row.status === 'voting'" text type="primary" size="small" @click="handleActivate(row)">强制激活</el-button>
            <el-button v-if="row.status === 'voting'" text type="danger" size="small" @click="handleDeprecate(row)">废弃</el-button>
            <el-button v-if="row.status === 'candidate'" text type="warning" size="small" @click="handleStartVoting(row)">发起投票</el-button>
            <el-button v-if="row.status === 'candidate'" text type="success" size="small" @click="handleActivate(row)">直接激活</el-button>
            <el-button v-if="row.status === 'candidate'" text type="danger" size="small" @click="handleDeprecate(row)">废弃</el-button>
            <el-button v-if="row.status === 'deprecated'" text type="success" size="small" @click="handleActivate(row)">重新激活</el-button>
            <el-button v-if="row.status === 'active'" text type="danger" size="small" @click="handleDeprecate(row)">废弃</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="currentPage"
        style="margin-top: 16px; justify-content: flex-end; display: flex"
        layout="total, prev, pager, next"
        :total="total"
        :page-size="pageSize"
      />
    </el-card>

    <!-- 提议新规则对话框 -->
    <el-dialog v-model="proposeDialogVisible" title="提议新规则" width="700px" destroy-on-close>
      <el-form label-width="100px" label-position="top">
        <el-row :gutter="16">
          <el-col :span="24">
            <el-form-item label="标题" required>
              <el-input v-model="proposeForm.title" placeholder="简洁描述规则要求" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="分类" required>
              <el-select v-model="proposeForm.category" style="width: 100%">
                <el-option v-for="opt in categoryOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="严重级别" required>
              <el-select v-model="proposeForm.severity" style="width: 100%">
                <el-option v-for="opt in severityOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="编程语言">
              <el-input v-model="proposeForm.language" placeholder="如 java/php，留空表示通用" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="可见范围">
              <el-select v-model="proposeForm.visibility" style="width: 100%">
                <el-option label="全局" value="global" />
                <el-option label="产品线" value="product_line" />
                <el-option label="仅当前项目" value="project" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="规则描述" required>
          <el-input v-model="proposeForm.description" type="textarea" :rows="3" placeholder="详细描述此规则的要求" />
        </el-form-item>
        <el-form-item label="为什么需要这条规则">
          <el-input v-model="proposeForm.rationale" type="textarea" :rows="2" placeholder="阐述规则的必要性和背景" />
        </el-form-item>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="正确示例">
              <el-input v-model="proposeForm.example_good" type="textarea" :rows="3" placeholder="符合规则的代码" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="错误示例">
              <el-input v-model="proposeForm.example_bad" type="textarea" :rows="3" placeholder="违反规则的代码" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item>
          <el-checkbox v-model="proposeForm.auto_activate">跳过投票直接激活（需 admin 权限）</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="proposeDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="proposeSubmitting" @click="submitPropose">提交</el-button>
      </template>
    </el-dialog>

    <!-- 投票对话框 -->
    <el-dialog v-model="voteDialogVisible" title="投票" width="450px" destroy-on-close>
      <p style="margin-bottom: 16px; color: #606266">
        对规则「<strong>{{ voteTarget?.title }}</strong>」进行投票
      </p>
      <el-form label-width="80px">
        <el-form-item label="投票">
          <el-radio-group v-model="voteForm.vote">
            <el-radio-button :value="1">赞成 +1</el-radio-button>
            <el-radio-button :value="0">弃权 0</el-radio-button>
            <el-radio-button :value="-1">反对 -1</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="评论">
          <el-input v-model="voteForm.comment" type="textarea" :rows="2" placeholder="可选评论" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="voteDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="voteSubmitting" @click="submitVote">提交投票</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
  align-items: center;
}
</style>
