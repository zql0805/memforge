<template>
  <div class="knowledge-detail-page" v-loading="loading">
    <div v-if="item" class="detail-content">
      <div class="detail-header">
        <h2>{{ item.title }}</h2>
        <div class="header-meta">
          <el-tag :type="statusTagMap[item.status]">{{ statusLabels[item.status] }}</el-tag>
          <el-tag :type="typeTagMap[item.knowledgeType] || 'info'">{{ typeLabels[item.knowledgeType] || item.knowledgeType }}</el-tag>
          <el-tag v-if="item.category" type="warning">{{ item.category }}</el-tag>
          <el-tag v-for="tag in item.tags" :key="tag" size="small" style="margin-left: 4px">{{ tag }}</el-tag>
        </div>
      </div>

      <el-card v-if="item.summary" style="margin-bottom: 16px">
        <h4>摘要</h4>
        <p>{{ item.summary }}</p>
      </el-card>

      <el-card v-if="item.question" style="margin-bottom: 16px">
        <h4>问题</h4>
        <p>{{ item.question }}</p>
      </el-card>

      <el-card style="margin-bottom: 16px">
        <h4>内容</h4>
        <div class="md-body" v-html="renderMd(item.content)" />
      </el-card>

      <el-card v-if="hasMetadata" style="margin-bottom: 16px">
        <h4>元数据</h4>
        <pre class="metadata-block">{{ formattedMetadata }}</pre>
      </el-card>

      <el-card v-if="item.media && item.media.length > 0" style="margin-bottom: 16px">
        <h4>附件</h4>
        <div v-for="(m, i) in item.media" :key="i" class="media-item">
          <el-image v-if="m.type === 'image'" :src="sanitizeUrl(m.url)" fit="contain" style="max-height: 200px" />
          <a v-else :href="sanitizeUrl(m.url)" target="_blank" rel="noopener noreferrer">{{ m.url }}</a>
        </div>
      </el-card>

      <el-descriptions border :column="2" style="margin-bottom: 16px">
        <el-descriptions-item label="版本">v{{ item.version }}</el-descriptions-item>
        <el-descriptions-item label="查询次数">{{ item.queryCount }}</el-descriptions-item>
        <el-descriptions-item label="有用">{{ item.helpfulCount }}</el-descriptions-item>
        <el-descriptions-item label="无用">{{ item.unhelpfulCount }}</el-descriptions-item>
        <el-descriptions-item label="创建者">{{ item.createdBy || '-' }}</el-descriptions-item>
        <el-descriptions-item label="审核者">{{ item.verifiedBy || '-' }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ item.createdAt ? new Date(item.createdAt).toLocaleString() : '-' }}</el-descriptions-item>
        <el-descriptions-item label="更新时间">{{ item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '-' }}</el-descriptions-item>
      </el-descriptions>

      <div class="detail-actions">
        <el-button type="primary" @click="openEditDialog">编辑</el-button>
        <el-button v-if="item.status === 'draft'" type="success" @click="handlePublish">发布</el-button>
        <el-button v-if="item.status === 'published'" type="warning" @click="handleArchive">归档</el-button>
        <el-button type="danger" @click="handleDelete">删除</el-button>
        <el-button @click="$router.push('/knowledge')">返回列表</el-button>
      </div>
    </div>

    <el-dialog v-model="showEditDialog" title="编辑知识" width="680px" @closed="resetEditForm">
      <el-form :model="editForm" label-width="80px">
        <el-form-item label="标题" required>
          <el-input v-model="editForm.title" />
        </el-form-item>
        <el-form-item label="摘要">
          <el-input v-model="editForm.summary" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="问题">
          <el-input v-model="editForm.question" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="内容" required>
          <el-input v-model="editForm.content" type="textarea" :rows="8" />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="editForm.tagsInput" placeholder="逗号分隔" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditDialog = false">取消</el-button>
        <el-button type="primary" @click="handleSaveEdit" :loading="saving">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { getKnowledgeItem, updateKnowledge, publishKnowledge, archiveKnowledge, deleteKnowledge, type KnowledgeItem } from '../api/client'

marked.setOptions({ breaks: true, gfm: true })

function renderMd(text: string | null | undefined): string {
  if (!text) return ''
  return DOMPurify.sanitize(marked.parse(text) as string)
}

function sanitizeUrl(url: string | null | undefined): string {
  if (!url) return '#'
  const trimmed = url.trim().toLowerCase()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return url.trim()
  return '#'
}

const route = useRoute()
const router = useRouter()
const item = ref<KnowledgeItem | null>(null)
const loading = ref(true)
const showEditDialog = ref(false)
const saving = ref(false)
const editForm = reactive({
  title: '',
  summary: '',
  question: '',
  content: '',
  tagsInput: '',
})

const statusTagMap: Record<string, string> = { draft: 'info', published: 'success', archived: 'warning' }
const statusLabels: Record<string, string> = { draft: '草稿', published: '已发布', archived: '已归档' }
const typeTagMap: Record<string, string> = {
  faq: '', how_to: 'success', troubleshooting: 'warning', technical: 'success',
  incident: 'danger', runbook: 'info', api_reference: 'info',
}
const typeLabels: Record<string, string> = {
  faq: 'FAQ', how_to: '操作指南', troubleshooting: '排障指南', technical: '技术文档',
  incident: '故障案例', runbook: '内部 SOP', api_reference: 'API 参考',
}

const hasMetadata = computed(() => {
  const meta = item.value?.metadata
  return !!meta && Object.keys(meta).length > 0
})

const formattedMetadata = computed(() => {
  if (!item.value?.metadata) return ''
  return JSON.stringify(item.value.metadata, null, 2)
})

async function fetchItem() {
  loading.value = true
  try {
    item.value = await getKnowledgeItem(route.params.id as string)
  } catch { ElMessage.error('加载失败') }
  finally { loading.value = false }
}

async function handlePublish() {
  await ElMessageBox.confirm('确认发布？')
  await publishKnowledge(item.value!.id)
  ElMessage.success('已发布')
  fetchItem()
}

async function handleArchive() {
  await ElMessageBox.confirm('确认归档？')
  await archiveKnowledge(item.value!.id)
  ElMessage.success('已归档')
  fetchItem()
}

async function handleDelete() {
  await ElMessageBox.confirm('确认删除？不可恢复', '删除', { type: 'warning' })
  await deleteKnowledge(item.value!.id)
  ElMessage.success('已删除')
  router.push('/knowledge')
}

function openEditDialog() {
  if (!item.value) return
  Object.assign(editForm, {
    title: item.value.title,
    summary: item.value.summary ?? '',
    question: item.value.question ?? '',
    content: item.value.content,
    tagsInput: (item.value.tags ?? []).join(', '),
  })
  showEditDialog.value = true
}

function resetEditForm() {
  Object.assign(editForm, { title: '', summary: '', question: '', content: '', tagsInput: '' })
}

async function handleSaveEdit() {
  if (!editForm.title || !editForm.content) {
    ElMessage.warning('标题和内容不能为空')
    return
  }
  saving.value = true
  try {
    await updateKnowledge(item.value!.id, {
      title: editForm.title,
      content: editForm.content,
      summary: editForm.summary || undefined,
      question: editForm.question || undefined,
      tags: editForm.tagsInput ? editForm.tagsInput.split(',').map(t => t.trim()).filter(Boolean) : [],
    })
    ElMessage.success('已保存')
    showEditDialog.value = false
    fetchItem()
  } catch {
    ElMessage.error('保存失败')
  } finally {
    saving.value = false
  }
}

onMounted(fetchItem)
</script>

<style scoped>
.detail-header { margin-bottom: 20px; }
.detail-header h2 { margin: 0 0 8px 0; }
.header-meta { display: flex; gap: 8px; flex-wrap: wrap; }
.detail-actions { margin-top: 20px; }
.media-item { margin: 8px 0; }
.metadata-block {
  margin: 0;
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.5;
}
.md-body { font-size: 14px; line-height: 1.8; color: var(--el-text-color-primary); }
.md-body :deep(h1) { font-size: 22px; font-weight: 700; margin: 20px 0 10px; border-bottom: 2px solid var(--el-color-primary); padding-bottom: 8px; }
.md-body :deep(h2) { font-size: 18px; font-weight: 600; margin: 18px 0 8px; }
.md-body :deep(h3) { font-size: 16px; font-weight: 600; margin: 14px 0 6px; }
.md-body :deep(p) { margin: 8px 0; }
.md-body :deep(ul), .md-body :deep(ol) { padding-left: 22px; margin: 8px 0; }
.md-body :deep(li) { margin: 4px 0; }
.md-body :deep(blockquote) { margin: 12px 0; padding: 10px 16px; border-left: 4px solid var(--el-color-primary); background: var(--el-fill-color-light); border-radius: 0 4px 4px 0; font-style: italic; }
.md-body :deep(code) { background: var(--el-fill-color); padding: 2px 6px; border-radius: 3px; font-size: 13px; color: var(--el-color-danger); }
.md-body :deep(pre) { background: var(--el-fill-color-darker, #1e1e1e); color: var(--el-color-white, #e0e0e0); padding: 14px; border-radius: 6px; font-size: 13px; line-height: 1.6; overflow-x: auto; margin: 10px 0; }
.md-body :deep(pre code) { background: none; color: inherit; padding: 0; }
.md-body :deep(table) { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
.md-body :deep(th), .md-body :deep(td) { border: 1px solid var(--el-border-color); padding: 10px 14px; text-align: left; }
.md-body :deep(th) { background: var(--el-fill-color-light); font-weight: 700; }
.md-body :deep(strong) { font-weight: 700; }
</style>
