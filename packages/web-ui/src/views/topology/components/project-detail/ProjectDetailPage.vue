<script setup lang="ts">
// Created by dev on 2026/05/09
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { Download } from '@element-plus/icons-vue'
import {
  getProjectProfile,
  getProjectTimeline,
  getProjectChangelog,
  getBootstrapStatus,
  triggerBootstrap,
  type ProjectProfile,
  type TimelineEvent,
  type ChangelogEntry,
  type BootstrapStatus,
} from '../../../../api/client'
import type { ElTagType } from '../../../../types/element-plus'

const route = useRoute()
const router = useRouter()

const productLine = computed(() => route.params.productLine as string)
const repoId = computed(() => {
  const parts = route.params.repoId
  return Array.isArray(parts) ? parts.join('/') : (parts as string)
})

const loading = ref(false)
const activeTab = ref('overview')
const profile = ref<ProjectProfile | null>(null)
const timeline = ref<TimelineEvent[]>([])
const changelog = ref<ChangelogEntry[]>([])
const bootstrapStatus = ref<BootstrapStatus | null>(null)
const bootstrapLoading = ref(false)
const bootstrapDialogVisible = ref(false)
const bootstrapForm = ref({ projectRoot: '', depth: '6months' })

function getCategoryTagType(cat: string): ElTagType | undefined {
  const map: Record<string, ElTagType | undefined> = {
    feature: 'success', bugfix: 'danger', refactor: 'warning',
    migration: 'warning', security: 'danger', performance: undefined,
    docs: 'info', infra: 'info', notable: undefined, chore: 'info',
    test: 'info', style: 'info',
  }
  return map[cat] ?? 'info'
}

const hasGitData = computed(() => {
  return (profile.value?.totalCommits ?? 0) > 0 || bootstrapStatus.value?.storedMemories
})

async function loadData() {
  if (!productLine.value || !repoId.value) return
  loading.value = true
  try {
    const [p, t, c, bs] = await Promise.all([
      getProjectProfile(productLine.value, repoId.value),
      getProjectTimeline(productLine.value, repoId.value),
      getProjectChangelog(productLine.value, repoId.value),
      getBootstrapStatus(productLine.value, repoId.value).catch(() => null),
    ])
    profile.value = p
    timeline.value = t
    changelog.value = c
    bootstrapStatus.value = bs
  } catch (err) {
    console.error('加载项目详情失败', err)
    ElMessage.error('加载项目详情失败')
  } finally {
    loading.value = false
  }
}

function openBootstrapDialog() {
  bootstrapForm.value = { projectRoot: '', depth: '6months' }
  bootstrapDialogVisible.value = true
}

async function handleBootstrap() {
  const root = bootstrapForm.value.projectRoot.trim()
  if (!root) { ElMessage.warning('请输入项目本地路径'); return }
  bootstrapLoading.value = true
  try {
    await triggerBootstrap(productLine.value, repoId.value, root, bootstrapForm.value.depth)
    ElMessage.success('历史导入任务已启动，请稍后刷新查看进度')
    bootstrapDialogVisible.value = false
    setTimeout(() => loadData(), 3000)
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { message?: string } } }
    const msg = axiosErr.response?.data?.message ?? '导入失败'
    ElMessage.error(msg)
  } finally {
    bootstrapLoading.value = false
  }
}

function goBack() {
  router.push({ name: 'Topology' })
}

function formatDate(d: string | null | undefined): string {
  if (!d) return '-'
  return new Date(d).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function formatRelative(d: string | null | undefined): string {
  if (!d) return '-'
  const diff = Date.now() - new Date(d).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return '今天'
  if (days < 30) return `${days} 天前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

const techStackColor = computed(() => {
  const map: Record<string, string> = {
    java: '#3B82F6', php: '#8B5CF6', vue: '#10B981',
    node: '#84CC16', flutter: '#06B6D4', swift: '#F97316',
    android: '#A3E635', python: '#FBBF24', go: '#00ADD8',
  }
  const ts = profile.value?.techStack?.toLowerCase() ?? ''
  return map[ts] ?? '#6B7280'
})

onMounted(loadData)
watch([productLine, repoId], loadData)
</script>

<template>
  <div class="project-detail-page">
    <div class="page-header">
      <el-button :icon="ArrowLeft" text @click="goBack">返回拓扑</el-button>
      <div class="header-title" v-if="profile">
        <span class="tech-badge" :style="{ backgroundColor: techStackColor }">
          {{ profile.techStack?.toUpperCase() ?? '?' }}
        </span>
        <h2>{{ profile.displayName }}</h2>
        <el-tag size="small" type="info">{{ repoId }}</el-tag>
      </div>
      <el-button :icon="Refresh" text :loading="loading" @click="loadData" />
    </div>

    <el-skeleton :loading="loading && !profile" animated :rows="12" />

    <el-tabs v-if="profile" v-model="activeTab" class="detail-tabs">
      <!-- 概览 Tab -->
      <el-tab-pane label="概览" name="overview">
        <!-- Git 历史导入状态卡片 -->
        <el-card v-if="!hasGitData" shadow="never" class="bootstrap-card">
          <div class="bootstrap-content">
            <el-icon :size="36" color="#E5E7EB"><Download /></el-icon>
            <div class="bootstrap-text">
              <h4>Git 历史尚未导入</h4>
              <p>导入项目 Git 提交历史，生成项目画像、变更日志和时间线。支持断点续传。</p>
            </div>
            <el-button type="primary" @click="openBootstrapDialog">导入 Git 历史</el-button>
          </div>
        </el-card>

        <el-card v-else-if="bootstrapStatus" shadow="never" class="bootstrap-card bootstrap-done">
          <div class="bootstrap-content">
            <div class="bootstrap-text" style="flex:1">
              <h4>Git 历史已导入</h4>
              <div class="bootstrap-meta">
                <span>总提交: {{ bootstrapStatus.totalCommits }}</span>
                <span>已处理: {{ bootstrapStatus.processedCommits }}</span>
                <span>存入记忆: {{ bootstrapStatus.storedMemories }}</span>
                <span v-if="bootstrapStatus.lastRunAt">上次: {{ formatRelative(bootstrapStatus.lastRunAt) }}</span>
              </div>
            </div>
            <el-button text size="small" @click="openBootstrapDialog">重新导入</el-button>
          </div>
        </el-card>

        <div class="overview-grid">
          <el-card shadow="never" class="stat-card">
            <template #header><span>基本信息</span></template>
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="技术栈">{{ profile.techStack }}</el-descriptions-item>
              <el-descriptions-item label="默认分支">{{ profile.defaultBranch ?? 'main' }}</el-descriptions-item>
              <el-descriptions-item label="首次提交">{{ formatDate(profile.firstCommitAt) }}</el-descriptions-item>
              <el-descriptions-item label="最近提交">{{ formatRelative(profile.lastCommitAt) }}</el-descriptions-item>
              <el-descriptions-item label="总提交数">{{ profile.totalCommits?.toLocaleString() ?? '-' }}</el-descriptions-item>
              <el-descriptions-item label="落后远程">
                <el-tag v-if="(profile.localBehindCount ?? 0) > 0" type="warning" size="small">
                  {{ profile.localBehindCount }} 个提交
                </el-tag>
                <el-tag v-else type="success" size="small">最新</el-tag>
              </el-descriptions-item>
            </el-descriptions>
            <p v-if="profile.description" class="description-text">{{ profile.description }}</p>
          </el-card>

          <el-card shadow="never" class="stat-card">
            <template #header><span>活跃度</span></template>
            <div class="activity-stats">
              <div class="stat-item">
                <div class="stat-number">{{ profile.commitsLast7d ?? 0 }}</div>
                <div class="stat-label">7 天提交</div>
              </div>
              <div class="stat-item">
                <div class="stat-number">{{ profile.commitsLast30d ?? 0 }}</div>
                <div class="stat-label">30 天提交</div>
              </div>
              <div class="stat-item">
                <div class="stat-number">{{ profile.activeContributors7d ?? 0 }}</div>
                <div class="stat-label">7 天贡献者</div>
              </div>
              <div class="stat-item">
                <div class="stat-number">{{ profile.activeContributors30d ?? 0 }}</div>
                <div class="stat-label">30 天贡献者</div>
              </div>
            </div>
          </el-card>

          <el-card shadow="never" class="stat-card" v-if="profile.topContributors?.length">
            <template #header><span>贡献者排行</span></template>
            <div v-for="(c, i) in profile.topContributors.slice(0, 5)" :key="i" class="contributor-row">
              <span class="rank">{{ i + 1 }}</span>
              <span class="name">{{ c.name }}</span>
              <el-progress
                :percentage="Math.round((c.commits / ((profile.topContributors ?? [])[0]?.commits || 1)) * 100)"
                :show-text="false"
                :stroke-width="8"
                style="flex: 1; margin: 0 12px"
              />
              <span class="commits">{{ c.commits }}</span>
            </div>
          </el-card>

          <el-card shadow="never" class="stat-card" v-if="profile.hotFiles30d?.length">
            <template #header><span>变更热力 Top 10</span></template>
            <div v-for="(f, i) in profile.hotFiles30d.slice(0, 10)" :key="i" class="hotfile-row">
              <span class="rank">{{ i + 1 }}</span>
              <span class="filepath" :title="f.file">{{ f.file }}</span>
              <el-tag size="small" type="danger" round>{{ f.count }}次</el-tag>
            </div>
          </el-card>
        </div>
      </el-tab-pane>

      <!-- 时间线 Tab -->
      <el-tab-pane label="时间线" name="timeline">
        <el-empty v-if="timeline.length === 0" description="暂无关键事件数据" />
        <el-timeline v-else>
          <el-timeline-item
            v-for="event in timeline"
            :key="event.id"
            :timestamp="formatDate(event.date)"
            placement="top"
            :type="event.category === 'security' ? 'danger' : event.category === 'migration' ? 'warning' : 'primary'"
          >
            <el-card shadow="never" class="timeline-card">
              <div class="timeline-header">
                <el-tag size="small" :type="getCategoryTagType(event.category)">{{ event.category }}</el-tag>
                <span class="timeline-author">{{ event.author }}</span>
              </div>
              <h4>{{ event.title }}</h4>
              <p class="timeline-content">{{ event.content }}</p>
            </el-card>
          </el-timeline-item>
        </el-timeline>
      </el-tab-pane>

      <!-- 变更日志 Tab -->
      <el-tab-pane label="变更日志" name="changelog">
        <el-empty v-if="changelog.length === 0" description="暂无提交记录" />
        <el-table v-else :data="changelog" stripe size="small" style="width: 100%">
          <el-table-column prop="category" label="类型" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="getCategoryTagType(row.category)">{{ row.category }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="title" label="提交" min-width="300" show-overflow-tooltip />
          <el-table-column prop="author" label="作者" width="100" />
          <el-table-column label="变更" width="120">
            <template #default="{ row }">
              <span style="color: #10B981">+{{ row.insertions }}</span>
              <span style="color: #EF4444; margin-left: 4px">-{{ row.deletions }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="filesChanged" label="文件数" width="70" />
          <el-table-column label="日期" width="100">
            <template #default="{ row }">{{ formatDate(row.date) }}</template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- Bootstrap 弹窗 -->
    <el-dialog v-model="bootstrapDialogVisible" title="导入 Git 历史" width="480px">
      <el-form label-width="100px">
        <el-form-item label="项目路径">
          <el-input v-model="bootstrapForm.projectRoot" placeholder="项目的绝对路径，如 /path/to/your-project" />
          <div style="font-size:12px; color:#9CA3AF; margin-top:4px">服务端可访问的 Git 仓库路径</div>
        </el-form-item>
        <el-form-item label="分析深度">
          <el-radio-group v-model="bootstrapForm.depth">
            <el-radio value="6months">近 6 个月</el-radio>
            <el-radio value="1year">近 1 年</el-radio>
            <el-radio value="full">全量</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bootstrapDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="bootstrapLoading" @click="handleBootstrap">开始导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>


<style scoped>
.project-detail-page {
  padding: 20px 24px;
  max-width: 1200px;
  margin: 0 auto;
}
.page-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}
.header-title {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
}
.header-title h2 { margin: 0; font-size: 20px; }
.tech-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 8px;
  border-radius: 4px;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
}
.detail-tabs { margin-top: 8px; }

.overview-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}
.stat-card { border-radius: 8px; }
.description-text {
  margin-top: 12px;
  color: #6B7280;
  font-size: 13px;
  line-height: 1.6;
}
.activity-stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  text-align: center;
}
.stat-item .stat-number {
  font-size: 28px;
  font-weight: 700;
  color: #1D4ED8;
}
.stat-item .stat-label {
  font-size: 12px;
  color: #9CA3AF;
  margin-top: 4px;
}
.contributor-row {
  display: flex;
  align-items: center;
  padding: 6px 0;
}
.contributor-row .rank {
  width: 20px;
  text-align: center;
  font-weight: 600;
  color: #9CA3AF;
}
.contributor-row .name {
  width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.contributor-row .commits {
  font-size: 13px;
  color: #6B7280;
  width: 40px;
  text-align: right;
}
.hotfile-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.hotfile-row .rank {
  width: 20px;
  text-align: center;
  font-weight: 600;
  color: #9CA3AF;
  font-size: 12px;
}
.hotfile-row .filepath {
  flex: 1;
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timeline-card { margin: 0; }
.timeline-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.timeline-author { font-size: 12px; color: #9CA3AF; }
.timeline-content {
  font-size: 13px;
  color: #6B7280;
  margin-top: 4px;
  line-height: 1.5;
}

.bootstrap-card {
  margin-bottom: 16px;
  border-radius: 8px;
  border: 1px dashed #D1D5DB;
}
.bootstrap-card.bootstrap-done {
  border-style: solid;
  border-color: #E5E7EB;
}
.bootstrap-content {
  display: flex;
  align-items: center;
  gap: 16px;
}
.bootstrap-text h4 {
  margin: 0 0 4px;
  font-size: 15px;
}
.bootstrap-text p {
  margin: 0;
  font-size: 13px;
  color: #6B7280;
}
.bootstrap-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: #9CA3AF;
}
@media (max-width: 768px) {
  .overview-grid { grid-template-columns: 1fr; }
}
</style>
