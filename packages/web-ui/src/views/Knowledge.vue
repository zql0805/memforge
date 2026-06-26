<template>
  <div class="knowledge-page">
    <div class="page-header">
      <h2>知识管理</h2>
      <div class="header-actions">
        <router-link to="/knowledge/stats"><el-button>统计面板</el-button></router-link>
        <el-button v-if="activeTab === 'list'" type="primary" @click="openCreateDialog">新建知识</el-button>
        <el-button v-else type="primary" @click="openCategoryDialog()">新建业务分类</el-button>
      </div>
    </div>

    <el-tabs v-model="activeTab" @tab-change="handleTabChange">
      <el-tab-pane label="知识列表" name="list">
        <div class="toolbar">
          <el-input
            v-model="searchQuery"
            placeholder="搜索知识..."
            prefix-icon="Search"
            clearable
            style="width: 280px"
            @keyup.enter="handleSearch"
          />
          <el-select v-model="filters.status" placeholder="状态" clearable style="width: 120px">
            <el-option label="草稿" value="draft" />
            <el-option label="已发布" value="published" />
            <el-option label="已归档" value="archived" />
          </el-select>
          <el-select v-model="filters.knowledgeType" placeholder="类型" clearable style="width: 140px">
            <el-option v-for="opt in knowledgeTypeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
          <el-cascader
            v-model="filters.categorySlug"
            :options="categoryCascaderOptions"
            :props="cascaderProps"
            placeholder="业务分类"
            clearable
            filterable
            style="width: 200px"
          />
          <el-button @click="handleSearch">搜索</el-button>
        </div>

        <el-table :data="items" v-loading="loading" stripe style="width: 100%">
          <el-table-column prop="title" label="标题" min-width="180">
            <template #default="{ row }">
              <router-link :to="`/knowledge/${row.id}`" class="title-link">{{ row.title }}</router-link>
            </template>
          </el-table-column>
          <el-table-column prop="summary" label="摘要" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">{{ row.summary || '-' }}</template>
          </el-table-column>
          <el-table-column prop="knowledgeType" label="类型" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="typeTagMap[row.knowledgeType] || 'info'">
                {{ typeLabels[row.knowledgeType] || row.knowledgeType }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="category" label="业务分类" width="120" />
          <el-table-column prop="status" label="状态" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="statusTagMap[row.status] || 'info'">{{ statusLabels[row.status] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="反馈" width="120">
            <template #default="{ row }">
              <span style="color: #67c23a">&#x1F44D; {{ row.helpfulCount }}</span>
              <span style="color: #f56c6c; margin-left: 8px">&#x1F44E; {{ row.unhelpfulCount }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="queryCount" label="查询次数" width="100" />
          <el-table-column prop="updatedAt" label="更新时间" width="180">
            <template #default="{ row }">{{ new Date(row.updatedAt).toLocaleString() }}</template>
          </el-table-column>
          <el-table-column label="操作" width="200" fixed="right">
            <template #default="{ row }">
              <el-button v-if="row.status === 'draft'" size="small" type="success" @click="handlePublish(row.id)">发布</el-button>
              <el-button v-if="row.status === 'published'" size="small" type="warning" @click="handleArchive(row.id)">归档</el-button>
              <el-button size="small" type="danger" @click="handleDelete(row.id)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-pagination
          v-if="total > pageSize"
          :current-page="page"
          :page-size="pageSize"
          :total="total"
          layout="prev, pager, next"
          style="margin-top: 16px; justify-content: center"
          @current-change="handlePageChange"
        />
      </el-tab-pane>

      <el-tab-pane label="业务分类管理" name="categories">
        <el-table :data="flatCategories" v-loading="categoriesLoading" stripe style="width: 100%">
          <el-table-column prop="name" label="名称" min-width="160" />
          <el-table-column prop="slug" label="Slug" min-width="140" />
          <el-table-column label="父级业务分类" width="160">
            <template #default="{ row }">{{ parentName(row.parentId) }}</template>
          </el-table-column>
          <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
          <el-table-column prop="sortOrder" label="排序" width="80" />
          <el-table-column label="操作" width="160" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="openCategoryDialog(row)">编辑</el-button>
              <el-button size="small" type="danger" @click="handleDeleteCategory(row.id)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="showCreateDialog" title="新建知识" width="680px" @closed="resetCreateForm">
      <el-form :model="createForm" label-width="100px">
        <el-form-item label="标题" required>
          <el-input v-model="createForm.title" placeholder="知识标题" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="createForm.knowledgeType" style="width: 100%">
            <el-option v-for="opt in knowledgeTypeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="业务分类">
          <el-cascader
            v-model="createForm.categorySlug"
            :options="categoryCascaderOptions"
            :props="cascaderProps"
            placeholder="选择业务分类"
            clearable
            filterable
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="产品线">
          <el-input v-model="createForm.productLine" placeholder="如 memforge、your-product（可选）" />
        </el-form-item>
        <el-form-item label="摘要">
          <el-input v-model="createForm.summary" type="textarea" :rows="2" placeholder="简要描述（可选）" />
        </el-form-item>
        <el-form-item v-if="createForm.knowledgeType === 'faq'" label="问题">
          <el-input v-model="createForm.question" type="textarea" :rows="3" placeholder="用户可能问的问题（FAQ 类型建议填写）" />
        </el-form-item>
        <el-form-item label="内容" required>
          <el-input v-model="createForm.content" type="textarea" :rows="6" placeholder="知识正文" />
        </el-form-item>
        <el-form-item label="元数据">
          <el-input v-model="createForm.metadataInput" type="textarea" :rows="3" placeholder='可选 JSON，例如 {"severity":"P1"}' />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="createForm.tagsInput" placeholder="逗号分隔" />
        </el-form-item>
        <el-form-item label="可见范围">
          <el-select v-model="createForm.visibility" style="width: 100%">
            <el-option label="仅自己" value="personal" />
            <el-option label="团队可见" value="team" />
            <el-option label="产品线可见" value="product_line" />
            <el-option label="全局可见" value="global" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button type="primary" @click="handleCreate" :loading="creating">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showCategoryDialog" :title="editingCategoryId ? '编辑业务分类' : '新建业务分类'" width="520px" @closed="resetCategoryForm">
      <el-form :model="categoryForm" label-width="100px">
        <el-form-item label="名称" required>
          <el-input v-model="categoryForm.name" placeholder="业务分类名称" />
        </el-form-item>
        <el-form-item label="Slug" required>
          <el-input v-model="categoryForm.slug" placeholder="例如 payment-issue" :disabled="!!editingCategoryId" />
        </el-form-item>
        <el-form-item label="父级业务分类">
          <el-select v-model="categoryForm.parentId" placeholder="无（顶级业务分类）" clearable style="width: 100%">
            <el-option
              v-for="cat in flatCategories.filter(c => c.id !== editingCategoryId)"
              :key="cat.id"
              :label="cat.name"
              :value="cat.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="产品线">
          <el-input v-model="categoryForm.productLine" placeholder="如 memforge、your-product（可选）" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="categoryForm.description" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="图标">
          <el-input v-model="categoryForm.icon" placeholder="可选图标名" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="categoryForm.sortOrder" :min="0" :max="9999" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCategoryDialog = false">取消</el-button>
        <el-button type="primary" @click="handleSaveCategory" :loading="savingCategory">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  listKnowledge, storeKnowledge, publishKnowledge, archiveKnowledge, deleteKnowledge,
  listManagedCategories, createCategory, updateCategory, deleteManagedCategory,
  type KnowledgeItem, type KnowledgeCategory,
} from '../api/client'

const knowledgeTypeOptions = [
  { label: 'FAQ', value: 'faq' },
  { label: '操作指南', value: 'how_to' },
  { label: '排障指南', value: 'troubleshooting' },
  { label: '技术文档', value: 'technical' },
  { label: '故障案例', value: 'incident' },
  { label: '内部 SOP', value: 'runbook' },
  { label: 'API 参考', value: 'api_reference' },
]

const cascaderProps = {
  value: 'slug',
  label: 'name',
  children: 'children',
  checkStrictly: true,
  emitPath: false,
}

const items = ref<KnowledgeItem[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(false)
const searchQuery = ref('')
const activeTab = ref('list')
const showCreateDialog = ref(false)
const creating = ref(false)

const flatCategories = ref<KnowledgeCategory[]>([])
const categoriesLoading = ref(false)
const showCategoryDialog = ref(false)
const savingCategory = ref(false)
const editingCategoryId = ref<string | null>(null)

const filters = reactive({
  status: '',
  knowledgeType: '',
  categorySlug: '' as string | undefined,
})

const createForm = reactive({
  title: '',
  knowledgeType: 'faq',
  categorySlug: '' as string | undefined,
  productLine: '',
  summary: '',
  question: '',
  content: '',
  metadataInput: '',
  tagsInput: '',
  visibility: 'product_line',
})

const categoryForm = reactive({
  name: '',
  slug: '',
  parentId: '' as string | undefined,
  description: '',
  productLine: '',
  icon: '',
  sortOrder: 0,
})

const typeTagMap: Record<string, string> = {
  faq: '', how_to: 'success', troubleshooting: 'warning', technical: 'success',
  incident: 'danger', runbook: 'info', api_reference: 'info',
}
const typeLabels: Record<string, string> = Object.fromEntries(knowledgeTypeOptions.map(o => [o.value, o.label]))
const statusTagMap: Record<string, string> = {
  draft: 'info', published: 'success', archived: 'warning',
}
const statusLabels: Record<string, string> = {
  draft: '草稿', published: '已发布', archived: '已归档',
}

const categoryCascaderOptions = computed(() => buildCategoryTree(flatCategories.value))

function normalizeCategory(raw: Record<string, unknown>): KnowledgeCategory {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    slug: String(raw.slug ?? ''),
    parentId: (raw.parentId ?? raw.parent_id ?? null) as string | null,
    description: (raw.description ?? null) as string | null,
    productLine: (raw.productLine ?? raw.product_line ?? null) as string | null,
    icon: (raw.icon ?? null) as string | null,
    sortOrder: Number(raw.sortOrder ?? raw.sort_order ?? 0),
  }
}

function buildCategoryTree(categories: KnowledgeCategory[]): KnowledgeCategory[] {
  const sorted = [...categories].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  const map = new Map<string, KnowledgeCategory & { children: KnowledgeCategory[] }>()
  const roots: KnowledgeCategory[] = []

  for (const cat of sorted) {
    map.set(cat.id, { ...cat, children: [] })
  }

  for (const cat of sorted) {
    const node = map.get(cat.id)!
    if (cat.parentId && map.has(cat.parentId)) {
      map.get(cat.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const stripEmpty = (nodes: KnowledgeCategory[]): KnowledgeCategory[] =>
    nodes.map(n => {
      const children = n.children?.length ? stripEmpty(n.children) : undefined
      return children?.length ? { ...n, children } : { ...n, children: undefined }
    })

  return stripEmpty(roots)
}

function parentName(parentId?: string | null): string {
  if (!parentId) return '-'
  return flatCategories.value.find(c => c.id === parentId)?.name ?? '-'
}

async function fetchCategories() {
  categoriesLoading.value = true
  try {
    const raw = await listManagedCategories()
    flatCategories.value = (Array.isArray(raw) ? raw : []).map(c => normalizeCategory(c as unknown as Record<string, unknown>))
  } catch (e) {
    console.error('加载业务分类失败:', e)
    flatCategories.value = []
  } finally {
    categoriesLoading.value = false
  }
}

async function fetchData() {
  loading.value = true
  try {
    const result = await listKnowledge({
      status: filters.status || undefined,
      knowledgeType: filters.knowledgeType || undefined,
      category: filters.categorySlug || undefined,
      search: searchQuery.value || undefined,
      page: page.value,
      pageSize,
    })
    items.value = result.items
    total.value = result.total
  } catch {
    ElMessage.error('加载失败')
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  page.value = 1
  fetchData()
}

function handlePageChange(p: number) {
  page.value = p
  fetchData()
}

function handleTabChange(tab: string | number) {
  if (tab === 'categories') fetchCategories()
}

function openCreateDialog() {
  showCreateDialog.value = true
}

function resetCreateForm() {
  Object.assign(createForm, {
    title: '', knowledgeType: 'faq', categorySlug: undefined, productLine: '',
    summary: '', question: '', content: '', metadataInput: '', tagsInput: '',
    visibility: 'product_line',
  })
}

function parseMetadataInput(): Record<string, unknown> | undefined {
  const raw = createForm.metadataInput.trim()
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('metadata must be object')
    }
    return parsed as Record<string, unknown>
  } catch {
    ElMessage.warning('元数据必须是合法 JSON 对象')
    return undefined
  }
}

async function handleCreate() {
  if (!createForm.title || !createForm.content) {
    ElMessage.warning('请填写标题和内容')
    return
  }
  if (createForm.knowledgeType === 'faq' && !createForm.question?.trim()) {
    ElMessage.warning('FAQ 类型请填写问题')
    return
  }

  const metadata = parseMetadataInput()
  if (createForm.metadataInput.trim() && metadata === undefined) return

  creating.value = true
  try {
    await storeKnowledge({
      projectId: createForm.productLine || 'default',
      productLine: createForm.productLine || undefined,
      knowledgeType: createForm.knowledgeType,
      category: createForm.categorySlug || undefined,
      title: createForm.title,
      question: createForm.question || undefined,
      content: createForm.content,
      summary: createForm.summary || undefined,
      metadata,
      tags: createForm.tagsInput ? createForm.tagsInput.split(',').map(t => t.trim()).filter(Boolean) : [],
      visibility: createForm.visibility,
    })
    ElMessage.success('知识创建成功')
    showCreateDialog.value = false
    fetchData()
  } catch {
    ElMessage.error('创建失败')
  } finally {
    creating.value = false
  }
}

function openCategoryDialog(row?: KnowledgeCategory) {
  editingCategoryId.value = row?.id ?? null
  Object.assign(categoryForm, {
    name: row?.name ?? '',
    slug: row?.slug ?? '',
    parentId: row?.parentId ?? undefined,
    description: row?.description ?? '',
    productLine: row?.productLine ?? '',
    icon: row?.icon ?? '',
    sortOrder: row?.sortOrder ?? 0,
  })
  showCategoryDialog.value = true
}

function resetCategoryForm() {
  editingCategoryId.value = null
  Object.assign(categoryForm, {
    name: '', slug: '', parentId: undefined, description: '', productLine: '', icon: '', sortOrder: 0,
  })
}

async function handleSaveCategory() {
  if (!categoryForm.name || !categoryForm.slug) {
    ElMessage.warning('请填写名称和 Slug')
    return
  }

  savingCategory.value = true
  try {
    if (editingCategoryId.value) {
      await updateCategory(editingCategoryId.value, {
        name: categoryForm.name,
        description: categoryForm.description || undefined,
        icon: categoryForm.icon || undefined,
        sortOrder: categoryForm.sortOrder,
      })
      ElMessage.success('业务分类已更新')
    } else {
      await createCategory({
        name: categoryForm.name,
        slug: categoryForm.slug,
        parentId: categoryForm.parentId || undefined,
        description: categoryForm.description || undefined,
        productLine: categoryForm.productLine || undefined,
        icon: categoryForm.icon || undefined,
        sortOrder: categoryForm.sortOrder,
      })
      ElMessage.success('业务分类已创建')
    }
    showCategoryDialog.value = false
    await fetchCategories()
  } catch {
    ElMessage.error('保存业务分类失败')
  } finally {
    savingCategory.value = false
  }
}

async function handleDeleteCategory(id: string) {
  await ElMessageBox.confirm('确认删除该业务分类？', '删除确认', { type: 'warning' })
  try {
    await deleteManagedCategory(id)
    ElMessage.success('业务分类已删除')
    await fetchCategories()
  } catch {
    ElMessage.error('删除业务分类失败')
  }
}

async function handlePublish(id: string) {
  await ElMessageBox.confirm('确认发布该知识条目？', '发布确认')
  await publishKnowledge(id)
  ElMessage.success('已发布')
  fetchData()
}

async function handleArchive(id: string) {
  await ElMessageBox.confirm('确认归档该知识条目？', '归档确认')
  await archiveKnowledge(id)
  ElMessage.success('已归档')
  fetchData()
}

async function handleDelete(id: string) {
  await ElMessageBox.confirm('确认删除？此操作不可恢复', '删除确认', { type: 'warning' })
  await deleteKnowledge(id)
  ElMessage.success('已删除')
  fetchData()
}

watch(() => [filters.status, filters.knowledgeType, filters.categorySlug], () => {
  page.value = 1
  fetchData()
})

onMounted(async () => {
  await fetchCategories()
  fetchData()
})
</script>

<style scoped>
.knowledge-page { padding: 0; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
.page-header h2 { margin: 0; }
.header-actions { display: flex; gap: 8px; align-items: center; }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
.title-link { color: var(--el-color-primary); text-decoration: none; }
.title-link:hover { text-decoration: underline; }
</style>
