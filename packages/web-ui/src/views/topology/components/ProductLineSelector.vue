<script setup lang="ts">
// Created by dev on 2026/04/08
import { QuestionFilled } from '@element-plus/icons-vue'
import type { PLConfig, UserPathsCoverage } from '../types'

defineProps<{
  productLines: string[]
  selectedProductLine: string
  currentPLConfig: PLConfig | null
  totalNodesCount: number
  currentUserClonedCount: number
  userPathsCoverage: UserPathsCoverage[]
  scanContributors: Array<{ userId: string; count: number; lastScanAt: string | null }>
  canManageProductLine: boolean
  canEditScanConfig: boolean
  hasOnlineClients: boolean
  scanning: boolean
  remoteScanning: boolean
  clientScanDisabledReason: string
  serverScanDisabledReason: string
  forceScan: boolean
}>()

defineEmits<{
  switchProductLine: [pl: string]
  showAddPLDialog: []
  showEditPLDialog: []
  triggerClientScan: []
  triggerServerScan: []
  deleteProductLine: []
  'update:forceScan': [val: boolean]
}>()
</script>

<template>
  <el-card v-if="currentPLConfig" class="pl-card">
    <template #header>
      <div class="pl-header">
        <span>产品线信息</span>
        <div class="pl-actions">
          <el-button v-if="canEditScanConfig" text size="small" @click="$emit('showEditPLDialog')">编辑</el-button>
          <el-tooltip :content="clientScanDisabledReason" :disabled="!clientScanDisabledReason" placement="bottom">
            <el-button text size="small" type="success" :loading="remoteScanning" :disabled="scanning || !hasOnlineClients" @click="$emit('triggerClientScan')">客户端扫描</el-button>
          </el-tooltip>
          <el-tooltip v-if="canManageProductLine" :content="serverScanDisabledReason" :disabled="!serverScanDisabledReason" placement="bottom">
            <el-button text size="small" :loading="scanning" :disabled="remoteScanning" @click="$emit('triggerServerScan')">服务器扫描</el-button>
          </el-tooltip>
          <el-checkbox
            v-if="canManageProductLine"
            :model-value="forceScan"
            @update:model-value="$emit('update:forceScan', !!$event)"
            :disabled="scanning || remoteScanning"
            size="small"
            style="margin-left: 4px;"
          >
            强制
          </el-checkbox>
          <el-tooltip v-if="canManageProductLine" content="开启后，扫描会覆盖你之前贡献的节点并清理不再存在的仓库。其他用户贡献的节点不受影响。" placement="bottom">
            <el-icon style="cursor: help; color: var(--mf-text-muted, #5a6170); font-size: 14px;"><QuestionFilled /></el-icon>
          </el-tooltip>
          <el-button v-if="canManageProductLine" text size="small" type="danger" @click="$emit('deleteProductLine')">归档</el-button>
        </div>
      </div>
    </template>
    <el-descriptions :column="1" border size="small">
      <el-descriptions-item label="名称">
        {{ currentPLConfig.name }}
        <el-tag v-if="currentPLConfig.builtin" size="small" type="success" style="margin-left: 6px">内置</el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="统计">
        {{ currentPLConfig.repoCount ?? 0 }} 个仓库 · {{ currentPLConfig.edgeCount ?? 0 }} 条调用链
      </el-descriptions-item>
      <el-descriptions-item v-if="totalNodesCount > 0" label="本地覆盖">
        <div style="display: flex; align-items: center; gap: 8px">
          <el-progress
            :percentage="totalNodesCount > 0 ? Math.round(currentUserClonedCount / totalNodesCount * 100) : 0"
            :stroke-width="10"
            :color="currentUserClonedCount === totalNodesCount ? '#67c23a' : '#409eff'"
            style="flex: 1"
          />
          <span class="coverage-stat">{{ currentUserClonedCount }}/{{ totalNodesCount }}</span>
        </div>
      </el-descriptions-item>
      <el-descriptions-item v-if="userPathsCoverage.length > 0" label="团队覆盖">
        <div class="user-coverage-list">
          <div v-for="uc in userPathsCoverage" :key="uc.userId" class="user-coverage-item">
            <span class="user-coverage-name">{{ uc.userId === '_system_' ? '旧数据' : (uc.displayName || uc.userId.slice(0, 8)) }}</span>
            <el-tag size="small" type="info">{{ uc.repoCount }}</el-tag>
          </div>
        </div>
      </el-descriptions-item>
      <el-descriptions-item v-if="scanContributors.length > 0" label="扫描贡献">
        <div class="user-coverage-list">
          <div v-for="sc in scanContributors" :key="sc.userId" class="user-coverage-item">
            <span class="user-coverage-name">{{ sc.userId === '_unknown_' ? '未知' : sc.userId }}</span>
            <el-tooltip :content="sc.lastScanAt ? `最后扫描: ${new Date(sc.lastScanAt).toLocaleString()}` : ''" placement="top" :disabled="!sc.lastScanAt">
              <el-tag size="small" :type="sc.lastScanAt ? 'success' : 'info'">{{ sc.count }} 节点</el-tag>
            </el-tooltip>
          </div>
        </div>
      </el-descriptions-item>
    </el-descriptions>
  </el-card>
</template>

<style scoped>
.pl-card { margin-bottom: 16px; }
.pl-header { display: flex; justify-content: space-between; align-items: center; }
.pl-actions { display: flex; gap: 2px; }
.coverage-stat { font-size: 12px; color: var(--mf-text-muted, #5a6170); white-space: nowrap; }
.user-coverage-list { display: flex; flex-wrap: wrap; gap: 6px; }
.user-coverage-item { display: inline-flex; align-items: center; gap: 4px; }
.user-coverage-name { font-size: 12px; color: var(--mf-text-secondary, #8e949e); font-family: 'SF Mono', 'Menlo', monospace; }
</style>
