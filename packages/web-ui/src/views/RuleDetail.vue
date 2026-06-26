<script setup lang="ts">
// Created by dev on 2026/04/05
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  getRule, voteRule, updateRule, deprecateRule, activateRule,
  type RuleDetailResult,
} from '../api/mcp-tools'
import { useAuthStore } from '../stores/auth'
import type { ElTagType } from '../types/element-plus'

marked.setOptions({ breaks: true, gfm: true })

function renderMd(text: string | null | undefined): string {
  if (!text) return ''
  return DOMPurify.sanitize(marked.parse(text) as string)
}

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const ruleId = route.params.id as string
const loading = ref(false)

const rule = ref<RuleDetailResult['rule'] | null>(null)

const editDialogVisible = ref(false)
const editSubmitting = ref(false)
const editForm = ref({
  title: '', description: '', rationale: '',
  example_good: '', example_bad: '',
  category: '', severity: '', language: '',
})

const voteSubmitting = ref(false)
const voteForm = ref({ vote: 1, comment: '' })

const isEditable = computed(() =>
  rule.value && ['candidate', 'voting', 'active'].includes(rule.value.status),
)

async function loadRule(): Promise<void> {
  if (!authStore.isAuthenticated) return
  loading.value = true
  try {
    const result = await getRule(ruleId)
    if (result.success && result.rule) {
      rule.value = result.rule
    }
  } catch (e) {
    console.error('加载规则详情失败:', e)
    ElMessage.error('加载规则详情失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => loadRule())

function getSeverityType(severity: string): ElTagType {
  const map: Record<string, ElTagType> = { error: 'danger', warning: 'warning', info: 'info' }
  return map[severity] ?? 'info'
}

function getStatusType(status: string): ElTagType {
  const map: Record<string, ElTagType> = { active: 'success', voting: 'warning', candidate: 'info', deprecated: 'danger' }
  return map[status] ?? 'info'
}

async function submitVote(): Promise<void> {
  if (!rule.value) return
  voteSubmitting.value = true
  try {
    const result = await voteRule({
      rule_id: rule.value.id,
      user_id: authStore.userId ?? 'anonymous',
      role: authStore.role ?? 'developer',
      vote: voteForm.value.vote,
      comment: voteForm.value.comment || undefined,
    })
    if (result.success) {
      ElMessage.success(result.message || '投票成功')
      voteForm.value = { vote: 1, comment: '' }
      loadRule()
    } else {
      ElMessage.error(result.message || '投票失败')
    }
  } catch (e) {
    ElMessage.error('投票失败: ' + (e instanceof Error ? e.message : '未知错误'))
  } finally {
    voteSubmitting.value = false
  }
}

function openEditDialog(): void {
  if (!rule.value) return
  editForm.value = {
    title: rule.value.title,
    description: rule.value.description,
    rationale: rule.value.rationale ?? '',
    example_good: rule.value.example_good ?? '',
    example_bad: rule.value.example_bad ?? '',
    category: rule.value.category,
    severity: rule.value.severity,
    language: rule.value.language ?? '',
  }
  editDialogVisible.value = true
}

async function submitEdit(): Promise<void> {
  if (!rule.value) return
  editSubmitting.value = true
  try {
    const updates: Record<string, string> = {}
    const fields = ['title', 'description', 'rationale', 'example_good', 'example_bad', 'category', 'severity', 'language'] as const
    for (const f of fields) {
      const newVal = editForm.value[f]
      if (newVal) updates[f] = newVal
    }
    const result = await updateRule(rule.value.id, updates)
    if (result.success) {
      ElMessage.success(result.message || '更新成功')
      editDialogVisible.value = false
      loadRule()
    } else {
      ElMessage.error(result.message || '更新失败')
    }
  } catch (e) {
    ElMessage.error('更新失败: ' + (e instanceof Error ? e.message : '未知错误'))
  } finally {
    editSubmitting.value = false
  }
}

async function handleDeprecate(): Promise<void> {
  if (!rule.value) return
  try {
    const { value: reason } = await ElMessageBox.prompt(
      `确定废弃规则「${rule.value.title}」？`, '废弃确认',
      { confirmButtonText: '废弃', cancelButtonText: '取消', inputPlaceholder: '请输入废弃理由', type: 'warning' },
    )
    if (!reason) {
      ElMessage.warning('废弃理由不能为空')
      return
    }
    const result = await deprecateRule(rule.value.id, reason)
    if (result.success) {
      ElMessage.success(result.message || '规则已废弃')
      loadRule()
    } else {
      ElMessage.error(result.message || '废弃失败')
    }
  } catch {
    // 用户取消
  }
}

async function handleActivate(): Promise<void> {
  if (!rule.value) return
  const labelMap: Record<string, string> = { deprecated: '重新激活', voting: '强制激活', candidate: '直接激活' }
  const label = labelMap[rule.value.status] ?? '激活'
  try {
    await ElMessageBox.confirm(
      `确定${label}规则「${rule.value.title}」？`, `${label}确认`,
      { confirmButtonText: label, cancelButtonText: '取消', type: 'warning' },
    )
    const result = await activateRule(rule.value.id)
    if (result.success) {
      ElMessage.success(result.message || '规则已激活')
      loadRule()
    } else {
      ElMessage.error(result.message || '激活失败')
    }
  } catch {
    // 用户取消
  }
}

async function handleStartVoting(): Promise<void> {
  if (!rule.value) return
  try {
    await ElMessageBox.confirm(
      `将候选规则「${rule.value.title}」提交投票？`, '提交投票',
      { confirmButtonText: '确认', cancelButtonText: '取消' },
    )
    const result = await voteRule({
      rule_id: rule.value.id,
      user_id: authStore.userId ?? 'anonymous',
      role: 'admin',
      vote: 1,
      comment: '发起投票',
    })
    if (result.success) {
      ElMessage.success('已提交投票')
      loadRule()
    } else {
      ElMessage.error(result.message || '操作失败')
    }
  } catch {
    // 用户取消
  }
}
</script>

<template>
  <div v-loading="loading">
    <el-page-header @back="router.back()">
      <template #content>{{ rule?.title ?? '加载中...' }}</template>
      <template #extra>
        <div v-if="rule" style="display: flex; gap: 8px">
          <el-button v-if="isEditable" type="primary" size="small" @click="openEditDialog">编辑</el-button>
          <el-button v-if="rule.status === 'candidate'" type="warning" size="small" @click="handleStartVoting">发起投票</el-button>
          <el-button v-if="rule.status === 'candidate'" type="success" size="small" @click="handleActivate">直接激活</el-button>
          <el-button v-if="rule.status === 'voting'" type="success" size="small" @click="handleActivate">强制激活</el-button>
          <el-button v-if="rule.status === 'deprecated'" type="success" size="small" @click="handleActivate">重新激活</el-button>
          <el-button v-if="rule.status === 'active'" type="danger" size="small" @click="handleDeprecate">废弃</el-button>
        </div>
      </template>
    </el-page-header>

    <el-empty v-if="!loading && !rule" description="规则不存在或加载失败" />

    <template v-if="rule">
      <el-row :gutter="20" style="margin-top: 20px">
        <el-col :span="16">
          <!-- 基本属性 -->
          <el-card>
            <template #header>基本信息</template>
            <div class="tag-bar">
              <el-tag :type="getStatusType(rule.status)">{{ rule.status }}</el-tag>
              <el-tag :type="getSeverityType(rule.severity)">{{ rule.severity }}</el-tag>
              <el-tag type="info">{{ rule.ruleType ?? 'coding' }}</el-tag>
              <el-tag type="info">{{ rule.category }}</el-tag>
              <el-tag v-if="rule.language" type="info">{{ rule.language }}</el-tag>
              <el-tag v-else>通用</el-tag>
            </div>
          </el-card>

          <!-- 规则正文 -->
          <el-card style="margin-top: 16px">
            <template #header>规则描述</template>
            <div class="md-body" v-html="renderMd(rule.description)" />
          </el-card>

          <!-- 理由 -->
          <el-card v-if="rule.rationale" style="margin-top: 16px">
            <template #header>制定理由</template>
            <div class="md-body" v-html="renderMd(rule.rationale)" />
          </el-card>

          <!-- 正反示例 -->
          <el-card v-if="rule.example_good || rule.example_bad" style="margin-top: 16px">
            <template #header>示例对比</template>
            <el-row :gutter="16">
              <el-col v-if="rule.example_good" :span="rule.example_bad ? 12 : 24">
                <div class="example-label good-label">正确做法</div>
                <div class="example-block good" v-html="renderMd(rule.example_good)" />
              </el-col>
              <el-col v-if="rule.example_bad" :span="rule.example_good ? 12 : 24">
                <div class="example-label bad-label">反模式</div>
                <div class="example-block bad" v-html="renderMd(rule.example_bad)" />
              </el-col>
            </el-row>
          </el-card>

          <!-- 投票面板 -->
          <el-card v-if="rule.status === 'voting'" style="margin-top: 16px">
            <template #header>
              <span style="color: #e6a23c; font-weight: bold">参与投票</span>
            </template>
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
              <el-form-item>
                <el-button type="primary" :loading="voteSubmitting" @click="submitVote">提交投票</el-button>
              </el-form-item>
            </el-form>
          </el-card>

          <el-card v-if="rule.voting?.votes && rule.voting.votes.length > 0" style="margin-top: 16px">
            <template #header>投票记录</template>
            <el-table :data="rule.voting.votes" size="small" stripe>
              <el-table-column prop="userId" label="投票人" width="120" />
              <el-table-column label="投票" width="80">
                <template #default="{ row }">
                  <el-tag :type="row.vote === 'approve' ? 'success' : row.vote === 'reject' ? 'danger' : 'info'" size="small">
                    {{ row.vote === 'approve' ? '赞成' : row.vote === 'reject' ? '反对' : '弃权' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="role" label="角色" width="100" />
              <el-table-column prop="comment" label="评论" />
            </el-table>
          </el-card>
        </el-col>

        <el-col :span="8">
          <el-card>
            <template #header>效果统计</template>
            <el-statistic title="应用次数" :value="rule.metrics?.appliedCount ?? 0" style="margin-bottom: 16px" />
            <el-statistic title="违反次数" :value="rule.metrics?.violatedCount ?? 0" style="margin-bottom: 16px" />
            <el-divider />
            <p v-if="rule.metrics?.adoptionRate != null">
              采纳率: <strong>{{ (rule.metrics.adoptionRate * 100).toFixed(1) }}%</strong>
            </p>
            <p v-else style="color: #909399">暂无采纳数据</p>
          </el-card>

          <el-card style="margin-top: 16px">
            <template #header>元信息</template>
            <div class="meta-list">
              <div class="meta-item">
                <span class="meta-label">规则 ID</span>
                <span class="meta-value" style="font-size: 11px; word-break: break-all">{{ rule.id }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">来源</span>
                <span class="meta-value">{{ rule.source ?? '-' }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">创建时间</span>
                <span class="meta-value">{{ rule.createdAt ? new Date(rule.createdAt).toLocaleString() : '-' }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">项目</span>
                <span class="meta-value">{{ rule.projectId ?? '-' }}</span>
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>

      <!-- 编辑对话框 -->
      <el-dialog v-model="editDialogVisible" title="编辑规则" width="700px" destroy-on-close>
        <el-form label-position="top">
          <el-form-item label="标题">
            <el-input v-model="editForm.title" />
          </el-form-item>
          <el-row :gutter="16">
            <el-col :span="8">
              <el-form-item label="分类">
                <el-select v-model="editForm.category" style="width: 100%">
                  <el-option v-for="c in ['security','performance','style','logic','convention','architecture']" :key="c" :label="c" :value="c" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="严重级别">
                <el-select v-model="editForm.severity" style="width: 100%">
                  <el-option v-for="s in ['error','warning','info']" :key="s" :label="s" :value="s" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="语言">
                <el-input v-model="editForm.language" placeholder="留空为通用" />
              </el-form-item>
            </el-col>
          </el-row>
          <el-form-item label="描述">
            <el-input v-model="editForm.description" type="textarea" :rows="3" />
          </el-form-item>
          <el-form-item label="理由">
            <el-input v-model="editForm.rationale" type="textarea" :rows="2" />
          </el-form-item>
          <el-row :gutter="16">
            <el-col :span="12">
              <el-form-item label="正确示例">
                <el-input v-model="editForm.example_good" type="textarea" :rows="3" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="错误示例">
                <el-input v-model="editForm.example_bad" type="textarea" :rows="3" />
              </el-form-item>
            </el-col>
          </el-row>
        </el-form>
        <template #footer>
          <el-button @click="editDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="editSubmitting" @click="submitEdit">保存</el-button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>

<style scoped>
.tag-bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* Markdown 正文 — 使用 Element Plus CSS 变量适配深色/浅色模式 */
.md-body {
  font-size: 14px;
  line-height: 1.8;
  color: var(--el-text-color-primary);
}
.md-body :deep(h1) { font-size: 22px; font-weight: 700; margin: 20px 0 10px; border-bottom: 2px solid var(--el-color-primary); padding-bottom: 8px; color: var(--el-text-color-primary); }
.md-body :deep(h2) { font-size: 18px; font-weight: 600; margin: 18px 0 8px; color: var(--el-text-color-primary); }
.md-body :deep(h3) { font-size: 16px; font-weight: 600; margin: 14px 0 6px; color: var(--el-text-color-primary); }
.md-body :deep(p) { margin: 8px 0; color: var(--el-text-color-primary); }
.md-body :deep(ul), .md-body :deep(ol) { padding-left: 22px; margin: 8px 0; }
.md-body :deep(li) { margin: 4px 0; color: var(--el-text-color-primary); }
.md-body :deep(blockquote) {
  margin: 12px 0;
  padding: 10px 16px;
  border-left: 4px solid var(--el-color-primary);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  border-radius: 0 4px 4px 0;
  font-style: italic;
}
.md-body :deep(code) {
  background: var(--el-fill-color);
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 13px;
  color: var(--el-color-danger);
  font-weight: 500;
}
.md-body :deep(pre) {
  background: var(--el-fill-color-darker, #1e1e1e);
  color: var(--el-color-white, #e0e0e0);
  padding: 14px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
  overflow-x: auto;
  margin: 10px 0;
}
.md-body :deep(pre code) {
  background: none;
  color: inherit;
  padding: 0;
  font-weight: normal;
}
.md-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
  font-size: 13px;
}
.md-body :deep(th), .md-body :deep(td) {
  border: 1px solid var(--el-border-color);
  padding: 10px 14px;
  text-align: left;
  color: var(--el-text-color-primary);
}
.md-body :deep(th) {
  background: var(--el-fill-color-light);
  font-weight: 700;
  color: var(--el-text-color-primary);
}
.md-body :deep(tr:nth-child(even)) { background: var(--el-fill-color-lighter); }
.md-body :deep(strong) { color: var(--el-text-color-primary); font-weight: 700; }
.md-body :deep(hr) { border: none; border-top: 2px solid var(--el-border-color-light); margin: 20px 0; }

/* 示例区块 */
.example-label {
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 8px;
  padding: 5px 12px;
  border-radius: 4px;
  display: inline-block;
}
.good-label { color: var(--el-color-success); background: var(--el-color-success-light-9); }
.bad-label { color: var(--el-color-danger); background: var(--el-color-danger-light-9); }

.example-block {
  padding: 14px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-primary);
}
.example-block.good {
  border-left: 4px solid var(--el-color-success);
  background: var(--el-color-success-light-9);
}
.example-block.bad {
  border-left: 4px solid var(--el-color-danger);
  background: var(--el-color-danger-light-9);
}
.example-block :deep(p) { margin: 5px 0; color: var(--el-text-color-primary); }

/* 元信息 */
.meta-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.meta-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.meta-value {
  font-size: 13px;
  color: var(--el-text-color-primary);
}
</style>
