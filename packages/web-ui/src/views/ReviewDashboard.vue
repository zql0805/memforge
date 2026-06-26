<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { ElMessage } from 'element-plus'
import {
  getReviews, getReviewStats, getReviewByCommit,
  type ReviewRecord, type ReviewStats,
} from '../api/client'

const loading = ref(false)
const detailVisible = ref(false)
const detailRecord = ref<ReviewRecord | null>(null)
const detailLoading = ref(false)
const stats = ref<ReviewStats | null>(null)
const reviews = ref<ReviewRecord[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const repoFilter = ref('')
const reviewTypeFilter = ref('')

async function loadStats(): Promise<void> {
  try {
    stats.value = await getReviewStats(repoFilter.value || undefined)
  } catch (e) {
    console.error('加载审查统计失败:', e)
    ElMessage.error('加载审查统计失败')
  }
}

async function loadReviews(): Promise<void> {
  loading.value = true
  try {
    const offset = (page.value - 1) * pageSize.value
    const result = await getReviews({
      repoId: repoFilter.value || undefined,
      reviewType: reviewTypeFilter.value || undefined,
      limit: pageSize.value,
      offset,
    })
    reviews.value = result.reviews
    total.value = result.total
  } catch (e) {
    console.error('加载审查记录失败:', e)
    ElMessage.error('加载审查记录失败')
  }
  loading.value = false
}

function handlePageChange(p: number): void {
  page.value = p
  loadReviews()
}

function handleFilter(): void {
  page.value = 1
  loadStats()
  loadReviews()
}

function severityColor(sev: string): string {
  if (sev === 'P0') return '#f56c6c'
  if (sev === 'P1') return '#e6a23c'
  return '#909399'
}

function classificationLabel(c: string): string {
  const map: Record<string, string> = {
    feature: '功能',
    bugfix: 'Bug修复',
    refactor: '重构',
    config: '配置',
    docs: '文档',
    chore: '杂务',
    batch_import: '批量导入',
    merge_request: 'MR审查',
  }
  return map[c] ?? c
}

async function openDetail(row: ReviewRecord): Promise<void> {
  detailVisible.value = true
  detailLoading.value = true
  try {
    detailRecord.value = await getReviewByCommit(row.commit_hash)
  } catch {
    detailRecord.value = row
  }
  detailLoading.value = false
}

const findingsTotal = computed(() => stats.value?.findings?.total_findings ?? 0)

const classificationData = computed(() => {
  if (!stats.value?.byClassification) return []
  return Object.entries(stats.value.byClassification)
    .map(([k, v]) => ({ name: classificationLabel(k), value: v }))
    .sort((a, b) => b.value - a.value)
})

onMounted(() => {
  loadStats()
  loadReviews()
})
</script>

<template>
  <div class="review-dashboard">
    <div class="page-header">
      <h2>代码审查仪表盘</h2>
      <div style="display: flex; gap: 8px; align-items: center">
        <el-select
          v-model="reviewTypeFilter"
          placeholder="审查类型"
          clearable
          style="width: 140px"
          @change="handleFilter"
        >
          <el-option label="Commit" value="commit" />
          <el-option label="MR" value="merge_request" />
        </el-select>
        <el-input
          v-model="repoFilter"
          placeholder="按 repo_id 筛选..."
          clearable
          style="width: 280px"
          @clear="handleFilter"
          @keyup.enter="handleFilter"
        >
          <template #append>
            <el-button @click="handleFilter">筛选</el-button>
          </template>
        </el-input>
      </div>
    </div>

    <!-- 统计卡片 -->
    <el-row :gutter="16" class="stats-row">
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <el-statistic title="审查总数" :value="stats?.total ?? 0">
            <template #prefix><el-icon color="#409eff"><Document /></el-icon></template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card total-findings">
          <el-statistic title="发现总数" :value="findingsTotal">
            <template #prefix><el-icon color="#e6a23c"><Warning /></el-icon></template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="hover" class="stat-card p0-card">
          <el-statistic title="P0 (必修)" :value="stats?.findings?.p0 ?? 0" value-style="color: #f56c6c" />
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="hover" class="stat-card p1-card">
          <el-statistic title="P1 (建议)" :value="stats?.findings?.p1 ?? 0" value-style="color: #e6a23c" />
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="hover" class="stat-card p2-card">
          <el-statistic title="P2 (可选)" :value="stats?.findings?.p2 ?? 0" value-style="color: #909399" />
        </el-card>
      </el-col>
    </el-row>

    <!-- 分类分布 + 近期审查 -->
    <el-row :gutter="16" style="margin-top: 16px">
      <el-col :span="8">
        <el-card>
          <template #header><span>提交类型分布</span></template>
          <div v-if="classificationData.length === 0" class="empty-hint">暂无数据</div>
          <div v-else class="classification-list">
            <div
              v-for="item in classificationData" :key="item.name"
              class="class-item"
            >
              <span class="class-label">{{ item.name }}</span>
              <el-progress
                :percentage="Math.round((item.value / (stats?.total || 1)) * 100)"
                :stroke-width="14"
                :show-text="false"
                style="flex: 1; margin: 0 12px"
              />
              <span class="class-count">{{ item.value }}</span>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="16">
        <el-card>
          <template #header><span>近期审查</span></template>
          <el-table :data="stats?.recent ?? []" stripe size="small">
            <el-table-column label="仓库" width="200">
              <template #default="{ row }">
                <span class="mono">{{ row.repo_id }}</span>
              </template>
            </el-table-column>
            <el-table-column label="Commit" width="100">
              <template #default="{ row }">
                <span class="mono">{{ row.commit_hash?.substring(0, 8) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="分类" width="100">
              <template #default="{ row }">
                <el-tag size="small">{{ classificationLabel(row.classification) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="summary" label="摘要" show-overflow-tooltip />
            <el-table-column label="时间" width="160">
              <template #default="{ row }">
                {{ row.reviewed_at ? new Date(row.reviewed_at).toLocaleString('zh-CN') : '-' }}
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 审查列表 -->
    <el-card style="margin-top: 16px">
      <template #header>
        <div class="card-header">
          <span>全部审查记录</span>
          <el-tag size="small" type="info">共 {{ total }} 条</el-tag>
        </div>
      </template>
      <el-table v-loading="loading" :data="reviews" stripe @row-click="openDetail" style="cursor: pointer">
        <el-table-column label="仓库" width="180">
          <template #default="{ row }">
            <span class="mono">{{ row.repo_id }}</span>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="70">
          <template #default="{ row }">
            <el-tag :type="row.review_type === 'merge_request' ? 'warning' : 'info'" size="small">
              {{ row.review_type === 'merge_request' ? 'MR' : 'Commit' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Commit/MR" width="110">
          <template #default="{ row }">
            <span v-if="row.review_type === 'merge_request' && row.mr_iid" class="mono">
              !{{ row.mr_iid }}
            </span>
            <span v-else class="mono">{{ row.commit_hash?.substring(0, 8) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="作者" prop="author" width="120" />
        <el-table-column label="分类" width="100">
          <template #default="{ row }">
            <el-tag size="small">{{ classificationLabel(row.classification) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="发现" width="200">
          <template #default="{ row }">
            <template v-if="row.findings?.length">
              <el-tag
                v-for="(f, i) in row.findings.slice(0, 3)" :key="i"
                size="small"
                :color="severityColor(f.severity)"
                style="color: #fff; margin: 2px"
              >
                {{ f.severity }}: {{ f.category }}
              </el-tag>
              <span v-if="row.findings.length > 3" class="more-tag">+{{ row.findings.length - 3 }}</span>
            </template>
            <el-tag v-else size="small" type="success">无问题</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="摘要" prop="summary" show-overflow-tooltip />
        <el-table-column label="LLM" width="60">
          <template #default="{ row }">
            <el-tag :type="row.llm_skipped ? 'info' : 'success'" size="small">
              {{ row.llm_skipped ? '跳过' : '✓' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="通知" width="60">
          <template #default="{ row }">
            <el-tag :type="row.notified ? 'success' : 'info'" size="small">
              {{ row.notified ? '已通知' : '-' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="审查时间" width="160">
          <template #default="{ row }">
            {{ row.reviewed_at ? new Date(row.reviewed_at).toLocaleString('zh-CN') : '-' }}
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="page"
          :page-size="pageSize"
          :total="total"
          layout="prev, pager, next, jumper"
          @current-change="handlePageChange"
        />
      </div>
    </el-card>

    <!-- 审查详情对话框 -->
    <el-dialog v-model="detailVisible" title="审查详情" width="80%" top="5vh" destroy-on-close>
      <div v-loading="detailLoading">
        <template v-if="detailRecord">
          <el-descriptions :column="3" border size="small" style="margin-bottom: 16px">
            <el-descriptions-item label="仓库">{{ detailRecord.repo_id }}</el-descriptions-item>
            <el-descriptions-item label="Commit">
              <span class="mono">{{ detailRecord.commit_hash?.substring(0, 12) }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="分支">{{ detailRecord.branch }}</el-descriptions-item>
            <el-descriptions-item label="审查类型">
              <el-tag :type="detailRecord.review_type === 'merge_request' ? 'warning' : 'info'" size="small">
                {{ detailRecord.review_type === 'merge_request' ? 'MR 审查' : 'Commit 审查' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item v-if="detailRecord.mr_url" label="MR 链接">
              <a :href="detailRecord.mr_url" target="_blank" style="color: #409eff">
                !{{ detailRecord.mr_iid }}
              </a>
            </el-descriptions-item>
            <el-descriptions-item label="作者">{{ detailRecord.author }}</el-descriptions-item>
            <el-descriptions-item label="分类">
              <el-tag size="small">{{ classificationLabel(detailRecord.classification) }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="审查时间">
              {{ detailRecord.reviewed_at ? new Date(detailRecord.reviewed_at).toLocaleString('zh-CN') : '-' }}
            </el-descriptions-item>
          </el-descriptions>

          <h4 style="margin: 12px 0 8px">摘要</h4>
          <p style="color: #606266; font-size: 14px">{{ detailRecord.summary }}</p>

          <h4 style="margin: 16px 0 8px">发现列表 ({{ detailRecord.findings?.length ?? 0 }})</h4>
          <el-table :data="detailRecord.findings ?? []" stripe size="small" max-height="400">
            <el-table-column label="级别" width="70">
              <template #default="{ row }">
                <el-tag :color="severityColor(row.severity)" size="small" style="color: #fff">{{ row.severity }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="分类" prop="category" width="120" />
            <el-table-column label="文件" width="260">
              <template #default="{ row }">
                <span class="mono">{{ row.file }}{{ row.line ? ':' + row.line : '' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="问题" prop="description" show-overflow-tooltip />
            <el-table-column label="建议" prop="suggestion" show-overflow-tooltip />
            <el-table-column label="来源" prop="source" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.source === 'llm_review' ? 'warning' : 'info'">
                  {{ row.source === 'llm_review' ? 'LLM' : '规则' }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.review-dashboard { max-width: 1400px; }
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.page-header h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.stats-row { margin-bottom: 0; }
.stat-card { text-align: center; }
.card-header { display: flex; justify-content: space-between; align-items: center; }

.classification-list { display: flex; flex-direction: column; gap: 12px; }
.class-item { display: flex; align-items: center; }
.class-label { min-width: 60px; font-size: 13px; font-weight: 500; }
.class-count { min-width: 30px; text-align: right; font-weight: 700; font-size: 14px; }

.mono { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 12px; }
.more-tag { font-size: 12px; color: #909399; margin-left: 4px; }
.empty-hint { text-align: center; color: #909399; padding: 24px 0; }

.pagination-wrap {
  display: flex;
  justify-content: center;
  margin-top: 16px;
}

@media (max-width: 1200px) {
  .review-dashboard { max-width: 100%; padding: 0 8px; }
  .page-header { flex-direction: column; gap: 8px; align-items: flex-start; }
}

@media (max-width: 768px) {
  .stats-row :deep(.el-col) { flex: 0 0 50%; max-width: 50%; margin-bottom: 8px; }
}
</style>
