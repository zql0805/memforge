<template>
  <div class="profile-page">
    <!-- 概览统计 -->
    <el-row :gutter="16" class="stats-row">
      <el-col :span="4">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-value">{{ profile?.overview.totalMemories ?? '-' }}</div>
          <div class="stat-label">知识记忆</div>
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-value">{{ profile?.overview.totalRules ?? '-' }}</div>
          <div class="stat-label">编码规则</div>
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-value">{{ profile?.overview.totalRelations ?? '-' }}</div>
          <div class="stat-label">知识关联</div>
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-value">{{ profile?.overview.totalWorkContexts ?? '-' }}</div>
          <div class="stat-label">工作追踪</div>
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-value">{{ domainCount }}</div>
          <div class="stat-label">知识领域</div>
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-value">{{ techCount }}</div>
          <div class="stat-label">技术栈覆盖</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" style="margin-top: 16px">
      <!-- 知识领域分布 -->
      <el-col :span="12">
        <el-card v-loading="loading">
          <template #header>
            <div class="card-header">
              <span>知识领域分布</span>
              <el-button text type="primary" :loading="loading" @click="loadProfile">
                <el-icon><Refresh /></el-icon>
              </el-button>
            </div>
          </template>
          <div v-if="profile && profile.knowledgeDomains.length > 0" class="domain-bars">
            <div v-for="d in profile.knowledgeDomains" :key="d.scope" class="domain-bar">
              <span class="domain-label">{{ scopeLabel(d.scope) }}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  :style="{ width: domainPercent(d.count) + '%', background: scopeColor(d.scope) }"
                />
              </div>
              <span class="bar-count">{{ d.count }}</span>
            </div>
          </div>
          <el-empty v-else-if="!loading" description="暂无知识记忆。使用 AI 对话积累经验、规范和架构决策。" />
        </el-card>
      </el-col>

      <!-- 技术栈覆盖 -->
      <el-col :span="12">
        <el-card v-loading="loading">
          <template #header>
            <span>技术栈 &amp; 关键词</span>
          </template>
          <div v-if="profile && profile.techStack.length > 0" class="tag-cloud">
            <el-tag
              v-for="t in profile.techStack.slice(0, 25)"
              :key="t.tag"
              :size="tagSize(t.count)"
              :type="tagType(t.tag)"
              effect="plain"
              class="tech-tag"
            >
              {{ t.tag }}
              <span class="tag-count">{{ t.count }}</span>
            </el-tag>
          </div>
          <el-empty v-else-if="!loading" description="暂无技术栈数据" />
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" style="margin-top: 16px">
      <!-- 月度活动趋势 -->
      <el-col :span="12">
        <el-card v-loading="loading">
          <template #header>
            <span>月度活动趋势</span>
          </template>
          <div v-if="profile && profile.monthlyActivity.length > 0" class="activity-chart">
            <div class="chart-bars">
              <div
                v-for="m in profile.monthlyActivity"
                :key="m.month"
                class="chart-col"
              >
                <div class="chart-bar-wrapper">
                  <div
                    class="chart-bar"
                    :style="{ height: activityPercent(m.count) + '%' }"
                    :title="`${m.month}: ${m.count} 条记忆`"
                  />
                </div>
                <span class="chart-label">{{ m.month.slice(5) }}</span>
              </div>
            </div>
          </div>
          <el-empty v-else-if="!loading" description="暂无活动数据" />
        </el-card>
      </el-col>

      <!-- 优势与改进 -->
      <el-col :span="12">
        <el-card v-loading="loading">
          <template #header>
            <span>能力评估</span>
          </template>
          <div v-if="profile" class="assessment">
            <div v-if="profile.strengths.length > 0" class="assess-section">
              <h4 class="assess-title strength-title">优势</h4>
              <div v-for="(s, i) in profile.strengths" :key="'s'+i" class="assess-item strength-item">
                <el-icon color="#67c23a"><CircleCheckFilled /></el-icon>
                <span>{{ s }}</span>
              </div>
            </div>
            <div v-if="profile.improvements.length > 0" class="assess-section" style="margin-top: 16px">
              <h4 class="assess-title improve-title">提升方向</h4>
              <div v-for="(imp, i) in profile.improvements" :key="'i'+i" class="assess-item improve-item">
                <el-icon color="#e6a23c"><WarningFilled /></el-icon>
                <span>{{ imp }}</span>
              </div>
            </div>
            <el-empty v-if="profile.strengths.length === 0 && profile.improvements.length === 0" description="数据不足，无法生成评估" />
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 工作模式 -->
    <el-card v-if="profile && profile.workPatterns.length > 0" style="margin-top: 16px" v-loading="loading">
      <template #header>
        <span>工作模式统计</span>
      </template>
      <el-table :data="profile.workPatterns" stripe size="small">
        <el-table-column label="类型" width="140">
          <template #default="{ row }">
            <el-tag size="small" :type="workTypeTag(row.work_type)">{{ workTypeLabel(row.work_type) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTag(row.status)" effect="plain">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="count" label="次数" width="80" />
        <el-table-column label="平均耗时" width="120">
          <template #default="{ row }">
            {{ row.avg_hours != null ? row.avg_hours + 'h' : '-' }}
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
// Created by dev on 2026/04/07
import { ref, computed, onMounted } from 'vue'
import { getDeveloperProfile, type DeveloperProfileResult } from '../api/mcp-tools'
import { useAuthStore } from '../stores/auth'
import { useProjectContext } from '../stores/project-context'
import { Refresh, CircleCheckFilled, WarningFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

const authStore = useAuthStore()
const projectCtx = useProjectContext()
const loading = ref(false)
const profile = ref<DeveloperProfileResult | null>(null)

const domainCount = computed(() => profile.value?.knowledgeDomains.length ?? 0)
const techCount = computed(() => profile.value?.techStack.length ?? 0)

const maxDomainCount = computed(() => {
  if (!profile.value?.knowledgeDomains.length) return 1
  return Math.max(...profile.value.knowledgeDomains.map(d => d.count))
})

const maxActivityCount = computed(() => {
  if (!profile.value?.monthlyActivity.length) return 1
  return Math.max(...profile.value.monthlyActivity.map(m => m.count))
})

function domainPercent(count: number): number {
  return Math.round((count / maxDomainCount.value) * 100)
}

function activityPercent(count: number): number {
  return Math.max(5, Math.round((count / maxActivityCount.value) * 100))
}

const SCOPE_LABELS: Record<string, string> = {
  architecture: '系统架构',
  domain_knowledge: '业务知识',
  bug_pattern: 'Bug 模式',
  coding_standard: '编码规范',
  performance_insight: '性能优化',
  lesson_learned: '经验教训',
  convention: '团队约定',
  tool_usage: '工具使用',
  review_insight: '审查洞察',
}

const SCOPE_COLORS: Record<string, string> = {
  architecture: '#409eff',
  domain_knowledge: '#67c23a',
  bug_pattern: '#f56c6c',
  coding_standard: '#e6a23c',
  performance_insight: '#9b59b6',
  lesson_learned: '#3498db',
  convention: '#1abc9c',
  tool_usage: '#95a5a6',
  review_insight: '#e67e22',
}

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope
}
function scopeColor(scope: string): string {
  return SCOPE_COLORS[scope] ?? '#909399'
}

function tagSize(count: number): 'large' | 'default' | 'small' {
  if (count >= 20) return 'large'
  if (count >= 5) return 'default'
  return 'small'
}

function tagType(tag: string): '' | 'success' | 'warning' | 'danger' | 'info' {
  const techTags = ['java', 'php', 'vue', 'typescript', 'go', 'python', 'kotlin', 'swift', 'flutter']
  if (techTags.some(t => tag.toLowerCase().includes(t))) return 'success'
  if (tag.includes('redis') || tag.includes('mysql') || tag.includes('kafka')) return 'warning'
  if (tag.includes('security') || tag.includes('bug')) return 'danger'
  return ''
}

function workTypeLabel(type: string): string {
  const map: Record<string, string> = {
    requirement: '需求开发',
    bug_fix: 'Bug 修复',
    refactor: '重构',
    investigation: '调研',
    learning: '学习',
  }
  return map[type] ?? type
}

function workTypeTag(type: string): '' | 'success' | 'warning' | 'danger' | 'info' {
  const map: Record<string, '' | 'success' | 'warning' | 'danger' | 'info'> = {
    requirement: '',
    bug_fix: 'danger',
    refactor: 'warning',
    investigation: 'info',
    learning: 'success',
  }
  return map[type] ?? 'info'
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    completed: '已完成',
    in_progress: '进行中',
    cancelled: '已取消',
    deferred: '已延期',
  }
  return map[status] ?? status
}

function statusTag(status: string): '' | 'success' | 'warning' | 'danger' | 'info' {
  const map: Record<string, '' | 'success' | 'warning' | 'danger' | 'info'> = {
    completed: 'success',
    in_progress: '',
    cancelled: 'info',
    deferred: 'warning',
  }
  return map[status] ?? 'info'
}

async function loadProfile(): Promise<void> {
  if (!authStore.isAuthenticated) return
  loading.value = true
  try {
    const result = await getDeveloperProfile(projectCtx.selectedProductLine || undefined)
    if (result.success) {
      profile.value = result
    }
  } catch (err) {
    ElMessage.error(`加载开发者画像失败: ${(err as Error).message}`)
  } finally {
    loading.value = false
  }
}

onMounted(() => loadProfile())
</script>

<style scoped>
.stats-row .stat-card {
  text-align: center;
  padding: 8px 0;
}
.stat-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--mf-text-primary, #e0e6ed);
  line-height: 1.2;
}
.stat-label {
  font-size: 12px;
  color: var(--mf-text-muted, #5a6170);
  margin-top: 4px;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* 知识领域 */
.domain-bars { padding: 4px 0; }
.domain-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.domain-label {
  width: 80px;
  text-align: right;
  font-size: 13px;
  color: var(--mf-text-secondary, #8e949e);
  flex-shrink: 0;
}
.bar-track {
  flex: 1;
  height: 20px;
  background: var(--mf-bg-elevated, #2a2f36);
  border-radius: 10px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 10px;
  min-width: 4px;
}
.bar-count {
  width: 36px;
  font-size: 13px;
  color: var(--mf-text-muted, #5a6170);
  flex-shrink: 0;
}

/* 技术栈标签云 */
.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 0;
}
.tech-tag {
  cursor: default;
}
.tag-count {
  margin-left: 4px;
  opacity: 0.6;
  font-size: 11px;
}

/* 月度活动 */
.activity-chart { padding: 8px 0; }
.chart-bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 160px;
}
.chart-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
}
.chart-bar-wrapper {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.chart-bar {
  width: 70%;
  max-width: 30px;
  background: linear-gradient(180deg, #409eff, #79bbff);
  border-radius: 4px 4px 0 0;
  cursor: pointer;
}
.chart-bar:hover {
  background: linear-gradient(180deg, #337ecc, #409eff);
}
.chart-label {
  font-size: 11px;
  color: var(--mf-text-muted, #5a6170);
  margin-top: 4px;
}

/* 能力评估 */
.assessment { padding: 4px 0; }
.assess-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 10px 0;
}
.strength-title { color: #67c23a; }
.improve-title { color: #e6a23c; }
.assess-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--mf-text-secondary, #8e949e);
  line-height: 1.5;
}
.assess-item .el-icon {
  margin-top: 2px;
  flex-shrink: 0;
}
</style>
