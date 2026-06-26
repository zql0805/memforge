<script setup lang="ts">
// Created by dev on 2026/04/08
import { computed } from 'vue'
import type { ServiceNode, ServiceEdge, ApiNode, TopologyFullData } from '../types'

const props = defineProps<{
  selectedNode: ServiceNode | null
  edges: ServiceEdge[]
  structuredData: TopologyFullData | null
}>()

const emit = defineEmits<{
  openDetail: []
  openChangeImpact: []
  clearSelection: []
}>()

const apiNode = computed<ApiNode | null>(() => {
  if (!props.selectedNode || !props.structuredData) return null
  return props.structuredData.nodes.find(n => n.repoId === props.selectedNode!.id) ?? null
})

const upstreamCount = computed(() => {
  if (!props.selectedNode) return 0
  const id = props.selectedNode.id
  return props.edges.filter(e => e.toRepoId === id || e.to === props.selectedNode!.name).length
})

const downstreamCount = computed(() => {
  if (!props.selectedNode) return 0
  const id = props.selectedNode.id
  return props.edges.filter(e => e.fromRepoId === id || e.from === props.selectedNode!.name).length
})

function copyPath(): void {
  const path = apiNode.value?.localPath
  if (!path) return
  if (navigator.clipboard) {
    navigator.clipboard.writeText(path).catch(() => fallbackCopy(path))
  } else {
    fallbackCopy(path)
  }
}

function fallbackCopy(text: string): void {
  const el = document.createElement('textarea')
  el.value = text
  el.style.position = 'fixed'
  el.style.opacity = '0'
  document.body.appendChild(el)
  el.select()
  try { document.execCommand('copy') } catch { /* 静默 */ } finally {
    document.body.removeChild(el)
  }
}
</script>

<template>
  <el-card v-if="selectedNode" class="node-summary-card">
    <template #header>
      <div class="summary-header">
        <span class="summary-title">{{ selectedNode.name }}</span>
        <el-button text size="small" @click="emit('clearSelection')">×</el-button>
      </div>
    </template>
    <div class="summary-body">
      <div class="summary-row">
        <el-tag size="small" type="info">{{ selectedNode.techStack || '未知' }}</el-tag>
        <span class="summary-layer">{{ selectedNode.layer || '待归类' }}</span>
      </div>
      <div class="summary-row">
        <span class="summary-label">上游</span>
        <span class="summary-value">{{ upstreamCount }}</span>
        <span class="summary-sep">·</span>
        <span class="summary-label">下游</span>
        <span class="summary-value">{{ downstreamCount }}</span>
      </div>
      <div v-if="apiNode?.localPath" class="summary-row path-row" @click="copyPath">
        <code class="local-path">{{ apiNode.localPath }}</code>
      </div>
      <div v-if="apiNode?.gitRemoteUrl" class="summary-row">
        <span class="summary-label">Git</span>
        <code class="git-url">{{ apiNode.gitRemoteUrl }}</code>
      </div>
      <div class="summary-actions">
        <el-button size="small" type="primary" plain @click="emit('openDetail')">查看详情</el-button>
        <el-button size="small" plain @click="emit('openChangeImpact')">变更影响</el-button>
      </div>
    </div>
  </el-card>
  <el-card v-else class="node-summary-card empty-hint">
    <div class="empty-body">
      <span class="empty-text">点击左侧服务查看摘要</span>
    </div>
  </el-card>
</template>

<style scoped>
.node-summary-card {
  max-height: 260px;
  overflow: hidden;
}
.summary-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.summary-title {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.summary-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.summary-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.summary-label {
  color: #909399;
  font-size: 12px;
}
.summary-value {
  font-weight: 600;
  color: #303133;
}
.summary-sep {
  color: #c0c4cc;
}
.summary-layer {
  color: #606266;
  font-size: 12px;
}
.path-row {
  cursor: pointer;
}
.path-row:hover .local-path {
  color: #409eff;
}
.local-path {
  font-size: 11px;
  color: #606266;
  font-family: 'SF Mono', 'Menlo', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.git-url {
  font-size: 11px;
  color: #909399;
  font-family: 'SF Mono', 'Menlo', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}
.summary-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.empty-hint {
  display: flex;
  align-items: center;
  justify-content: center;
}
.empty-body {
  padding: 16px 0;
  text-align: center;
}
.empty-text {
  color: #c0c4cc;
  font-size: 13px;
}
</style>
