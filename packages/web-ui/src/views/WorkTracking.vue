<script setup lang="ts">
// Created by dev on 2026/04/05
import { ref, computed, onMounted } from 'vue'
import {
  listWorkContexts,
  startWorkContext,
  updateWorkContext,
  evaluateWorkContext,
  type WorkContextEntry,
  type WorkContextMetadata,
  type WorkContextProject,
  type StartWorkContextResult,
} from '../api/mcp-tools'
import { useAuthStore } from '../stores/auth'
import { useProjectContext } from '../stores/project-context'
import { ElMessage, ElMessageBox } from 'element-plus'

const authStore = useAuthStore()
const projectCtx = useProjectContext()

const loading = ref(false)
const allContexts = ref<WorkContextEntry[]>([])
const currentPage = ref(1)
const pageSize = ref(50)
const totalCount = ref(0)

const viewMode = ref<'kanban' | 'table'>('kanban')
const detailVisible = ref(false)
const selectedContext = ref<WorkContextEntry | null>(null)
const createVisible = ref(false)

const createForm = ref({
  title: '',
  type: 'requirement' as string,
  description: '',
  priority: 'P1' as string,
  estimated_hours: undefined as number | undefined,
  projects: [] as Array<{ name: string; branch: string }>,
  related_doc_urls: [] as string[],
  tags: [] as string[],
  newProjectName: '',
  newProjectBranch: '',
  newDocUrl: '',
  newTag: '',
})

const updateNoteVisible = ref(false)
const updateNoteForm = ref({ contextId: '', note: '' })

const evaluateVisible = ref(false)
const evaluateForm = ref({
  contextId: '',
  outcome: 'completed' as 'completed' | 'cancelled' | 'deferred',
  summary: '',
  lessons: [] as string[],
  newLesson: '',
})

// 分组
const inProgressContexts = computed(() =>
  allContexts.value.filter(c => getMeta(c).status === 'in_progress'),
)
const completedContexts = computed(() =>
  allContexts.value.filter(c => getMeta(c).status === 'completed'),
)
const otherContexts = computed(() =>
  allContexts.value.filter(c => !['in_progress', 'completed'].includes(getMeta(c).status)),
)

// 统计
const stats = computed(() => {
  const all = allContexts.value
  const active = inProgressContexts.value.length
  const done = completedContexts.value.length
  const totalFiles = all.reduce((s, c) => {
    const ev = getMeta(c).evaluation
    return s + (ev?.total_files_changed ?? sumProjectStat(getMeta(c).projects, 'files_changed'))
  }, 0)
  const totalHours = completedContexts.value.reduce((s, c) => {
    return s + (getMeta(c).evaluation?.duration_hours ?? 0)
  }, 0)
  return { active, done, total: all.length, totalFiles, totalHours: Math.round(totalHours * 10) / 10 }
})

function getMeta(ctx: WorkContextEntry): WorkContextMetadata {
  return ctx.metadata as WorkContextMetadata
}

function sumProjectStat(projects: WorkContextProject[], key: keyof WorkContextProject): number {
  return projects?.reduce((s, p) => s + (Number(p[key]) || 0), 0) ?? 0
}

async function loadContexts(): Promise<void> {
  if (!authStore.isAuthenticated) return
  loading.value = true
  try {
    const result = await listWorkContexts({
      page: currentPage.value,
      page_size: pageSize.value,
      product_line: projectCtx.selectedProductLine || undefined,
      cross_project: true,
    })
    allContexts.value = (result.entries ?? []).filter(
      e => (e.metadata as Record<string, unknown>)?.type === 'work_context',
    ) as unknown as WorkContextEntry[]
    totalCount.value = result.pagination?.total ?? 0
  } catch (err) {
    ElMessage.error(`加载工作上下文失败: ${(err as Error).message}`)
  } finally {
    loading.value = false
  }
}

function openDetail(ctx: WorkContextEntry): void {
  selectedContext.value = ctx
  detailVisible.value = true
}

function openCreate(): void {
  if (!authStore.isAuthenticated) {
    ElMessage.warning('请先连接 Gateway')
    return
  }
  createForm.value = {
    title: '', type: 'requirement', description: '', priority: 'P1',
    estimated_hours: undefined, projects: [], related_doc_urls: [], tags: [],
    newProjectName: '', newProjectBranch: '', newDocUrl: '', newTag: '',
  }
  createVisible.value = true
}

function addProjectToForm(): void {
  const name = createForm.value.newProjectName.trim()
  if (!name) return
  createForm.value.projects.push({ name, branch: createForm.value.newProjectBranch.trim() })
  createForm.value.newProjectName = ''
  createForm.value.newProjectBranch = ''
}

function removeProjectFromForm(idx: number): void {
  createForm.value.projects.splice(idx, 1)
}

function addDocToForm(): void {
  const url = createForm.value.newDocUrl.trim()
  if (!url) return
  createForm.value.related_doc_urls.push(url)
  createForm.value.newDocUrl = ''
}

function removeDocFromForm(idx: number): void {
  createForm.value.related_doc_urls.splice(idx, 1)
}

function addTagToForm(): void {
  const tag = createForm.value.newTag.trim()
  if (!tag) return
  createForm.value.tags.push(tag)
  createForm.value.newTag = ''
}

function removeTagFromForm(idx: number): void {
  createForm.value.tags.splice(idx, 1)
}

const createLoading = ref(false)

async function handleCreate(): Promise<void> {
  if (!createForm.value.title.trim()) {
    ElMessage.warning('请输入工作标题')
    return
  }
  createLoading.value = true
  try {
    const result: StartWorkContextResult = await startWorkContext({
      title: createForm.value.title,
      type: createForm.value.type,
      description: createForm.value.description || undefined,
      priority: createForm.value.priority || undefined,
      estimated_hours: createForm.value.estimated_hours,
      projects: createForm.value.projects.length > 0 ? createForm.value.projects : undefined,
      related_doc_urls: createForm.value.related_doc_urls.length > 0 ? createForm.value.related_doc_urls : undefined,
      tags: createForm.value.tags.length > 0 ? createForm.value.tags : undefined,
      product_line: projectCtx.selectedProductLine || undefined,
    })
    createVisible.value = false
    ElMessage.success(result.message)
    await loadContexts()
  } catch (err) {
    ElMessage.error(`创建失败: ${(err as Error).message}`)
  } finally {
    createLoading.value = false
  }
}

function openUpdateNote(ctx: WorkContextEntry): void {
  updateNoteForm.value = { contextId: ctx.id, note: '' }
  updateNoteVisible.value = true
}

const updateLoading = ref(false)

async function handleUpdateNote(): Promise<void> {
  if (!updateNoteForm.value.note.trim()) {
    ElMessage.warning('请输入进度备注')
    return
  }
  updateLoading.value = true
  try {
    await updateWorkContext({
      context_id: updateNoteForm.value.contextId,
      progress_note: updateNoteForm.value.note,
    })
    updateNoteVisible.value = false
    ElMessage.success('进度已更新')
    await loadContexts()
  } catch (err) {
    ElMessage.error(`更新失败: ${(err as Error).message}`)
  } finally {
    updateLoading.value = false
  }
}

function openEvaluate(ctx: WorkContextEntry): void {
  evaluateForm.value = {
    contextId: ctx.id, outcome: 'completed', summary: '', lessons: [], newLesson: '',
  }
  evaluateVisible.value = true
}

function addLessonToForm(): void {
  const lesson = evaluateForm.value.newLesson.trim()
  if (!lesson) return
  evaluateForm.value.lessons.push(lesson)
  evaluateForm.value.newLesson = ''
}

function removeLessonFromForm(idx: number): void {
  evaluateForm.value.lessons.splice(idx, 1)
}

const evaluateLoading = ref(false)

async function handleEvaluate(): Promise<void> {
  evaluateLoading.value = true
  try {
    const result = await evaluateWorkContext({
      context_id: evaluateForm.value.contextId,
      outcome: evaluateForm.value.outcome,
      summary: evaluateForm.value.summary || undefined,
      lessons: evaluateForm.value.lessons.length > 0 ? evaluateForm.value.lessons : undefined,
    })
    evaluateVisible.value = false
    detailVisible.value = false
    ElMessage.success(result.message)
    await loadContexts()
  } catch (err) {
    ElMessage.error(`评价失败: ${(err as Error).message}`)
  } finally {
    evaluateLoading.value = false
  }
}

function handleProductLineChange(v: string | number | boolean): void {
  if (v) {
    projectCtx.setProductLine(String(v))
  } else {
    projectCtx.clearFilter()
  }
  loadContexts()
}

function getEvaluation(ctx: WorkContextEntry) {
  return getMeta(ctx).evaluation ?? null
}

function getProjectNames(ctx: WorkContextEntry): string {
  const projects = getMeta(ctx).projects
  return projects?.map(p => p.name).join(', ') || '-'
}

function getTypeLabel(type: string): string {
  const map: Record<string, string> = {
    requirement: '需求', bug_fix: 'Bug修复', refactor: '重构', investigation: '调研', learning: '学习',
  }
  return map[type] ?? type
}

function getTypeColor(type: string): string {
  const map: Record<string, string> = {
    requirement: '', bug_fix: 'danger', refactor: 'warning', investigation: 'info', learning: 'success',
  }
  return map[type] ?? 'info'
}

function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    in_progress: '进行中', completed: '已完成', cancelled: '已取消', deferred: '已延期',
  }
  return map[status] ?? status
}

function getStatusColor(status: string): string {
  const map: Record<string, string> = {
    in_progress: '', completed: 'success', cancelled: 'info', deferred: 'warning',
  }
  return map[status] ?? 'info'
}

function getPriorityColor(priority: string | null): string {
  const map: Record<string, string> = { P0: 'danger', P1: 'warning', P2: '', P3: 'info' }
  return map[priority ?? ''] ?? 'info'
}

function formatDuration(meta: WorkContextMetadata): string {
  if (meta.evaluation?.duration_hours != null) {
    return `${meta.evaluation.duration_hours}h`
  }
  if (!meta.started_at) return '-'
  const ms = Date.now() - new Date(meta.started_at).getTime()
  const hours = Math.round(ms / 3600000 * 10) / 10
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24 * 10) / 10
  return `${days}d`
}

function formatDate(iso: string): string {
  if (!iso) return '-'
  return iso.split('T')[0]
}

async function handleArchive(ctx: WorkContextEntry): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定要归档「${ctx.title}」吗？`, '确认归档', { type: 'warning' })
    const { archiveMemory } = await import('../api/mcp-tools')
    await archiveMemory(ctx.id, '手动归档')
    ElMessage.success('已归档')
    await loadContexts()
  } catch { /* 取消 */ }
}

onMounted(() => {
  projectCtx.loadProjects()
  loadContexts()
})
</script>

<template>
  <div>
    <!-- 顶部统计 -->
    <el-row :gutter="16" style="margin-bottom: 16px">
      <el-col :span="5">
        <el-card shadow="never" body-style="padding: 16px">
          <el-statistic title="进行中" :value="stats.active">
            <template #suffix>个</template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="5">
        <el-card shadow="never" body-style="padding: 16px">
          <el-statistic title="已完成" :value="stats.done">
            <template #suffix>个</template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="5">
        <el-card shadow="never" body-style="padding: 16px">
          <el-statistic title="总计" :value="stats.total">
            <template #suffix>个</template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="5">
        <el-card shadow="never" body-style="padding: 16px">
          <el-statistic title="变更文件" :value="stats.totalFiles">
            <template #suffix>个</template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="never" body-style="padding: 16px">
          <el-statistic title="累计工时" :value="stats.totalHours">
            <template #suffix>h</template>
          </el-statistic>
        </el-card>
      </el-col>
    </el-row>

    <!-- 工具栏 -->
    <el-card shadow="never" style="margin-bottom: 16px" body-style="padding: 12px 16px">
      <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
        <el-button type="primary" icon="Plus" @click="openCreate">新建工作</el-button>
        <el-button icon="Refresh" :loading="loading" @click="loadContexts">刷新</el-button>
        <el-divider direction="vertical" />
        <el-radio-group v-model="viewMode" size="small">
          <el-radio-button value="kanban">看板</el-radio-button>
          <el-radio-button value="table">列表</el-radio-button>
        </el-radio-group>
        <div style="flex: 1" />
        <el-select
          :model-value="projectCtx.selectedProductLine"
          placeholder="全部产品线"
          clearable
          size="default"
          style="width: 160px"
          @update:model-value="handleProductLineChange"
        >
          <el-option v-for="pl in projectCtx.productLines" :key="pl" :label="pl" :value="pl" />
        </el-select>
      </div>
    </el-card>

    <!-- 看板视图 -->
    <div v-if="viewMode === 'kanban'" v-loading="loading" class="kanban-container">
      <div class="kanban-column">
        <div class="kanban-header kanban-header--active">
          进行中 <el-badge :value="inProgressContexts.length" type="primary" />
        </div>
        <div class="kanban-body">
          <div
            v-for="ctx in inProgressContexts"
            :key="ctx.id"
            class="kanban-card"
            @click="openDetail(ctx)"
          >
            <div class="kanban-card__header">
              <el-tag :type="getTypeColor(getMeta(ctx).work_type)" size="small">
                {{ getTypeLabel(getMeta(ctx).work_type) }}
              </el-tag>
              <el-tag v-if="getMeta(ctx).priority" :type="getPriorityColor(getMeta(ctx).priority)" size="small" effect="plain">
                {{ getMeta(ctx).priority }}
              </el-tag>
            </div>
            <div class="kanban-card__title">{{ ctx.title.replace(/^\[.*?\]\s*/, '') }}</div>
            <div class="kanban-card__meta">
              <span>{{ formatDate(getMeta(ctx).started_at) }}</span>
              <span>{{ formatDuration(getMeta(ctx)) }}</span>
            </div>
            <div v-if="getMeta(ctx).projects?.length" class="kanban-card__projects">
              <el-tag v-for="p in getMeta(ctx).projects.slice(0, 3)" :key="p.name" size="small" effect="plain" style="margin: 2px">
                {{ p.name }}
              </el-tag>
              <el-tag v-if="getMeta(ctx).projects.length > 3" size="small" type="info" effect="plain" style="margin: 2px">
                +{{ getMeta(ctx).projects.length - 3 }}
              </el-tag>
            </div>
            <div class="kanban-card__actions">
              <el-button size="small" text type="primary" @click.stop="openUpdateNote(ctx)">更新进度</el-button>
              <el-button size="small" text type="success" @click.stop="openEvaluate(ctx)">完成</el-button>
            </div>
          </div>
          <el-empty v-if="inProgressContexts.length === 0" description="暂无进行中的工作" :image-size="60" />
        </div>
      </div>

      <div class="kanban-column">
        <div class="kanban-header kanban-header--done">
          已完成 <el-badge :value="completedContexts.length" type="success" />
        </div>
        <div class="kanban-body">
          <div
            v-for="ctx in completedContexts"
            :key="ctx.id"
            class="kanban-card kanban-card--done"
            @click="openDetail(ctx)"
          >
            <div class="kanban-card__header">
              <el-tag :type="getTypeColor(getMeta(ctx).work_type)" size="small">
                {{ getTypeLabel(getMeta(ctx).work_type) }}
              </el-tag>
              <el-tag v-if="getEvaluation(ctx)" size="small" type="success" effect="plain">
                {{ getEvaluation(ctx)?.duration_hours }}h
              </el-tag>
            </div>
            <div class="kanban-card__title">{{ ctx.title.replace(/^\[.*?\]\s*/, '') }}</div>
            <div class="kanban-card__meta">
              <span>{{ formatDate(getMeta(ctx).started_at) }} ~ {{ formatDate(getMeta(ctx).completed_at || '') }}</span>
            </div>
            <div v-if="getEvaluation(ctx)" class="kanban-card__stats">
              <span>{{ getEvaluation(ctx)?.total_files_changed }} 文件</span>
              <span style="color: #67C23A">+{{ getEvaluation(ctx)?.total_lines_added }}</span>
              <span style="color: #F56C6C">-{{ getEvaluation(ctx)?.total_lines_deleted }}</span>
            </div>
          </div>
          <el-empty v-if="completedContexts.length === 0" description="暂无已完成的工作" :image-size="60" />
        </div>
      </div>

      <div class="kanban-column">
        <div class="kanban-header kanban-header--other">
          其他 <el-badge :value="otherContexts.length" type="info" />
        </div>
        <div class="kanban-body">
          <div
            v-for="ctx in otherContexts"
            :key="ctx.id"
            class="kanban-card kanban-card--other"
            @click="openDetail(ctx)"
          >
            <div class="kanban-card__header">
              <el-tag :type="getStatusColor(getMeta(ctx).status)" size="small">
                {{ getStatusLabel(getMeta(ctx).status) }}
              </el-tag>
              <el-tag :type="getTypeColor(getMeta(ctx).work_type)" size="small">
                {{ getTypeLabel(getMeta(ctx).work_type) }}
              </el-tag>
            </div>
            <div class="kanban-card__title">{{ ctx.title.replace(/^\[.*?\]\s*/, '') }}</div>
            <div class="kanban-card__meta">
              <span>{{ formatDate(getMeta(ctx).started_at) }}</span>
            </div>
          </div>
          <el-empty v-if="otherContexts.length === 0" description="暂无" :image-size="60" />
        </div>
      </div>
    </div>

    <!-- 列表视图 -->
    <el-card v-if="viewMode === 'table'" v-loading="loading" shadow="never">
      <el-table :data="allContexts" stripe size="small" @row-click="openDetail">
        <el-table-column label="标题" min-width="240">
          <template #default="{ row }">
            <span style="cursor: pointer">{{ row.title.replace(/^\[.*?\]\s*/, '') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="getTypeColor(getMeta(row).work_type)" size="small">
              {{ getTypeLabel(getMeta(row).work_type) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="getStatusColor(getMeta(row).status)" size="small">
              {{ getStatusLabel(getMeta(row).status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="优先级" width="70" align="center">
          <template #default="{ row }">
            <el-tag v-if="getMeta(row).priority" :type="getPriorityColor(getMeta(row).priority)" size="small">
              {{ getMeta(row).priority }}
            </el-tag>
            <span v-else style="color: #c0c4cc">-</span>
          </template>
        </el-table-column>
        <el-table-column label="项目" width="160">
          <template #default="{ row }">
            <span>{{ getProjectNames(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="开始时间" width="110">
          <template #default="{ row }">{{ formatDate(getMeta(row).started_at) }}</template>
        </el-table-column>
        <el-table-column label="耗时" width="80">
          <template #default="{ row }">{{ formatDuration(getMeta(row)) }}</template>
        </el-table-column>
        <el-table-column label="文件" width="60" align="center">
          <template #default="{ row }">
            {{ getMeta(row).evaluation?.total_files_changed ?? sumProjectStat(getMeta(row).projects, 'files_changed') }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" align="center">
          <template #default="{ row }">
            <template v-if="getMeta(row).status === 'in_progress'">
              <el-button size="small" text type="primary" @click.stop="openUpdateNote(row)">更新</el-button>
              <el-button size="small" text type="success" @click.stop="openEvaluate(row)">完成</el-button>
              <el-button size="small" text type="info" @click.stop="handleArchive(row)">归档</el-button>
            </template>
            <el-button v-else size="small" text type="info" @click.stop="handleArchive(row)">归档</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 详情弹窗 -->
    <el-drawer v-model="detailVisible" size="600px" :title="selectedContext?.title?.replace(/^\[.*?\]\s*/, '') ?? '详情'">
      <template v-if="selectedContext">
        <el-descriptions :column="2" border size="small" style="margin-bottom: 16px">
          <el-descriptions-item label="类型">
            <el-tag :type="getTypeColor(getMeta(selectedContext).work_type)" size="small">
              {{ getTypeLabel(getMeta(selectedContext).work_type) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="getStatusColor(getMeta(selectedContext).status)" size="small">
              {{ getStatusLabel(getMeta(selectedContext).status) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="优先级">
            {{ getMeta(selectedContext).priority ?? '-' }}
          </el-descriptions-item>
          <el-descriptions-item label="预估工时">
            {{ getMeta(selectedContext).estimated_hours ? getMeta(selectedContext).estimated_hours + 'h' : '-' }}
          </el-descriptions-item>
          <el-descriptions-item label="开始时间">{{ formatDate(getMeta(selectedContext).started_at) }}</el-descriptions-item>
          <el-descriptions-item label="完成时间">{{ getMeta(selectedContext).completed_at ? formatDate(getMeta(selectedContext).completed_at || '') : '-' }}</el-descriptions-item>
          <el-descriptions-item label="实际耗时" :span="2">{{ formatDuration(getMeta(selectedContext)) }}</el-descriptions-item>
        </el-descriptions>

        <!-- 涉及项目 -->
        <h4 style="margin: 12px 0 8px">涉及项目</h4>
        <el-table :data="getMeta(selectedContext).projects ?? []" stripe size="small" style="margin-bottom: 16px">
          <el-table-column prop="name" label="项目" min-width="140" />
          <el-table-column prop="branch" label="分支" min-width="120">
            <template #default="{ row }">
              <el-text v-if="row.branch" tag="code" size="small">{{ row.branch }}</el-text>
              <span v-else style="color: #c0c4cc">-</span>
            </template>
          </el-table-column>
          <el-table-column prop="files_changed" label="文件" width="60" align="center" />
          <el-table-column label="增/删" width="100" align="center">
            <template #default="{ row }">
              <span style="color: #67C23A">+{{ row.lines_added }}</span> /
              <span style="color: #F56C6C">-{{ row.lines_deleted }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="commits" label="提交" width="60" align="center" />
        </el-table>

        <!-- 相关文档 -->
        <template v-if="getMeta(selectedContext).documents?.length">
          <h4 style="margin: 12px 0 8px">相关文档</h4>
          <div style="margin-bottom: 16px">
            <el-link
              v-for="(doc, i) in getMeta(selectedContext).documents"
              :key="i"
              :href="doc"
              target="_blank"
              type="primary"
              style="display: block; margin-bottom: 4px"
            >
              {{ doc }}
            </el-link>
          </div>
        </template>

        <!-- 评价报告 -->
        <template v-if="getEvaluation(selectedContext)">
          <h4 style="margin: 12px 0 8px">评价报告</h4>
          <el-descriptions :column="2" border size="small" style="margin-bottom: 16px">
            <el-descriptions-item label="总文件数">{{ getEvaluation(selectedContext)?.total_files_changed }}</el-descriptions-item>
            <el-descriptions-item label="总提交数">{{ getEvaluation(selectedContext)?.total_commits }}</el-descriptions-item>
            <el-descriptions-item label="新增行数">
              <span style="color: #67C23A">+{{ getEvaluation(selectedContext)?.total_lines_added }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="删除行数">
              <span style="color: #F56C6C">-{{ getEvaluation(selectedContext)?.total_lines_deleted }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="引用记忆">{{ getEvaluation(selectedContext)?.memories_referenced }}</el-descriptions-item>
            <el-descriptions-item label="沉淀经验">{{ getEvaluation(selectedContext)?.lessons_generated }}</el-descriptions-item>
          </el-descriptions>
        </template>

        <!-- 内容详情 -->
        <h4 style="margin: 12px 0 8px">进度记录</h4>
        <el-input type="textarea" :model-value="selectedContext.content" readonly :rows="8" />

        <!-- 操作按钮 -->
        <div v-if="getMeta(selectedContext).status === 'in_progress'" style="margin-top: 16px; display: flex; gap: 8px">
          <el-button type="primary" icon="EditPen" @click="openUpdateNote(selectedContext)">更新进度</el-button>
          <el-button type="success" icon="Check" @click="openEvaluate(selectedContext)">完成工作</el-button>
        </div>
      </template>
    </el-drawer>

    <!-- 新建弹窗 -->
    <el-dialog v-model="createVisible" title="新建工作上下文" width="600px" destroy-on-close>
      <el-form :model="createForm" label-width="80px" size="default">
        <el-form-item label="标题" required>
          <el-input v-model="createForm.title" placeholder="如「用户资料V2迁移」" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="createForm.type" style="width: 100%">
            <el-option label="需求" value="requirement" />
            <el-option label="Bug修复" value="bug_fix" />
            <el-option label="重构" value="refactor" />
            <el-option label="调研" value="investigation" />
            <el-option label="学习" value="learning" />
          </el-select>
        </el-form-item>
        <el-form-item label="优先级">
          <el-select v-model="createForm.priority" style="width: 100%">
            <el-option label="P0 - 紧急" value="P0" />
            <el-option label="P1 - 高" value="P1" />
            <el-option label="P2 - 中" value="P2" />
            <el-option label="P3 - 低" value="P3" />
          </el-select>
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="createForm.description" type="textarea" :rows="3" placeholder="详细描述（可选）" />
        </el-form-item>
        <el-form-item label="预估工时">
          <el-input-number v-model="createForm.estimated_hours" :min="0.5" :step="0.5" :precision="1" style="width: 100%" placeholder="小时" />
        </el-form-item>
        <el-form-item label="涉及项目">
          <div style="width: 100%">
            <div v-for="(p, i) in createForm.projects" :key="i" style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px">
              <el-tag closable @close="removeProjectFromForm(i)">{{ p.name }}<template v-if="p.branch"> ({{ p.branch }})</template></el-tag>
            </div>
            <div style="display: flex; gap: 8px">
              <el-select v-model="createForm.newProjectName" placeholder="选择仓库" clearable filterable style="flex: 1">
                <el-option v-for="proj in projectCtx.knownProjects" :key="proj.path" :label="proj.label" :value="proj.label" />
              </el-select>
              <el-input v-model="createForm.newProjectBranch" placeholder="分支（可选）" style="width: 140px" />
              <el-button icon="Plus" @click="addProjectToForm" />
            </div>
          </div>
        </el-form-item>
        <el-form-item label="文档链接">
          <div style="width: 100%">
            <div v-for="(doc, i) in createForm.related_doc_urls" :key="i" style="margin-bottom: 4px">
              <el-tag closable @close="removeDocFromForm(i)">{{ doc }}</el-tag>
            </div>
            <div style="display: flex; gap: 8px">
              <el-input v-model="createForm.newDocUrl" placeholder="URL" style="flex: 1" />
              <el-button icon="Plus" @click="addDocToForm" />
            </div>
          </div>
        </el-form-item>
        <el-form-item label="标签">
          <div style="width: 100%">
            <el-tag v-for="(t, i) in createForm.tags" :key="i" closable style="margin: 2px" @close="removeTagFromForm(i)">{{ t }}</el-tag>
            <div style="display: flex; gap: 8px; margin-top: 4px">
              <el-input v-model="createForm.newTag" placeholder="添加标签" style="flex: 1" @keyup.enter="addTagToForm" />
              <el-button icon="Plus" @click="addTagToForm" />
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="createLoading" @click="handleCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 更新进度弹窗 -->
    <el-dialog v-model="updateNoteVisible" title="更新进度" width="480px">
      <el-input v-model="updateNoteForm.note" type="textarea" :rows="4" placeholder="进度说明（如「完成数据库迁移脚本」）" />
      <template #footer>
        <el-button @click="updateNoteVisible = false">取消</el-button>
        <el-button type="primary" :loading="updateLoading" @click="handleUpdateNote">提交</el-button>
      </template>
    </el-dialog>

    <!-- 评价弹窗 -->
    <el-dialog v-model="evaluateVisible" title="完成工作 & 评价" width="560px" destroy-on-close>
      <el-form :model="evaluateForm" label-width="80px" size="default">
        <el-form-item label="结果">
          <el-radio-group v-model="evaluateForm.outcome">
            <el-radio-button value="completed">已完成</el-radio-button>
            <el-radio-button value="deferred">延期</el-radio-button>
            <el-radio-button value="cancelled">取消</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="总结">
          <el-input v-model="evaluateForm.summary" type="textarea" :rows="3" placeholder="完成总结（可选）" />
        </el-form-item>
        <el-form-item label="经验教训">
          <div style="width: 100%">
            <div v-for="(l, i) in evaluateForm.lessons" :key="i" style="margin-bottom: 4px">
              <el-tag closable type="warning" @close="removeLessonFromForm(i)">{{ l }}</el-tag>
            </div>
            <div style="display: flex; gap: 8px">
              <el-input v-model="evaluateForm.newLesson" placeholder="输入一条经验教训" style="flex: 1" @keyup.enter="addLessonToForm" />
              <el-button icon="Plus" @click="addLessonToForm" />
            </div>
            <el-text type="info" size="small" style="margin-top: 4px">每条经验会自动存入记忆库</el-text>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="evaluateVisible = false">取消</el-button>
        <el-button type="primary" :loading="evaluateLoading" @click="handleEvaluate">提交评价</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.kanban-container {
  display: flex;
  gap: 16px;
  min-height: 500px;
}

.kanban-column {
  flex: 1;
  min-width: 280px;
  background: var(--mf-bg-base, #24282e);
  border-radius: 8px;
  border: 1px solid var(--mf-border, rgba(255,255,255,0.08));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.kanban-header {
  padding: 12px 16px;
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 2px solid transparent;
}

.kanban-header--active {
  border-bottom-color: var(--mf-primary, #5b9bd5);
  color: var(--mf-primary, #5b9bd5);
}

.kanban-header--done {
  border-bottom-color: var(--mf-success, #6bc77a);
  color: var(--mf-success, #6bc77a);
}

.kanban-header--other {
  border-bottom-color: var(--mf-text-muted, #5a6170);
  color: var(--mf-text-muted, #5a6170);
}

.kanban-body {
  flex: 1;
  padding: 12px;
  overflow-y: auto;
}

.kanban-card {
  padding: 12px;
  margin-bottom: 10px;
  border: 1px solid var(--mf-border, rgba(255,255,255,0.08));
  border-radius: 6px;
  cursor: pointer;
  background: var(--mf-bg-elevated, #2a2f36);
}

.kanban-card:hover {
  border-color: var(--mf-border-active, rgba(91,155,213,0.25));
}

.kanban-card--done {
  opacity: 0.85;
}

.kanban-card--done:hover {
  border-color: var(--mf-success, #6bc77a);
}

.kanban-card--other {
  opacity: 0.7;
}

.kanban-card__header {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}

.kanban-card__title {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.kanban-card__meta {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--mf-text-muted, #5a6170);
  margin-bottom: 6px;
}

.kanban-card__projects {
  margin-bottom: 6px;
}

.kanban-card__stats {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--mf-text-secondary, #8e949e);
}

.kanban-card__actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  border-top: 1px solid var(--mf-border, rgba(255,255,255,0.08));
  padding-top: 6px;
}
</style>
