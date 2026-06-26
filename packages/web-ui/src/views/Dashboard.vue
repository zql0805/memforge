<script setup lang="ts">
// Created by dev on 2026/04/05
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { listMemories, measureRules, listRules } from '../api/mcp-tools'
import {
  getTopologyProductLines, getTopology,
  getProductLineGitStats, getProductLineHealthAlerts,
  type ProjectGitStatsApi, type HealthAlert,
} from '../api/client'
import { useAuthStore } from '../stores/auth'
import { useProjectContext } from '../stores/project-context'
import type { TagOption } from '../types/element-plus'

const authStore = useAuthStore()
const projectCtx = useProjectContext()
const router = useRouter()
const loading = ref(false)
declare const __APP_VERSION__: string
const deployVersion = __APP_VERSION__

const stats = ref({
  totalMemories: 0,
  activeRules: 0,
  totalApplied: 0,
  totalViolations: 0,
})

const recentMemories = ref<Array<{
  id: string
  title: string
  scope: string
  createdAt: string
}>>([])

const ruleSeverityCounts = ref({ error: 0, warning: 0, info: 0 })

const adoptionPercentage = computed(() => {
  const applied = stats.value.totalApplied ?? 0
  const violations = stats.value.totalViolations ?? 0
  const total = applied + violations
  if (total === 0) return 0
  return Math.round((applied / total) * 100)
})

interface PLCard {
  name: string
  nodeCount: number
  edgeCount: number
  totalCommits: number
  activeRepos7d: number
  gitStats: ProjectGitStatsApi[]
  alerts: HealthAlert[]
}

const plCards = ref<PLCard[]>([])
const plLoading = ref(false)

async function loadProductLineCards(): Promise<void> {
  if (!authStore.isAuthenticated) return
  plLoading.value = true
  try {
    const pls = await getTopologyProductLines()
    const cards: PLCard[] = []
    for (const pl of pls) {
      const [topo, gitStatsRes, alertsRes] = await Promise.allSettled([
        getTopology(pl),
        getProductLineGitStats(pl),
        getProductLineHealthAlerts(pl),
      ])
      const nodeCount = topo.status === 'fulfilled' ? topo.value.nodes.length : 0
      const edgeCount = topo.status === 'fulfilled' ? topo.value.edges.length : 0
      const gs = gitStatsRes.status === 'fulfilled' ? gitStatsRes.value : []
      const alerts = alertsRes.status === 'fulfilled' ? alertsRes.value : []
      const totalCommits = gs.reduce((s, g) => s + (g.totalCommits ?? 0), 0)
      const activeRepos7d = gs.filter(g => (g.commitsLast7d ?? 0) > 0).length
      cards.push({ name: pl, nodeCount, edgeCount, totalCommits, activeRepos7d, gitStats: gs, alerts })
    }
    plCards.value = cards
  } catch (e) {
    console.error('加载产品线卡片失败:', e)
  }
  plLoading.value = false
}

const allAlerts = computed(() => {
  const all: Array<HealthAlert & { productLine: string }> = []
  for (const card of plCards.value) {
    for (const a of card.alerts) {
      all.push({ ...a, productLine: card.name })
    }
  }
  return all.sort((a, b) => {
    const sevOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 }
    return (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9)
  }).slice(0, 8)
})

function goToTopology(pl: string): void {
  localStorage.setItem('memforge-topology-default-pl', pl)
  router.push({ name: 'Topology' })
}

function alertTagType(severity: string): '' | 'success' | 'info' | 'warning' | 'danger' {
  if (severity === 'critical') return 'danger'
  if (severity === 'warning') return 'warning'
  return 'info'
}

async function loadDashboard(): Promise<void> {
  if (!authStore.isAuthenticated) return
  loading.value = true
  try {
    const [memResult, rulesResult, activeRulesResult] = await Promise.allSettled([
      listMemories({ page: 1, page_size: 5, cross_project: true }),
      measureRules('30d'),
      listRules({ status: 'active', page_size: 200, cross_project: true }),
    ])

    if (memResult.status === 'fulfilled' && memResult.value.success) {
      stats.value.totalMemories = memResult.value.pagination.total
      recentMemories.value = memResult.value.entries.map(e => ({
        id: e.id,
        title: e.title,
        scope: e.scope,
        createdAt: e.createdAt,
      }))
    }

    if (rulesResult.status === 'fulfilled' && rulesResult.value.success && rulesResult.value.overview) {
      const ov = rulesResult.value.overview
      stats.value.activeRules = ov.totalActiveRules
      stats.value.totalApplied = ov.totalApplied
      stats.value.totalViolations = ov.totalViolations
    }

    if (activeRulesResult.status === 'fulfilled' && activeRulesResult.value.success) {
      const counts = { error: 0, warning: 0, info: 0 }
      for (const rule of activeRulesResult.value.rules) {
        const sev = rule.severity as keyof typeof counts
        if (sev in counts) counts[sev]++
      }
      ruleSeverityCounts.value = counts
    }
  } catch (e) {
    console.error('加载仪表盘数据失败:', e)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  projectCtx.loadProjects()
  loadDashboard()
  loadProductLineCards()
})

function getScopeTag(scope: string): TagOption {
  const map: Record<string, TagOption> = {
    coding_standard: { type: 'success', label: '规范' },
    architecture: { type: 'primary', label: '架构' },
    lesson_learned: { type: 'warning', label: '教训' },
    bug_pattern: { type: 'danger', label: 'Bug' },
    convention: { type: 'info', label: '约定' },
    performance_insight: { type: 'info', label: '性能' },
  }
  return map[scope] ?? { type: 'info', label: scope }
}
</script>

<template>
  <div class="dashboard">
    <!-- 顶部全局统计 -->
    <el-row :gutter="20" class="stats-row">
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <el-statistic title="记忆总数" :value="stats.totalMemories">
            <template #prefix><el-icon color="#409eff"><Collection /></el-icon></template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <el-statistic title="活跃规则" :value="stats.activeRules">
            <template #prefix><el-icon color="#67c23a"><Document /></el-icon></template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <el-statistic title="应用次数" :value="stats.totalApplied">
            <template #prefix><el-icon color="#e6a23c"><Check /></el-icon></template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <el-statistic title="违反次数" :value="stats.totalViolations">
            <template #prefix><el-icon color="#f56c6c"><Close /></el-icon></template>
          </el-statistic>
        </el-card>
      </el-col>
    </el-row>

    <!-- 产品线概览卡片 -->
    <div v-if="plCards.length > 0 || plLoading" class="section-block">
      <h3 class="section-heading">产品线概览</h3>
      <el-skeleton v-if="plLoading && plCards.length === 0" :rows="3" animated />
      <div v-else class="pl-grid">
        <el-card
          v-for="card in plCards" :key="card.name"
          shadow="hover" class="pl-card"
          @click="goToTopology(card.name)"
        >
          <div class="pl-card-header">
            <span class="pl-name">{{ card.name }}</span>
            <el-tag v-if="card.alerts.filter(a => a.severity === 'critical').length > 0" type="danger" size="small" round>
              {{ card.alerts.filter(a => a.severity === 'critical').length }} 告警
            </el-tag>
          </div>
          <div class="pl-metrics">
            <div class="pl-metric">
              <span class="metric-val">{{ card.nodeCount }}</span>
              <span class="metric-lbl">服务</span>
            </div>
            <div class="pl-metric">
              <span class="metric-val">{{ card.edgeCount }}</span>
              <span class="metric-lbl">调用链</span>
            </div>
            <div class="pl-metric">
              <span class="metric-val">{{ card.totalCommits.toLocaleString() }}</span>
              <span class="metric-lbl">总提交</span>
            </div>
            <div class="pl-metric">
              <span class="metric-val" :class="{ active: card.activeRepos7d > 0 }">{{ card.activeRepos7d }}</span>
              <span class="metric-lbl">7d 活跃</span>
            </div>
          </div>
          <div v-if="card.alerts.length > 0" class="pl-alerts-preview">
            <el-tag
              v-for="(a, i) in card.alerts.slice(0, 3)" :key="i"
              :type="alertTagType(a.severity)" size="small" effect="light"
              style="margin: 2px"
            >
              {{ a.message.slice(0, 30) }}{{ a.message.length > 30 ? '…' : '' }}
            </el-tag>
          </div>
        </el-card>
      </div>
    </div>

    <!-- 健康告警 + 近期记忆 + 规范采纳率 -->
    <el-row :gutter="20" style="margin-top: 20px">
      <el-col :span="16">
        <!-- 健康告警 -->
        <el-card v-if="allAlerts.length > 0" style="margin-bottom: 16px">
          <template #header>
            <div class="card-header">
              <span>健康告警</span>
              <el-tag type="warning" size="small">{{ allAlerts.length }} 项</el-tag>
            </div>
          </template>
          <div class="alerts-list">
            <div v-for="(alert, i) in allAlerts" :key="i" class="alert-row" @click="goToTopology(alert.productLine)">
              <el-tag :type="alertTagType(alert.severity)" size="small" style="min-width: 50px; text-align: center">
                {{ alert.severity === 'critical' ? '严重' : alert.severity === 'warning' ? '警告' : '提示' }}
              </el-tag>
              <span class="alert-pl">{{ alert.productLine }}</span>
              <span class="alert-msg">{{ alert.message }}</span>
              <span v-if="alert.repoId" class="alert-repo">{{ alert.repoId.split('/').pop() }}</span>
            </div>
          </div>
        </el-card>

        <!-- 近期记忆 -->
        <el-card>
          <template #header>
            <div class="card-header">
              <span>近期记忆</span>
              <el-button text type="primary" @click="router.push({ name: 'Memories' })">查看全部</el-button>
            </div>
          </template>
          <el-table :data="recentMemories" stripe style="width: 100%">
            <el-table-column label="类型" width="80">
              <template #default="{ row }">
                <el-tag :type="getScopeTag(row.scope).type" size="small">
                  {{ getScopeTag(row.scope).label }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="title" label="标题" />
            <el-table-column label="时间" width="180">
              <template #default="{ row }">
                {{ new Date(row.createdAt).toLocaleString('zh-CN') }}
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :span="8">
        <el-card>
          <template #header>
            <span>规范合规率</span>
          </template>
          <div class="adoption-stats">
            <el-progress type="dashboard" :percentage="adoptionPercentage" :color="['#f56c6c', '#e6a23c', '#67c23a']" />
            <div class="adoption-detail">
              <p>应用 / 违反: <strong>{{ stats.totalApplied }}</strong> / <strong>{{ stats.totalViolations }}</strong></p>
              <p>error 级规则: <strong>{{ ruleSeverityCounts.error }}</strong> 条</p>
              <p>warning 级规则: <strong>{{ ruleSeverityCounts.warning }}</strong> 条</p>
              <p>info 级规则: <strong>{{ ruleSeverityCounts.info }}</strong> 条</p>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <div class="deploy-version">{{ deployVersion }}</div>
  </div>
</template>

<style scoped>
.dashboard { max-width: 1400px; }
.deploy-version {
  text-align: right;
  font-size: 11px;
  color: var(--mf-text-muted, #6c757d);
  margin-top: 24px;
  opacity: 0.6;
}
.stat-card { text-align: center; }
.card-header { display: flex; justify-content: space-between; align-items: center; }

.section-block { margin-top: 20px; }
.section-heading {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 12px;
  color: var(--el-text-color-primary, #303133);
}

.pl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}
.pl-card {
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
  border-radius: 10px;
}
.pl-card:hover { transform: translateY(-2px); }
.pl-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.pl-name {
  font-size: 18px;
  font-weight: 700;
  color: var(--el-text-color-primary, #303133);
}
.pl-metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  text-align: center;
}
.pl-metric .metric-val {
  display: block;
  font-size: 22px;
  font-weight: 700;
  color: var(--el-text-color-primary, #303133);
}
.pl-metric .metric-val.active { color: #10B981; }
.pl-metric .metric-lbl {
  display: block;
  font-size: 11px;
  color: var(--el-text-color-secondary, #909399);
  margin-top: 2px;
}
.pl-alerts-preview {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--el-border-color-lighter, #ebeef5);
}

.alerts-list { display: flex; flex-direction: column; gap: 8px; }
.alert-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}
.alert-row:hover { background: var(--el-fill-color-light, #f0f2f5); }
.alert-pl {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary, #909399);
  min-width: 60px;
}
.alert-msg {
  flex: 1;
  font-size: 13px;
  color: var(--el-text-color-primary, #303133);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.alert-repo {
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--el-text-color-secondary, #909399);
}

.adoption-stats { display: flex; flex-direction: column; align-items: center; gap: 16px; }
.adoption-detail { text-align: left; width: 100%; }
.adoption-detail p { margin: 8px 0; color: #606266; }
</style>
