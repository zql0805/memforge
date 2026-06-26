<script setup lang="ts">
// Created by dev on 2026/04/05
import { ref, onMounted, watch } from 'vue'
import { getAuditLogs, type AuditLog } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { ElTagType } from '../types/element-plus'
import { ElMessage } from 'element-plus'

const authStore = useAuthStore()
const loading = ref(false)
const logs = ref<AuditLog[]>([])
const currentPage = ref(1)
const pageSize = ref(50)
const total = ref(0)

async function loadLogs(): Promise<void> {
  if (!authStore.isAuthenticated) return
  loading.value = true
  try {
    const result = await getAuditLogs(currentPage.value, pageSize.value)
    logs.value = result.logs ?? []
    total.value = (result as Record<string, unknown>).total as number ?? logs.value.length
  } catch (err) {
    const axiosErr = err as { response?: { status?: number } }
    if (axiosErr?.response?.status === 403) {
      ElMessage.warning('仅 admin 角色可查看审计日志')
    } else if (axiosErr?.response?.status === 401) {
      authStore.logout()
    }
  } finally {
    loading.value = false
  }
}

function getActionType(action: string): ElTagType {
  if (action.includes('FAILED')) return 'danger'
  if (action.startsWith('TOKEN')) return 'warning'
  return 'primary'
}

function formatDetails(details: Record<string, unknown> | null): string {
  if (!details) return '-'
  return JSON.stringify(details)
}

watch(currentPage, () => loadLogs())
onMounted(() => loadLogs())
</script>

<template>
  <div>
    <el-card>
      <template #header>
        <div class="header">
          <span>审计日志</span>
          <el-button icon="Refresh" :loading="loading" @click="loadLogs">刷新</el-button>
        </div>
      </template>

      <el-empty v-if="!loading && logs.length === 0" description="暂无审计日志记录。Gateway 接收到的每个 MCP 工具调用和认证事件都会被自动记录。" />

      <el-table v-else v-loading="loading" :data="logs" stripe>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column label="操作" width="180">
          <template #default="{ row }">
            <el-tag :type="getActionType(row.action)" size="small">{{ row.action }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="详情" min-width="250">
          <template #default="{ row }">
            <code>{{ formatDetails(row.details) }}</code>
          </template>
        </el-table-column>
        <el-table-column prop="user_id" label="用户" width="120" />
        <el-table-column prop="ip_address" label="IP" width="120" />
        <el-table-column label="时间" width="180">
          <template #default="{ row }">
            {{ new Date(row.created_at).toLocaleString('zh-CN') }}
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
  </div>
</template>

<style scoped>
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

code {
  font-size: 12px;
  color: #606266;
}
</style>
