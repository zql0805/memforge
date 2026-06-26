<script setup lang="ts">
// Created by dev on 2026/04/05
import { ref, onMounted, watch } from 'vue'
import { listMemories, recallMemory, archiveMemory, proposeRule, type MemoryListResult } from '../api/mcp-tools'
import { updateMemoryVisibility } from '../api/client'
import { useAuthStore } from '../stores/auth'
import { useProjectContext } from '../stores/project-context'
import { ElMessage, ElMessageBox } from 'element-plus'

const authStore = useAuthStore()
const projectCtx = useProjectContext()
const loading = ref(false)
const searchQuery = ref('')
const scopeFilter = ref('')
const currentPage = ref(1)
const pageSize = ref(20)
const total = ref(0)

const memories = ref<MemoryListResult['entries']>([])

const scopeOptions = [
  { value: '', label: '全部类型' },
  { value: 'coding_standard', label: '编码规范' },
  { value: 'architecture', label: '架构决策' },
  { value: 'lesson_learned', label: '经验教训' },
  { value: 'bug_pattern', label: 'Bug 模式' },
  { value: 'performance_insight', label: '性能优化' },
  { value: 'convention', label: '团队约定' },
  { value: 'domain_knowledge', label: '领域知识' },
  { value: 'failure_postmortem', label: '故障报告' },
]

const detailVisible = ref(false)
const detailItem = ref<MemoryListResult['entries'][0] | null>(null)
const editingVisibility = ref(false)
const newVisibility = ref<'personal' | 'team' | 'product_line' | 'global'>('personal')
const visibilityOptions = [
  { value: 'personal', label: '仅自己', description: '仅创建者可见' },
  { value: 'project', label: '项目', description: '同项目成员可见' },
  { value: 'team', label: '团队', description: '同团队成员可见' },
  { value: 'product_line', label: '产品线', description: '产品线内可见' },
  { value: 'global', label: '全局', description: '所有人可见' },
]

function handleProductLineChange(v: string | number | boolean | undefined): void {
  v ? projectCtx.setProductLine(String(v)) : projectCtx.clearFilter()
}

function showDetail(row: MemoryListResult['entries'][0]): void {
  detailItem.value = row
  editingVisibility.value = false
  detailVisible.value = true
}

function startEditVisibility(): void {
  if (!detailItem.value) return
  const vis = (detailItem.value as Record<string, unknown>).visibility as string
    ?? ((detailItem.value.metadata as Record<string, unknown> | undefined)?.visibility as string)
    ?? null
  if (vis && ['personal', 'team', 'product_line', 'global'].includes(vis)) {
    newVisibility.value = vis as typeof newVisibility.value
  } else {
    const pid = detailItem.value.projectId
    if (pid === '_global_') newVisibility.value = 'global'
    else newVisibility.value = 'project' as typeof newVisibility.value
  }
  editingVisibility.value = true
}

async function saveVisibility(): Promise<void> {
  if (!detailItem.value) return
  try {
    await updateMemoryVisibility(detailItem.value.id, newVisibility.value)
    ElMessage.success('可见范围已更新')
    editingVisibility.value = false
    await loadMemories()
  } catch {
    ElMessage.error('更新失败')
  }
}

async function loadMemories(): Promise<void> {
  if (!authStore.isAuthenticated) return
  loading.value = true
  try {
    if (searchQuery.value.trim()) {
      const recallOpts: Record<string, unknown> = {}
      if (projectCtx.selectedProductLine) {
        recallOpts.product_line = projectCtx.selectedProductLine
      } else {
        recallOpts.cross_project = true
      }
      const result = await recallMemory(searchQuery.value, pageSize.value, recallOpts as Parameters<typeof recallMemory>[2])
      if (result.success) {
        memories.value = result.results.map(r => ({
          id: r.id,
          title: r.title,
          content: r.content,
          scope: r.scope,
          source: '',
          tags: r.tags,
          metadata: {},
          isArchived: false,
          createdAt: r.createdAt,
          updatedAt: r.createdAt,
        }))
        total.value = result.results.length
      }
    } else {
      const params: Record<string, unknown> = {
        page: currentPage.value,
        page_size: pageSize.value,
        ...projectCtx.queryParams,
      }
      if (scopeFilter.value) params.scope = scopeFilter.value
      const result = await listMemories(params as Parameters<typeof listMemories>[0])
      if (result.success) {
        memories.value = result.entries
        total.value = result.pagination.total
      }
    }
  } catch (e) {
    console.error('加载记忆列表失败:', e)
    ElMessage.error('加载记忆失败')
  } finally {
    loading.value = false
  }
}

async function handleArchive(id: string): Promise<void> {
  try {
    await ElMessageBox.confirm('确认归档此记忆？', '归档确认')
    const result = await archiveMemory(id, '用户手动归档')
    if (result.success) {
      ElMessage.success('已归档')
      await loadMemories()
    }
  } catch {
    // 取消
  }
}

// ─── 记忆晋升为规范 ──────────────────
const promoteDialogVisible = ref(false)
const promoteLoading = ref(false)
const promoteForm = ref({
  title: '',
  description: '',
  rationale: '',
  category: 'convention',
  severity: 'warning',
  language: '',
  rule_type: 'coding' as 'coding' | 'ai_agent' | 'workflow' | 'business' | 'infra',
  visibility: 'project' as 'global' | 'product_line' | 'project',
  product_line: '',
  source_memory_id: '',
})

const categoryOptions = [
  { value: 'security', label: '安全' },
  { value: 'performance', label: '性能' },
  { value: 'style', label: '代码风格' },
  { value: 'logic', label: '逻辑' },
  { value: 'convention', label: '团队约定' },
  { value: 'architecture', label: '架构' },
]

const ruleTypeOptions = [
  { value: 'coding', label: '编码规范' },
  { value: 'ai_agent', label: 'AI 行为' },
  { value: 'workflow', label: '工作流程' },
  { value: 'business', label: '业务规则' },
  { value: 'infra', label: '基础设施' },
]

function canPromote(): boolean {
  const role = authStore.role
  return role === 'admin' || role === 'lead' || role === 'developer'
}

function openPromoteDialog(memory: MemoryListResult['entries'][0]): void {
  const scopeToCategory: Record<string, string> = {
    coding_standard: 'style',
    architecture: 'architecture',
    bug_pattern: 'logic',
    performance_insight: 'performance',
    convention: 'convention',
    lesson_learned: 'convention',
  }

  promoteForm.value = {
    title: memory.title,
    description: memory.content,
    rationale: `从记忆晋升：原始 scope=${memory.scope}`,
    category: scopeToCategory[memory.scope] ?? 'convention',
    severity: 'warning',
    language: '',
    rule_type: 'coding',
    visibility: memory.projectId === '_global_' ? 'global' : 'project',
    product_line: projectCtx.selectedProductLine ?? '',
    source_memory_id: memory.id,
  }
  promoteDialogVisible.value = true
}

async function handlePromote(): Promise<void> {
  if (!promoteForm.value.title.trim() || !promoteForm.value.description.trim()) {
    ElMessage.warning('标题和描述不能为空')
    return
  }
  promoteLoading.value = true
  try {
    const result = await proposeRule({
      title: promoteForm.value.title,
      description: promoteForm.value.description,
      rationale: promoteForm.value.rationale || undefined,
      category: promoteForm.value.category,
      severity: promoteForm.value.severity,
      language: promoteForm.value.language || undefined,
      source: 'manual',
      rule_type: promoteForm.value.rule_type,
      visibility: promoteForm.value.visibility,
      product_line: promoteForm.value.product_line || undefined,
    })
    if (result.success) {
      promoteDialogVisible.value = false
      const statusLabel = result.status === 'active' ? '已激活' : '待投票'
      ElMessage.success(`已晋升为规范（${statusLabel}），规则 ID: ${result.ruleId}`)
    } else {
      ElMessage.error(result.message || '晋升失败')
    }
  } catch (err) {
    ElMessage.error('晋升失败: ' + (err instanceof Error ? err.message : String(err)))
  } finally {
    promoteLoading.value = false
  }
}

watch([scopeFilter, currentPage], () => loadMemories())
watch(() => projectCtx.selectedProductLine, () => {
  currentPage.value = 1
  loadMemories()
})

onMounted(() => {
  projectCtx.loadProjects()
  loadMemories()
})
</script>

<template>
  <div>
    <el-card>
      <template #header>
        <div class="header">
          <span>记忆管理</span>
        </div>
      </template>

      <el-row :gutter="16" style="margin-bottom: 16px">
        <el-col :span="8">
          <el-input v-model="searchQuery" placeholder="语义搜索记忆..." prefix-icon="Search" clearable />
        </el-col>
        <el-col :span="5">
          <el-select v-model="scopeFilter" placeholder="类型筛选" clearable style="width: 100%">
            <el-option v-for="opt in scopeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-col>
        <el-col :span="5">
          <el-select
            :model-value="projectCtx.selectedProductLine"
            placeholder="全部产品线"
            clearable
            style="width: 100%"
            @update:model-value="handleProductLineChange"
          >
            <el-option v-for="pl in projectCtx.productLines" :key="pl" :label="pl" :value="pl" />
          </el-select>
        </el-col>
        <el-col :span="6">
          <el-button type="primary" icon="Search" :loading="loading" @click="loadMemories">搜索</el-button>
          <el-tag v-if="projectCtx.crossProject" type="info" size="small" style="margin-left: 8px">全部项目</el-tag>
        </el-col>
      </el-row>

      <el-alert
        v-if="!authStore.isAdmin && projectCtx.productLines.length === 0 && !loading && memories.length === 0"
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
      >
        当前账号尚未关联任何产品线，仅能查看全局记忆和个人记忆。如需查看产品线/团队级记忆，请联系管理员分配产品线权限。
      </el-alert>

      <el-table v-loading="loading" :data="memories" stripe>
        <el-table-column prop="title" label="标题" min-width="200" />
        <el-table-column label="类型" width="120">
          <template #default="{ row }">
            <el-tag size="small">{{ row.scope }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="130">
          <template #default="{ row }">
            <span style="font-size: 12px; color: #606266">{{ row.metadata?.source_project ?? row.projectId ?? row.source ?? '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="可见范围" width="120">
          <template #default="{ row }">
            <el-tag v-if="(row.visibility ?? row.metadata?.visibility) === 'global'" type="danger" size="small">全局</el-tag>
            <el-tag v-else-if="(row.visibility ?? row.metadata?.visibility) === 'product_line'" type="warning" size="small">{{ row.metadata?.source_product_line ?? row.projectId ?? '产品线' }}</el-tag>
            <el-tag v-else-if="(row.visibility ?? row.metadata?.visibility) === 'team'" type="success" size="small">团队</el-tag>
            <el-tag v-else-if="(row.visibility ?? row.metadata?.visibility) === 'project'" size="small">项目</el-tag>
            <el-tag v-else-if="(row.visibility ?? row.metadata?.visibility) === 'personal'" type="info" size="small">个人</el-tag>
            <el-tag v-else type="info" size="small">{{ row.visibility ?? '项目' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建者" width="120">
          <template #default="{ row }">
            <span style="font-size: 12px; color: #606266">{{ row.createdByName ?? (row.createdBy ? row.createdBy.slice(0, 8) + '…' : '-') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="标签" width="200">
          <template #default="{ row }">
            <el-tag v-for="tag in (row.tags ?? []).slice(0, 3)" :key="tag" size="small" style="margin-right: 4px">{{ tag }}</el-tag>
            <span v-if="(row.tags ?? []).length > 3" style="color: #909399; font-size: 12px">+{{ row.tags.length - 3 }}</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">
            {{ row.createdAt ? new Date(row.createdAt).toLocaleString('zh-CN') : '-' }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="showDetail(row)">详情</el-button>
            <el-button v-if="canPromote()" text type="success" size="small" @click="openPromoteDialog(row)">晋升规范</el-button>
            <el-button text type="warning" size="small" @click="handleArchive(row.id)">归档</el-button>
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

    <!-- 记忆详情对话框 -->
    <el-dialog v-model="detailVisible" :title="detailItem?.title ?? '记忆详情'" width="700px" top="5vh">
      <template v-if="detailItem">
        <el-descriptions :column="2" border size="small" style="margin-bottom: 16px">
          <el-descriptions-item label="ID">
            <code style="font-size: 11px">{{ detailItem.id }}</code>
          </el-descriptions-item>
          <el-descriptions-item label="类型">
            <el-tag size="small">{{ detailItem.scope }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="来源项目">{{ detailItem.metadata?.source_project ?? detailItem.projectId ?? detailItem.source ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="来源产品线">{{ detailItem.metadata?.source_product_line ?? '-' }}</el-descriptions-item>
          <el-descriptions-item v-if="authStore.isSuperAdmin && detailItem.createdBy" label="创建者">{{ (detailItem as Record<string, unknown>).createdByName ?? detailItem.createdBy }}</el-descriptions-item>
          <el-descriptions-item label="可见范围">
            <template v-if="!editingVisibility">
              <el-tag v-if="(detailItem.visibility ?? detailItem.metadata?.visibility) === 'global'" type="danger" size="small">全局</el-tag>
              <el-tag v-else-if="(detailItem.visibility ?? detailItem.metadata?.visibility) === 'product_line'" type="warning" size="small">{{ detailItem.metadata?.source_product_line ?? detailItem.projectId ?? '产品线' }}</el-tag>
              <el-tag v-else-if="(detailItem.visibility ?? detailItem.metadata?.visibility) === 'team'" type="success" size="small">团队</el-tag>
              <el-tag v-else-if="(detailItem.visibility ?? detailItem.metadata?.visibility) === 'personal'" type="info" size="small">个人</el-tag>
              <el-tag v-else type="info" size="small">{{ detailItem.visibility ?? '项目' }}</el-tag>
              <el-button text type="primary" size="small" style="margin-left: 8px" @click="startEditVisibility">修改</el-button>
            </template>
            <template v-else>
              <el-radio-group v-model="newVisibility" size="small">
                <el-radio-button v-for="opt in visibilityOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </el-radio-button>
              </el-radio-group>
              <div style="margin-top: 4px; font-size: 12px; color: #909399">
                {{ visibilityOptions.find(o => o.value === newVisibility)?.description }}
              </div>
              <div style="margin-top: 8px">
                <el-button type="primary" size="small" @click="saveVisibility">保存</el-button>
                <el-button size="small" @click="editingVisibility = false">取消</el-button>
              </div>
            </template>
          </el-descriptions-item>
          <el-descriptions-item label="创建时间">
            {{ detailItem.createdAt ? new Date(detailItem.createdAt).toLocaleString('zh-CN') : '-' }}
          </el-descriptions-item>
          <el-descriptions-item label="标签" :span="2">
            <el-tag v-for="tag in detailItem.tags ?? []" :key="tag" size="small" style="margin-right: 4px; margin-bottom: 4px">{{ tag }}</el-tag>
            <span v-if="!detailItem.tags?.length" style="color: #c0c4cc">无标签</span>
          </el-descriptions-item>
        </el-descriptions>

        <el-divider content-position="left">内容</el-divider>
        <div class="memory-content">{{ detailItem.content }}</div>

        <div v-if="canPromote()" style="margin-top: 16px; text-align: right">
          <el-button type="success" @click="detailVisible = false; openPromoteDialog(detailItem)">
            晋升为编码规范
          </el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 晋升为规范对话框 -->
    <el-dialog v-model="promoteDialogVisible" title="晋升为编码规范" width="650px" top="5vh">
      <el-alert type="info" :closable="false" style="margin-bottom: 16px">
        将此记忆晋升为编码规范后，会进入规范管理流程（候选 → 投票 → 激活）。
      </el-alert>
      <el-form :model="promoteForm" label-width="90px">
        <el-form-item label="规范标题" required>
          <el-input v-model="promoteForm.title" placeholder="简明扼要的规范标题" />
        </el-form-item>
        <el-form-item label="详细描述" required>
          <el-input v-model="promoteForm.description" type="textarea" :rows="6" placeholder="规范的详细描述" />
        </el-form-item>
        <el-form-item label="理由">
          <el-input v-model="promoteForm.rationale" type="textarea" :rows="2" placeholder="为什么需要这条规范" />
        </el-form-item>
        <el-row :gutter="16">
          <el-col :span="8">
            <el-form-item label="分类" required>
              <el-select v-model="promoteForm.category" style="width: 100%">
                <el-option v-for="opt in categoryOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="严重级别">
              <el-select v-model="promoteForm.severity" style="width: 100%">
                <el-option label="错误 (Error)" value="error" />
                <el-option label="警告 (Warning)" value="warning" />
                <el-option label="信息 (Info)" value="info" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="规范类型">
              <el-select v-model="promoteForm.rule_type" style="width: 100%">
                <el-option v-for="opt in ruleTypeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="8">
            <el-form-item label="语言">
              <el-input v-model="promoteForm.language" placeholder="如 java / php（留空=通用）" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="可见范围">
              <el-select v-model="promoteForm.visibility" style="width: 100%">
                <el-option label="全局" value="global" />
                <el-option label="产品线" value="product_line" />
                <el-option label="团队" value="team" />
                <el-option label="项目" value="project" />
                <el-option label="个人" value="personal" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item v-if="promoteForm.visibility === 'product_line'" label="产品线">
              <el-input v-model="promoteForm.product_line" placeholder="如 my-product" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="promoteDialogVisible = false">取消</el-button>
        <el-button type="success" :loading="promoteLoading" @click="handlePromote">提交为规范</el-button>
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

.memory-content {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.7;
  color: #303133;
  background: #fafafa;
  padding: 16px;
  border-radius: 4px;
  max-height: 500px;
  overflow-y: auto;
}
</style>
