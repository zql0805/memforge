<script setup lang="ts">
// Created by dev on 2026/04/08
import { QuestionFilled } from '@element-plus/icons-vue'
import type { McpClientStatus } from '../types'

defineProps<{
  scanning: boolean
  remoteScanning: boolean
  scanProductLine: string
  scanRoots: string
  scanResult: { totalRepos: number; totalEdges: number; totalStored: number } | null
  scanError: string
  remoteScanProgress: { phase: string; detail?: string; percent?: number } | null
  mcpClients: McpClientStatus[]
  hasOnlineClients: boolean
  canManageProductLine: boolean
  hasData: boolean
  clientScanDisabledReason: string
  serverScanDisabledReason: string
  forceScan: boolean
}>()

defineEmits<{
  triggerClientScan: []
  triggerServerScan: []
  'update:scanProductLine': [val: string]
  'update:scanRoots': [val: string]
  'update:forceScan': [val: boolean]
}>()
</script>

<template>
  <div class="scan-control">
    <div v-if="mcpClients.length > 0 && !hasData" style="margin-bottom: 12px; text-align: center;">
      <el-tag type="success" size="small" effect="dark" style="margin-right: 8px;">
        <span class="online-dot" />
        {{ mcpClients.length }} 个 MCP 客户端在线
      </el-tag>
      <span v-for="c in mcpClients" :key="c.userId" class="client-name">
        {{ c.machineInfo?.hostname ?? c.userId }}
      </span>
    </div>

    <div v-if="!hasData" class="scan-input-row">
      <el-input
        :model-value="scanProductLine"
        placeholder="输入产品线名称（小写英文）"
        size="default"
        style="width: 280px"
        :disabled="scanning || remoteScanning"
        @update:model-value="$emit('update:scanProductLine', $event)"
      />
      <el-tooltip :content="clientScanDisabledReason" :disabled="!clientScanDisabledReason" placement="bottom">
        <el-button
          type="primary"
          :loading="remoteScanning"
          :disabled="scanning || !hasOnlineClients"
          @click="$emit('triggerClientScan')"
        >
          {{ remoteScanning ? '扫描中…' : '客户端扫描' }}
        </el-button>
      </el-tooltip>
      <el-tooltip v-if="canManageProductLine" :content="serverScanDisabledReason" :disabled="!serverScanDisabledReason" placement="bottom">
        <el-button
          :loading="scanning"
          :disabled="remoteScanning"
          @click="$emit('triggerServerScan')"
        >
          {{ scanning ? '扫描中…' : '服务器扫描' }}
        </el-button>
      </el-tooltip>
    </div>

    <div v-if="!hasData" class="scan-roots-row">
      <el-input
        :model-value="scanRoots"
        type="textarea"
        :rows="2"
        placeholder="扫描根目录（每行一个），如 ~/work/myapp&#10;留空则使用默认配置"
        :disabled="scanning || remoteScanning"
        @update:model-value="$emit('update:scanRoots', $event)"
      />
    </div>

    <div v-if="canManageProductLine && !hasData" class="force-option">
      <el-checkbox
        :model-value="forceScan"
        @update:model-value="$emit('update:forceScan', !!$event)"
        :disabled="scanning || remoteScanning"
      >
        强制更新
      </el-checkbox>
      <el-tooltip content="开启后，扫描会覆盖你之前贡献的节点数据并清理不再存在的仓库。其他用户贡献的节点不受影响。" placement="bottom">
        <el-icon style="margin-left: 4px; cursor: help; color: var(--mf-text-muted, #5a6170);"><QuestionFilled /></el-icon>
      </el-tooltip>
    </div>

    <div v-if="!hasData && !hasOnlineClients && !scanning && !remoteScanning" class="no-client-hint">
      <el-alert type="info" :closable="false" show-icon>
        未检测到 MCP 客户端在线。「客户端扫描」需要 Cursor 配置 <code>MEMFORGE_GATEWAY_URL</code> 并连接到 Memforge 服务。可改用「服务器扫描」通过 MCP 工具在服务端执行。
      </el-alert>
    </div>

    <div v-if="remoteScanProgress" class="progress-bar">
      <el-progress
        :percentage="remoteScanProgress.percent ?? 0"
        :status="remoteScanProgress.phase === 'done' ? 'success' : undefined"
        :stroke-width="10"
      />
      <p class="progress-text">
        {{ remoteScanProgress.detail ?? remoteScanProgress.phase }}
      </p>
    </div>

    <el-alert v-if="scanResult" type="success" :closable="false" style="margin-bottom: 8px">
      扫描完成：{{ scanResult.totalRepos }} 个仓库，{{ scanResult.totalEdges }} 条调用关系，导入 {{ scanResult.totalStored }} 条记忆
    </el-alert>
    <el-alert v-if="scanError" type="error" :closable="false" style="margin-bottom: 8px">
      {{ scanError }}
    </el-alert>
  </div>
</template>

<style scoped>
.scan-control { text-align: center; }
.scan-input-row {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: center;
  margin-bottom: 12px;
}
.scan-roots-row {
  max-width: 460px;
  margin: 0 auto 12px;
  text-align: left;
}
.force-option {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 12px;
  font-size: 13px;
}
.online-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #fff;
  margin-right: 4px;
  vertical-align: middle;
}
.client-name {
  font-size: 12px;
  color: var(--mf-text-muted, #5a6170);
  margin-left: 4px;
}
.progress-bar {
  margin-bottom: 12px;
  max-width: 400px;
  margin-left: auto;
  margin-right: auto;
}
.progress-text {
  font-size: 12px;
  color: var(--mf-text-muted, #5a6170);
  margin-top: 4px;
  text-align: center;
}
.no-client-hint {
  max-width: 460px;
  margin: 0 auto 12px;
}
</style>
