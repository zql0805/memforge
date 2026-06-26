<script setup lang="ts">
// Created by dev on 2026/04/12
import { ref, computed, onMounted, watch } from 'vue'
import {
  getAgentTasks,
  createAgentTask,
  updateAgentTask,
  batchUpdateTasks,
  type AgentTask,
} from '../api/mcp-tools'
import { useAuthStore } from '../stores/auth'
import { ElMessage, ElMessageBox } from 'element-plus'

const authStore = useAuthStore()

const loading = ref(false)
const loadingMore = ref(false)
const rawTasks = ref<AgentTask[]>([])
const totalFromApi = ref(0)
const hasMore = ref(false)
const offset = ref(0)
const PAGE_SIZE = 100

const viewMode = ref<'table' | 'kanban'>('table')
const detailVisible = ref(false)
const selectedTask = ref<AgentTask | null>(null)
const createVisible = ref(false)
const editVisible = ref(false)
const tableRef = ref()

type StatusKey = 'all' | 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'suspended'
const statusTab = ref<StatusKey>('all')
const categoryFilter = ref<string>('')
const priorityFilter = ref<string>('')
const productLineInput = ref('')
const searchText = ref('')

const selectedRows = ref<AgentTask[]>([])

const CATEGORY_OPTIONS = [
  { value: 'general', label: '通用' },
  { value: 'backend', label: '后端' },
  { value: 'frontend', label: '前端' },
  { value: 'app', label: '应用' },
  { value: 'devops', label: '运维' },
  { value: 'testing', label: '测试' },
  { value: 'analysis', label: '分析' },
  { value: 'docs', label: '文档' },
  { value: 'data', label: '数据' },
] as const

const STATUS_TABS: Array<{ key: StatusKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待处理' },
  { key: 'suspended', label: '挂起' },
  { key: 'in_progress', label: '进行中' },
  { key: 'completed', label: '已完成' },
  { key: 'failed', label: '失败' },
  { key: 'cancelled', label: '已取消' },
]

const STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  suspended: '挂起',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_TAG_TYPE: Record<string, 'success' | 'warning' | 'info' | 'danger' | undefined> = {
  pending: undefined,
  suspended: 'info',
  in_progress: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'info',
}

const PRIORITY_TAG_TYPE: Record<string, 'danger' | 'warning' | 'primary' | 'info'> = {
  P0: 'danger', P1: 'warning', P2: 'primary', P3: 'info',
}
const PRIORITY_COLOR: Record<string, string> = {
  P0: '#F56C6C', P1: '#E6A23C', P2: '#409EFF', P3: '#909399',
}

const EDITABLE_STATUSES = new Set(['pending', 'suspended'])

const serverOptions = ref<{ categories: string[]; product_lines: string[]; projects: string[] }>({
  categories: [], product_lines: [], projects: [],
})

const createForm = ref({
  title: '',
  description: '',
  category: 'general',
  priority: 'P2',
  status: 'pending' as 'pending' | 'suspended',
  product_line: '',
  project: '',
  tags: [] as string[],
  newTag: '',
})

const editForm = ref({
  task_id: 0,
  title: '',
  description: '',
  category: 'general',
  priority: 'P2',
  product_line: '',
  project: '',
  tags: [] as string[],
  newTag: '',
  updated_at: '',
})

const batchPriorityVisible = ref(false)
const batchCategoryVisible = ref(false)
const batchPriorityValue = ref('P2')
const batchCategoryValue = ref('general')
const batchSubmitting = ref(false)

const kanbanColumns: Array<{ status: string; label: string; headerClass: string }> = [
  { status: 'pending', label: '待处理', headerClass: 'kanban-header--pending' },
  { status: 'suspended', label: '挂起', headerClass: 'kanban-header--suspended' },
  { status: 'in_progress', label: '进行中', headerClass: 'kanban-header--active' },
  { status: 'completed', label: '已完成', headerClass: 'kanban-header--done' },
  { status: 'failed', label: '失败', headerClass: 'kanban-header--failed' },
  { status: 'cancelled', label: '已取消', headerClass: 'kanban-header--cancelled' },
]

const tasksAfterApiFilters = computed(() => rawTasks.value)

const displayTasks = computed(() => {
  let list = tasksAfterApiFilters.value
  if (statusTab.value !== 'all') {
    list = list.filter(t => t.status === statusTab.value)
  }
  const q = searchText.value.trim().toLowerCase()
  if (q) {
    list = list.filter(t => {
      const title = (t.title || '').toLowerCase()
      const desc = (t.description || '').toLowerCase()
      return title.includes(q) || desc.includes(q)
    })
  }
  return list
})

const stats = computed(() => {
  const all = tasksAfterApiFilters.value
  return {
    total: all.length,
    pending: all.filter(t => t.status === 'pending').length,
    suspended: all.filter(t => t.status === 'suspended').length,
    in_progress: all.filter(t => t.status === 'in_progress').length,
    completed: all.filter(t => t.status === 'completed').length,
    failed: all.filter(t => t.status === 'failed').length,
    cancelled: all.filter(t => t.status === 'cancelled').length,
  }
})

const dragSourceIdx = ref<number | null>(null)

function tasksForColumn(status: string): AgentTask[] {
  return tasksAfterApiFilters.value.filter(t => t.status === status)
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '-'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '-'
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86400_000)} 天前`
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '-'
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }) } catch { return iso }
}

function getCategoryLabel(cat: string): string {
  return CATEGORY_OPTIONS.find(c => c.value === cat)?.label ?? cat
}

function isEditable(task: AgentTask): boolean {
  return EDITABLE_STATUSES.has(task.status)
}

async function loadTasks(reset = true): Promise<void> {
  if (!authStore.isAuthenticated) return
  if (reset) { loading.value = true; offset.value = 0; rawTasks.value = [] }
  else { loadingMore.value = true }
  try {
    const result = await getAgentTasks({
      category: categoryFilter.value || undefined,
      priority: priorityFilter.value || undefined,
      product_line: productLineInput.value.trim() || undefined,
      limit: PAGE_SIZE,
      offset: offset.value,
      sort_by: 'created_at',
      sort_order: 'desc',
    })
    const chunk = result.tasks ?? []
    if (reset) { rawTasks.value = chunk }
    else {
      const seen = new Set(rawTasks.value.map(t => t.id))
      for (const t of chunk) { if (!seen.has(t.id)) { rawTasks.value.push(t); seen.add(t.id) } }
    }
    totalFromApi.value = result.total ?? rawTasks.value.length
    hasMore.value = Boolean(result.has_more)
    if (selectedTask.value?.id != null && detailVisible.value) {
      const t = rawTasks.value.find(x => x.id === selectedTask.value!.id)
      if (t) selectedTask.value = t
    }
    await loadServerOptions()
  } catch (err) {
    ElMessage.error(`加载任务失败: ${(err as Error).message}`)
  } finally { loading.value = false; loadingMore.value = false }
}

async function loadServerOptions(): Promise<void> {
  try {
    const result = await getAgentTasks({ limit: 0 }) as unknown as Record<string, unknown>
    if (result.options) {
      serverOptions.value = result.options as typeof serverOptions.value
    }
  } catch (e) {
    console.error('加载任务筛选项失败:', e)
  }
}

async function loadMore(): Promise<void> {
  if (!hasMore.value || loadingMore.value) return
  offset.value += PAGE_SIZE
  await loadTasks(false)
}

function openDetail(task: AgentTask): void {
  selectedTask.value = task
  detailVisible.value = true
}

function openCreate(): void {
  if (!authStore.isAuthenticated) { ElMessage.warning('请先连接 Gateway'); return }
  createForm.value = {
    title: '', description: '', category: 'general', priority: 'P2',
    status: 'pending',
    product_line: productLineInput.value.trim(), project: '',
    tags: [], newTag: '',
  }
  createVisible.value = true
}

function openEdit(task: AgentTask): void {
  if (!isEditable(task)) {
    ElMessage.warning(`${STATUS_LABEL[task.status]}状态的任务不可编辑`)
    return
  }
  editForm.value = {
    task_id: task.id,
    title: task.title,
    description: task.description ?? '',
    category: task.category,
    priority: task.priority,
    product_line: task.product_line ?? '',
    project: task.project ?? '',
    tags: [...(task.tags || [])],
    newTag: '',
    updated_at: task.updated_at,
  }
  editVisible.value = true
}

function addTag(form: { tags: string[]; newTag: string }): void {
  const tag = form.newTag.trim()
  if (tag && !form.tags.includes(tag)) form.tags.push(tag)
  form.newTag = ''
}

function removeTag(form: { tags: string[] }, idx: number): void {
  form.tags.splice(idx, 1)
}

const createLoading = ref(false)

async function handleCreate(): Promise<void> {
  if (!createForm.value.title.trim()) { ElMessage.warning('请输入任务标题'); return }
  createLoading.value = true
  try {
    await createAgentTask({
      title: createForm.value.title.trim(),
      description: createForm.value.description.trim() || undefined,
      category: createForm.value.category,
      priority: createForm.value.priority,
      status: createForm.value.status,
      product_line: createForm.value.product_line.trim() || undefined,
      project: createForm.value.project.trim() || undefined,
      tags: createForm.value.tags.length ? createForm.value.tags : undefined,
    })
    createVisible.value = false
    ElMessage.success('任务已创建')
    await loadTasks(true)
  } catch (err) { ElMessage.error(`创建失败: ${(err as Error).message}`) }
  finally { createLoading.value = false }
}

const editLoading = ref(false)

async function handleEdit(): Promise<void> {
  if (!editForm.value.title.trim()) { ElMessage.warning('请输入任务标题'); return }
  editLoading.value = true
  try {
    await updateAgentTask({
      task_id: editForm.value.task_id,
      title: editForm.value.title.trim(),
      description: editForm.value.description.trim(),
      category: editForm.value.category,
      priority: editForm.value.priority,
      product_line: editForm.value.product_line.trim() || undefined,
      project: editForm.value.project.trim() || undefined,
      tags: editForm.value.tags,
      expected_updated_at: editForm.value.updated_at,
    })
    editVisible.value = false
    ElMessage.success('任务已更新')
    await loadTasks(true)
  } catch (err) {
    const msg = (err as Error).message
    if (msg.includes('并发冲突')) {
      ElMessage.error('保存失败：任务已被其他操作修改，请刷新后重试')
      await loadTasks(true)
    } else if (msg.includes('不允许编辑')) {
      ElMessage.error('保存失败：当前状态不允许编辑内容')
    } else {
      ElMessage.error(`保存失败: ${msg}`)
    }
  } finally { editLoading.value = false }
}

const actionLoadingId = ref<number | null>(null)

async function setTaskStatus(task: AgentTask, status: string, confirmMsg?: string): Promise<void> {
  if (confirmMsg) {
    try { await ElMessageBox.confirm(confirmMsg, '确认', { type: 'warning' }) } catch { return }
  }
  actionLoadingId.value = task.id
  try {
    await updateAgentTask({ task_id: task.id, status })
    ElMessage.success('已更新')
    await loadTasks(true)
  } catch (err) { ElMessage.error(`操作失败: ${(err as Error).message}`) }
  finally { actionLoadingId.value = null }
}

function handleSelectionChange(rows: AgentTask[]): void { selectedRows.value = rows }
function clearSelection(): void { tableRef.value?.clearSelection?.(); selectedRows.value = [] }

async function batchCancel(): Promise<void> {
  const ids = selectedRows.value.map(t => t.id)
  if (!ids.length) return
  try { await ElMessageBox.confirm(`确定将选中的 ${ids.length} 个任务取消吗？`, '批量取消', { type: 'warning' }) } catch { return }
  batchSubmitting.value = true
  try {
    await batchUpdateTasks({ task_ids: ids, updates: { status: 'cancelled' } })
    ElMessage.success('已批量取消'); clearSelection(); await loadTasks(true)
  } catch (err) { ElMessage.error(`批量操作失败: ${(err as Error).message}`) }
  finally { batchSubmitting.value = false }
}

function openBatchPriority(): void { batchPriorityValue.value = 'P2'; batchPriorityVisible.value = true }
function openBatchCategory(): void { batchCategoryValue.value = 'general'; batchCategoryVisible.value = true }

async function submitBatchPriority(): Promise<void> {
  const ids = selectedRows.value.map(t => t.id); if (!ids.length) return
  batchSubmitting.value = true
  try {
    await batchUpdateTasks({ task_ids: ids, updates: { priority: batchPriorityValue.value } })
    batchPriorityVisible.value = false; ElMessage.success('优先级已更新'); clearSelection(); await loadTasks(true)
  } catch (err) { ElMessage.error(`批量操作失败: ${(err as Error).message}`) }
  finally { batchSubmitting.value = false }
}

async function submitBatchCategory(): Promise<void> {
  const ids = selectedRows.value.map(t => t.id); if (!ids.length) return
  batchSubmitting.value = true
  try {
    await batchUpdateTasks({ task_ids: ids, updates: { category: batchCategoryValue.value } })
    batchCategoryVisible.value = false; ElMessage.success('分类已更新'); clearSelection(); await loadTasks(true)
  } catch (err) { ElMessage.error(`批量操作失败: ${(err as Error).message}`) }
  finally { batchSubmitting.value = false }
}

function applyFilters(): void { loadTasks(true) }

let debounceTimer: ReturnType<typeof setTimeout> | null = null
function scheduleReload(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => { debounceTimer = null; loadTasks(true) }, 400)
}

watch([categoryFilter, priorityFilter], () => { scheduleReload() })
onMounted(() => { loadTasks(true) })

function onDragStart(idx: number): void { dragSourceIdx.value = idx }
function onDragOver(e: DragEvent): void { e.preventDefault() }
async function onDrop(targetIdx: number): Promise<void> {
  if (dragSourceIdx.value === null || dragSourceIdx.value === targetIdx) { dragSourceIdx.value = null; return }
  const pendingTasks = displayTasks.value.filter(t => t.status === 'pending' || t.status === 'suspended')
  const src = dragSourceIdx.value
  const item = pendingTasks[src]
  if (!item || !isEditable(item)) { dragSourceIdx.value = null; return }
  pendingTasks.splice(src, 1)
  pendingTasks.splice(targetIdx, 0, item)
  const ids = pendingTasks.map(t => t.id)
  dragSourceIdx.value = null
  try {
    for (let i = 0; i < ids.length; i++) {
      await updateAgentTask({ task_id: ids[i], sort_order: i })
    }
    await loadTasks(true)
  } catch (err) { ElMessage.error(`排序失败: ${(err as Error).message}`) }
}

function allProductLineOptions(): string[] {
  const set = new Set<string>(serverOptions.value.product_lines)
  for (const t of rawTasks.value) { if (t.product_line) set.add(t.product_line) }
  return [...set].sort()
}

function allProjectOptions(): string[] {
  const set = new Set<string>(serverOptions.value.projects)
  for (const t of rawTasks.value) { if (t.project) set.add(t.project) }
  return [...set].sort()
}
</script>

<template>
  <div class="tasks-page">
    <!-- 统计 -->
    <el-row :gutter="16" class="stats-row">
      <el-col :xs="12" :sm="8" :md="3">
        <el-card shadow="never" body-style="padding: 16px"><el-statistic title="总计" :value="stats.total"><template #suffix>个</template></el-statistic></el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="3">
        <el-card shadow="never" body-style="padding: 16px"><el-statistic title="待处理" :value="stats.pending"><template #suffix>个</template></el-statistic></el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="3">
        <el-card shadow="never" body-style="padding: 16px"><el-statistic title="挂起" :value="stats.suspended"><template #suffix>个</template></el-statistic></el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="3">
        <el-card shadow="never" body-style="padding: 16px"><el-statistic title="进行中" :value="stats.in_progress"><template #suffix>个</template></el-statistic></el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="3">
        <el-card shadow="never" body-style="padding: 16px"><el-statistic title="已完成" :value="stats.completed"><template #suffix>个</template></el-statistic></el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="3">
        <el-card shadow="never" body-style="padding: 16px"><el-statistic title="失败" :value="stats.failed"><template #suffix>个</template></el-statistic></el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="3">
        <el-card shadow="never" body-style="padding: 16px"><el-statistic title="已取消" :value="stats.cancelled"><template #suffix>个</template></el-statistic></el-card>
      </el-col>
    </el-row>

    <!-- 工具栏 + 筛选 -->
    <el-card shadow="never" class="toolbar-card" body-style="padding: 12px 16px">
      <div class="toolbar-row">
        <el-button type="primary" icon="Plus" @click="openCreate">创建任务</el-button>
        <el-button icon="Refresh" :loading="loading" @click="loadTasks(true)">刷新</el-button>
        <el-divider direction="vertical" />
        <el-radio-group v-model="viewMode" size="small">
          <el-radio-button value="table">列表</el-radio-button>
          <el-radio-button value="kanban">看板</el-radio-button>
        </el-radio-group>
        <div class="toolbar-spacer" />
        <el-select v-model="productLineInput" placeholder="产品线" clearable filterable allow-create style="width: 160px" @change="applyFilters">
          <el-option v-for="pl in allProductLineOptions()" :key="pl" :label="pl" :value="pl" />
        </el-select>
      </div>
      <div class="filter-row">
        <el-radio-group v-model="statusTab" size="small" class="status-tabs">
          <el-radio-button v-for="tab in STATUS_TABS" :key="tab.key" :value="tab.key">
            {{ tab.label }}
          </el-radio-button>
        </el-radio-group>
      </div>
      <div class="filter-row filter-row--second">
        <el-select v-model="categoryFilter" placeholder="全部分类" clearable style="width: 140px" @change="applyFilters">
          <el-option v-for="c in CATEGORY_OPTIONS" :key="c.value" :label="c.label" :value="c.value" />
        </el-select>
        <el-select v-model="priorityFilter" placeholder="全部优先级" clearable style="width: 140px" @change="applyFilters">
          <el-option label="P0" value="P0" /><el-option label="P1" value="P1" />
          <el-option label="P2" value="P2" /><el-option label="P3" value="P3" />
        </el-select>
        <el-input v-model="searchText" placeholder="搜索标题或描述" clearable style="width: 220px; max-width: 100%" />
      </div>
    </el-card>

    <!-- 批量操作条 -->
      <el-card v-if="selectedRows.length > 0" shadow="never" class="batch-bar" body-style="padding: 10px 16px">
        <div class="batch-inner">
          <span>已选 <strong>{{ selectedRows.length }}</strong> 项</span>
          <el-button size="small" type="warning" :loading="batchSubmitting" @click="batchCancel">批量取消</el-button>
          <el-button size="small" type="primary" :loading="batchSubmitting" @click="openBatchPriority">批量改优先级</el-button>
          <el-button size="small" type="primary" plain :loading="batchSubmitting" @click="openBatchCategory">批量改分类</el-button>
          <el-button size="small" text @click="clearSelection">清除选择</el-button>
        </div>
      </el-card>

    <!-- 看板 -->
    <div v-if="viewMode === 'kanban'" v-loading="loading" class="kanban-container">
      <div v-for="col in kanbanColumns" :key="col.status" class="kanban-column">
        <div class="kanban-header" :class="col.headerClass">
          {{ col.label }}
          <el-badge :value="tasksForColumn(col.status).length" :type="col.status === 'failed' ? 'danger' : 'primary'" />
        </div>
        <div class="kanban-body">
          <div
            v-for="task in tasksForColumn(col.status)"
            :key="task.id"
            class="kanban-card"
            @click="openDetail(task)"
          >
            <div class="kanban-card__header">
              <el-tag size="small" :type="PRIORITY_TAG_TYPE[task.priority]" effect="plain">{{ task.priority }}</el-tag>
              <el-tag size="small" effect="plain">{{ getCategoryLabel(task.category) }}</el-tag>
            </div>
            <div class="kanban-card__title">{{ task.title }}</div>
            <div class="kanban-card__meta">
              <span>{{ formatRelativeTime(task.created_at) }}</span>
              <span v-if="task.product_line" class="ml-8">{{ task.product_line }}</span>
            </div>
          </div>
          <el-empty v-if="tasksForColumn(col.status).length === 0" description="暂无" :image-size="48" />
        </div>
      </div>
    </div>

    <!-- 表格 -->
    <el-card v-if="viewMode === 'table'" v-loading="loading" shadow="never" class="table-card">
      <el-table
        ref="tableRef"
        :data="displayTasks"
        stripe
        size="small"
        row-key="id"
        empty-text="暂无任务"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="42" reserve-selection />
        <el-table-column label="排序" width="56" align="center" v-if="statusTab === 'pending' || statusTab === 'suspended'">
          <template #default="{ $index }">
            <span
              class="drag-handle"
              draggable="true"
              @dragstart="onDragStart($index)"
              @dragover="onDragOver"
              @drop="onDrop($index)"
              title="拖拽排序"
            >⋮⋮</span>
          </template>
        </el-table-column>
        <el-table-column label="优先级" width="88" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="PRIORITY_TAG_TYPE[row.priority]" :style="{ borderColor: PRIORITY_COLOR[row.priority], color: PRIORITY_COLOR[row.priority] }" effect="plain">{{ row.priority }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="标题" min-width="200">
          <template #default="{ row }">
            <el-link type="primary" @click="openDetail(row)">{{ row.title }}</el-link>
          </template>
        </el-table-column>
        <el-table-column label="分类" width="100" align="center">
          <template #default="{ row }"><el-tag size="small" effect="plain">{{ getCategoryLabel(row.category) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }"><el-tag size="small" :type="STATUS_TAG_TYPE[row.status]">{{ STATUS_LABEL[row.status] ?? row.status }}</el-tag></template>
        </el-table-column>
        <el-table-column label="产品线" width="120" show-overflow-tooltip>
          <template #default="{ row }">{{ row.product_line || '-' }}</template>
        </el-table-column>
        <el-table-column label="创建时间" width="110" align="center">
          <template #default="{ row }">{{ formatRelativeTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="240" align="center" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 'pending'">
              <el-button size="small" text type="primary" :loading="actionLoadingId === row.id" @click.stop="setTaskStatus(row, 'in_progress')">开始</el-button>
              <el-button size="small" text type="info" :loading="actionLoadingId === row.id" @click.stop="setTaskStatus(row, 'suspended')">挂起</el-button>
              <el-button size="small" text @click.stop="openEdit(row)">编辑</el-button>
              <el-button size="small" text type="info" :loading="actionLoadingId === row.id" @click.stop="setTaskStatus(row, 'cancelled', '确定取消？')">取消</el-button>
            </template>
            <template v-else-if="row.status === 'suspended'">
              <el-button size="small" text type="primary" :loading="actionLoadingId === row.id" @click.stop="setTaskStatus(row, 'pending')">恢复</el-button>
              <el-button size="small" text type="primary" :loading="actionLoadingId === row.id" @click.stop="setTaskStatus(row, 'in_progress')">开始</el-button>
              <el-button size="small" text @click.stop="openEdit(row)">编辑</el-button>
              <el-button size="small" text type="info" :loading="actionLoadingId === row.id" @click.stop="setTaskStatus(row, 'cancelled', '确定取消？')">取消</el-button>
            </template>
            <template v-else-if="row.status === 'in_progress'">
              <el-button size="small" text type="success" :loading="actionLoadingId === row.id" @click.stop="setTaskStatus(row, 'completed')">完成</el-button>
              <el-button size="small" text type="danger" :loading="actionLoadingId === row.id" @click.stop="setTaskStatus(row, 'failed', '标记为失败？')">失败</el-button>
              <el-button size="small" text type="info" :loading="actionLoadingId === row.id" @click.stop="setTaskStatus(row, 'cancelled', '确定取消？')">取消</el-button>
            </template>
            <template v-else-if="row.status === 'failed'">
              <el-button size="small" text type="primary" :loading="actionLoadingId === row.id" @click.stop="setTaskStatus(row, 'in_progress')">重试</el-button>
              <el-button size="small" text :loading="actionLoadingId === row.id" @click.stop="setTaskStatus(row, 'pending')">重开</el-button>
            </template>
            <template v-else-if="row.status === 'completed'">
              <el-button size="small" text :loading="actionLoadingId === row.id" @click.stop="setTaskStatus(row, 'pending', '确定重新打开？')">重开</el-button>
            </template>
            <template v-else-if="row.status === 'cancelled'">
              <el-button size="small" text :loading="actionLoadingId === row.id" @click.stop="setTaskStatus(row, 'pending')">恢复</el-button>
            </template>
            <span v-else class="text-muted">—</span>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="hasMore" class="load-more-wrap">
        <el-button :loading="loadingMore" @click="loadMore">加载更多（{{ rawTasks.length }} / {{ totalFromApi }}）</el-button>
      </div>
    </el-card>

    <!-- 详情抽屉 -->
    <el-drawer v-model="detailVisible" size="640px" destroy-on-close :title="selectedTask?.title ?? '任务详情'">
      <template v-if="selectedTask">
        <el-descriptions :column="2" border size="small" class="detail-block">
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="STATUS_TAG_TYPE[selectedTask.status]">{{ STATUS_LABEL[selectedTask.status] ?? selectedTask.status }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="优先级">
            <el-tag size="small" :type="PRIORITY_TAG_TYPE[selectedTask.priority]">{{ selectedTask.priority }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="分类">{{ getCategoryLabel(selectedTask.category) }}</el-descriptions-item>
          <el-descriptions-item label="产品线">{{ selectedTask.product_line || '-' }}</el-descriptions-item>
          <el-descriptions-item label="项目">{{ selectedTask.project || '-' }}</el-descriptions-item>
          <el-descriptions-item label="创建者">{{ selectedTask.created_by }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ formatDateTime(selectedTask.created_at) }}</el-descriptions-item>
          <el-descriptions-item label="更新时间">{{ formatDateTime(selectedTask.updated_at) }}</el-descriptions-item>
          <el-descriptions-item label="开始时间">{{ formatDateTime(selectedTask.started_at) }}</el-descriptions-item>
          <el-descriptions-item label="完成时间">{{ formatDateTime(selectedTask.completed_at) }}</el-descriptions-item>
          <el-descriptions-item label="会话 ID" :span="2">{{ selectedTask.conversation_id || '-' }}</el-descriptions-item>
          <el-descriptions-item label="历史文件" :span="2"><span class="mono">{{ selectedTask.history_file_path || '-' }}</span></el-descriptions-item>
        </el-descriptions>

        <h4 class="section-title">标签</h4>
        <div v-if="selectedTask.tags?.length" class="tag-list">
          <el-tag v-for="(t, i) in selectedTask.tags" :key="i" size="small" style="margin: 2px">{{ t }}</el-tag>
        </div>
        <el-empty v-else description="无标签" :image-size="40" />

        <h4 class="section-title">描述</h4>
        <div class="pre-md">{{ selectedTask.description || '（无）' }}</div>

        <h4 class="section-title">执行摘要</h4>
        <div class="pre-md">{{ selectedTask.execution_summary || '（无）' }}</div>

        <h4 class="section-title">执行问题</h4>
        <div class="pre-md">{{ selectedTask.execution_issues || '（无）' }}</div>

        <h4 class="section-title">关联项</h4>
        <el-table v-if="selectedTask.related_items?.length" :data="selectedTask.related_items" size="small" stripe border>
          <el-table-column prop="type" label="类型" width="100" />
          <el-table-column prop="title" label="标题" min-width="120" show-overflow-tooltip />
          <el-table-column prop="id" label="ID" width="100" show-overflow-tooltip />
          <el-table-column prop="path" label="路径" min-width="140" show-overflow-tooltip />
        </el-table>
        <el-empty v-else description="无关联项" :image-size="40" />

        <div class="drawer-actions">
          <el-button v-if="isEditable(selectedTask)" type="primary" plain @click="openEdit(selectedTask); detailVisible = false">编辑</el-button>
          <template v-if="selectedTask.status === 'pending'">
            <el-button type="primary" :loading="actionLoadingId === selectedTask.id" @click="setTaskStatus(selectedTask, 'in_progress')">开始</el-button>
            <el-button :loading="actionLoadingId === selectedTask.id" @click="setTaskStatus(selectedTask, 'suspended')">挂起</el-button>
            <el-button :loading="actionLoadingId === selectedTask.id" @click="setTaskStatus(selectedTask, 'cancelled', '确定取消？')">取消</el-button>
          </template>
          <template v-else-if="selectedTask.status === 'suspended'">
            <el-button type="primary" :loading="actionLoadingId === selectedTask.id" @click="setTaskStatus(selectedTask, 'pending')">恢复</el-button>
            <el-button type="primary" :loading="actionLoadingId === selectedTask.id" @click="setTaskStatus(selectedTask, 'in_progress')">开始</el-button>
            <el-button :loading="actionLoadingId === selectedTask.id" @click="setTaskStatus(selectedTask, 'cancelled', '确定取消？')">取消</el-button>
          </template>
          <template v-else-if="selectedTask.status === 'in_progress'">
            <el-button type="success" :loading="actionLoadingId === selectedTask.id" @click="setTaskStatus(selectedTask, 'completed')">完成</el-button>
            <el-button type="danger" plain :loading="actionLoadingId === selectedTask.id" @click="setTaskStatus(selectedTask, 'failed', '标记为失败？')">失败</el-button>
            <el-button :loading="actionLoadingId === selectedTask.id" @click="setTaskStatus(selectedTask, 'cancelled', '确定取消？')">取消</el-button>
          </template>
          <template v-else-if="selectedTask.status === 'failed'">
            <el-button type="primary" :loading="actionLoadingId === selectedTask.id" @click="setTaskStatus(selectedTask, 'in_progress')">重新开始</el-button>
            <el-button :loading="actionLoadingId === selectedTask.id" @click="setTaskStatus(selectedTask, 'pending')">重开</el-button>
          </template>
          <template v-else-if="selectedTask.status === 'completed'">
            <el-button :loading="actionLoadingId === selectedTask.id" @click="setTaskStatus(selectedTask, 'pending', '确定重新打开？')">重开</el-button>
          </template>
          <template v-else-if="selectedTask.status === 'cancelled'">
            <el-button type="primary" :loading="actionLoadingId === selectedTask.id" @click="setTaskStatus(selectedTask, 'pending')">恢复</el-button>
          </template>
        </div>
      </template>
    </el-drawer>

    <!-- 新建 -->
    <el-dialog v-model="createVisible" title="创建任务" width="600px" destroy-on-close>
      <el-form :model="createForm" label-width="96px" size="default">
        <el-form-item label="标题" required>
          <el-input v-model="createForm.title" placeholder="任务标题" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="createForm.description" type="textarea" :rows="4" placeholder="任务描述" />
        </el-form-item>
        <el-form-item label="初始状态">
          <el-radio-group v-model="createForm.status">
            <el-radio value="pending">待处理</el-radio>
            <el-radio value="suspended">挂起</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="createForm.category" style="width: 100%">
            <el-option v-for="c in CATEGORY_OPTIONS" :key="c.value" :label="c.label" :value="c.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="优先级">
          <el-select v-model="createForm.priority" style="width: 100%">
            <el-option label="P0" value="P0" /><el-option label="P1" value="P1" />
            <el-option label="P2" value="P2" /><el-option label="P3" value="P3" />
          </el-select>
        </el-form-item>
        <el-form-item label="产品线">
          <el-select v-model="createForm.product_line" filterable allow-create clearable placeholder="可选" style="width: 100%">
            <el-option v-for="pl in allProductLineOptions()" :key="pl" :label="pl" :value="pl" />
          </el-select>
        </el-form-item>
        <el-form-item label="项目">
          <el-select v-model="createForm.project" filterable allow-create clearable placeholder="可选" style="width: 100%">
            <el-option v-for="p in allProjectOptions()" :key="p" :label="p" :value="p" />
          </el-select>
        </el-form-item>
        <el-form-item label="标签">
          <div class="tag-editor">
            <el-tag v-for="(t, i) in createForm.tags" :key="i" closable class="tag-item" @close="removeTag(createForm, i)">{{ t }}</el-tag>
            <div class="tag-input-row">
              <el-input v-model="createForm.newTag" placeholder="输入后回车" style="flex: 1" @keyup.enter="addTag(createForm)" />
              <el-button icon="Plus" @click="addTag(createForm)" />
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="createLoading" @click="handleCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 编辑 -->
    <el-dialog v-model="editVisible" title="编辑任务" width="600px" destroy-on-close>
      <el-form :model="editForm" label-width="96px" size="default">
        <el-form-item label="标题" required>
          <el-input v-model="editForm.title" placeholder="任务标题" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="editForm.description" type="textarea" :rows="4" placeholder="任务描述" />
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="editForm.category" style="width: 100%">
            <el-option v-for="c in CATEGORY_OPTIONS" :key="c.value" :label="c.label" :value="c.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="优先级">
          <el-select v-model="editForm.priority" style="width: 100%">
            <el-option label="P0" value="P0" /><el-option label="P1" value="P1" />
            <el-option label="P2" value="P2" /><el-option label="P3" value="P3" />
          </el-select>
        </el-form-item>
        <el-form-item label="产品线">
          <el-select v-model="editForm.product_line" filterable allow-create clearable placeholder="可选" style="width: 100%">
            <el-option v-for="pl in allProductLineOptions()" :key="pl" :label="pl" :value="pl" />
          </el-select>
        </el-form-item>
        <el-form-item label="项目">
          <el-select v-model="editForm.project" filterable allow-create clearable placeholder="可选" style="width: 100%">
            <el-option v-for="p in allProjectOptions()" :key="p" :label="p" :value="p" />
          </el-select>
        </el-form-item>
        <el-form-item label="标签">
          <div class="tag-editor">
            <el-tag v-for="(t, i) in editForm.tags" :key="i" closable class="tag-item" @close="removeTag(editForm, i)">{{ t }}</el-tag>
            <div class="tag-input-row">
              <el-input v-model="editForm.newTag" placeholder="输入后回车" style="flex: 1" @keyup.enter="addTag(editForm)" />
              <el-button icon="Plus" @click="addTag(editForm)" />
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="editLoading" @click="handleEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 批量优先级 -->
    <el-dialog v-model="batchPriorityVisible" title="批量修改优先级" width="400px">
      <el-select v-model="batchPriorityValue" style="width: 100%">
        <el-option label="P0" value="P0" /><el-option label="P1" value="P1" />
        <el-option label="P2" value="P2" /><el-option label="P3" value="P3" />
      </el-select>
      <template #footer>
        <el-button @click="batchPriorityVisible = false">关闭</el-button>
        <el-button type="primary" :loading="batchSubmitting" @click="submitBatchPriority">确定</el-button>
      </template>
    </el-dialog>

    <!-- 批量分类 -->
    <el-dialog v-model="batchCategoryVisible" title="批量修改分类" width="400px">
      <el-select v-model="batchCategoryValue" style="width: 100%">
        <el-option v-for="c in CATEGORY_OPTIONS" :key="c.value" :label="c.label" :value="c.value" />
      </el-select>
      <template #footer>
        <el-button @click="batchCategoryVisible = false">关闭</el-button>
        <el-button type="primary" :loading="batchSubmitting" @click="submitBatchCategory">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.tasks-page { padding-bottom: 24px; }
.stats-row { margin-bottom: 16px; }
.stats-row .el-col { margin-bottom: 12px; }
.toolbar-card { margin-bottom: 16px; }
.toolbar-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.toolbar-spacer { flex: 1; min-width: 8px; }
.filter-row { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.filter-row--second { margin-top: 10px; }
.status-tabs { flex-wrap: wrap; }
.tab-badge { margin-left: 4px; vertical-align: middle; }
.batch-bar { margin-bottom: 12px; border: 1px solid var(--el-color-primary-light-5); }
.batch-inner { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.table-card { min-height: 200px; }
.text-muted { color: var(--el-text-color-placeholder); }
.load-more-wrap { padding: 12px; text-align: center; }
.ml-8 { margin-left: 8px; }
.drag-handle { cursor: grab; color: var(--mf-text-muted, #5a6170); font-size: 14px; user-select: none; letter-spacing: -2px; }
.drag-handle:active { cursor: grabbing; }

.kanban-container { display: flex; gap: 16px; min-height: 480px; overflow-x: auto; padding-bottom: 8px; }
.kanban-column { flex: 1; min-width: 220px; background: var(--mf-bg-base, #24282e); border-radius: 8px; border: 1px solid var(--mf-border, rgba(255,255,255,0.08)); display: flex; flex-direction: column; overflow: hidden; }
.kanban-header { padding: 12px 16px; font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; border-bottom: 2px solid transparent; }
.kanban-header--pending { border-bottom-color: var(--mf-text-muted, #5a6170); color: var(--mf-text-secondary, #8e949e); }
.kanban-header--suspended { border-bottom-color: var(--mf-accent, #8b6fc0); color: var(--mf-accent, #8b6fc0); }
.kanban-header--active { border-bottom-color: var(--mf-warning, #e5a84b); color: var(--mf-warning, #e5a84b); }
.kanban-header--done { border-bottom-color: var(--mf-success, #6bc77a); color: var(--mf-success, #6bc77a); }
.kanban-header--failed { border-bottom-color: var(--mf-danger, #e06060); color: var(--mf-danger, #e06060); }
.kanban-header--cancelled { border-bottom-color: var(--mf-text-muted, #5a6170); color: var(--mf-text-muted, #5a6170); }
.kanban-body { flex: 1; padding: 12px; overflow-y: auto; max-height: 70vh; }
.kanban-card { padding: 12px; margin-bottom: 10px; border: 1px solid var(--mf-border, rgba(255,255,255,0.08)); border-radius: 6px; cursor: pointer; background: var(--mf-bg-elevated, #2a2f36); }
.kanban-card:hover { border-color: var(--mf-border-active, rgba(91,155,213,0.25)); }
.kanban-card__header { display: flex; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
.kanban-card__title { font-size: 14px; font-weight: 500; line-height: 1.4; margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.kanban-card__meta { font-size: 12px; color: var(--mf-text-muted, #5a6170); }

.detail-block { margin-bottom: 16px; }
.section-title { margin: 16px 0 8px; font-size: 14px; font-weight: 600; }
.tag-list { margin-bottom: 8px; }
.pre-md { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.6; padding: 12px; background: var(--el-fill-color-light); border-radius: 6px; border: 1px solid var(--el-border-color-lighter); margin-bottom: 8px; }
.mono { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; }
.drawer-actions { margin-top: 20px; display: flex; flex-wrap: wrap; gap: 8px; }
.tag-editor { width: 100%; }
.tag-item { margin: 2px 6px 6px 0; }
.tag-input-row { display: flex; gap: 8px; margin-top: 4px; }
</style>
