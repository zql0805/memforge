<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getWebhooks, getWebhookStats, deactivateWebhook,
  type WebhookConfig,
} from '../api/client'

const loading = ref(false)
const configs = ref<WebhookConfig[]>([])
const total = ref(0)
const stats = ref<{ total: number; active: number; byProductLine: Record<string, number> } | null>(null)

async function loadStats(): Promise<void> {
  try {
    stats.value = await getWebhookStats()
  } catch {
    console.error('加载 Webhook 统计失败')
  }
}

async function loadConfigs(): Promise<void> {
  loading.value = true
  try {
    const result = await getWebhooks()
    configs.value = result.configs
    total.value = result.total
  } catch {
    ElMessage.error('加载 Webhook 配置失败')
  }
  loading.value = false
}

async function handleDeactivate(row: WebhookConfig): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认停用 ${row.project_path} 的 Webhook？`,
      '停用确认',
      { type: 'warning' },
    )
    await deactivateWebhook(row.id)
    ElMessage.success('已停用')
    loadConfigs()
    loadStats()
  } catch {
    /* cancelled */
  }
}

function formatDate(d: string): string {
  return d ? new Date(d).toLocaleString('zh-CN') : '-'
}

onMounted(() => {
  loadStats()
  loadConfigs()
})
</script>

<template>
  <div class="webhook-management">
    <div class="page-header">
      <h2>Webhook 管理</h2>
      <el-tag type="info">通过 MCP 工具 setup_gitlab_webhooks 添加</el-tag>
    </div>

    <el-row :gutter="16" class="stats-row">
      <el-col :span="8">
        <el-card shadow="hover" class="stat-card">
          <el-statistic title="Webhook 总数" :value="stats?.total ?? 0" />
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="hover" class="stat-card">
          <el-statistic title="活跃" :value="stats?.active ?? 0" value-style="color: #67c23a" />
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="hover" class="stat-card">
          <el-statistic title="产品线覆盖" :value="Object.keys(stats?.byProductLine ?? {}).length" />
        </el-card>
      </el-col>
    </el-row>

    <el-card style="margin-top: 16px">
      <template #header>
        <div class="card-header">
          <span>Webhook 配置列表</span>
          <el-tag size="small" type="info">共 {{ total }} 条</el-tag>
        </div>
      </template>
      <el-table v-loading="loading" :data="configs" stripe>
        <el-table-column label="项目路径" prop="project_path" min-width="220">
          <template #default="{ row }">
            <span class="mono">{{ row.project_path }}</span>
          </template>
        </el-table-column>
        <el-table-column label="平台" prop="platform" width="80">
          <template #default="{ row }">
            <el-tag size="small">{{ row.platform }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="产品线" prop="product_line" width="120">
          <template #default="{ row }">
            {{ row.product_line ?? '-' }}
          </template>
        </el-table-column>
        <el-table-column label="Hook ID" prop="webhook_id" width="90">
          <template #default="{ row }">
            <span class="mono">{{ row.webhook_id ?? '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="事件" width="200">
          <template #default="{ row }">
            <el-tag v-for="e in (row.events ?? [])" :key="e" size="small" style="margin: 2px">
              {{ e.replace('_events', '').replace('_', ' ') }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.is_active ? 'success' : 'danger'" size="small">
              {{ row.is_active ? '活跃' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.is_active"
              type="danger" size="small" text
              @click.stop="handleDeactivate(row)"
            >
              停用
            </el-button>
            <span v-else style="color: #909399; font-size: 12px">已停用</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.webhook-management { max-width: 1400px; }
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.page-header h2 { margin: 0; font-size: 20px; font-weight: 600; }
.stats-row { margin-bottom: 0; }
.stat-card { text-align: center; }
.card-header { display: flex; justify-content: space-between; align-items: center; }
.mono { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 12px; }
</style>
