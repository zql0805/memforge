<script setup lang="ts">
// Created by dev on 2026/04/08
import { computed } from 'vue'
import type { ServiceEdge } from '../types'

const MAX_DISPLAY = 5

const props = defineProps<{
  edges: ServiceEdge[]
  selectedNodeId: string | null
  selectedNodeName: string | null
}>()

const filteredEdges = computed(() => {
  if (!props.selectedNodeId && !props.selectedNodeName) return props.edges
  return props.edges.filter(e => {
    if (e.fromRepoId && e.toRepoId) {
      return e.fromRepoId === props.selectedNodeId || e.toRepoId === props.selectedNodeId
    }
    return e.from === props.selectedNodeName || e.to === props.selectedNodeName
  })
})

const displayEdges = computed(() => filteredEdges.value.slice(0, MAX_DISPLAY))
const hiddenCount = computed(() => Math.max(0, filteredEdges.value.length - MAX_DISPLAY))
</script>

<template>
  <el-card class="call-graph-card">
    <template #header>
      <div class="cg-header">
        <span>调用关系</span>
        <el-tag type="info" size="small">{{ filteredEdges.length }} / {{ edges.length }}</el-tag>
      </div>
    </template>
    <div v-if="displayEdges.length > 0" class="edge-list">
      <div v-for="(edge, idx) in displayEdges" :key="idx" class="edge-item">
        <el-tag size="small" type="info">{{ edge.from }}</el-tag>
        <span class="edge-arrow">→</span>
        <el-tag size="small">{{ edge.to }}</el-tag>
        <el-tag size="small" type="warning" class="protocol-tag">{{ edge.protocol }}</el-tag>
      </div>
      <div v-if="hiddenCount > 0" class="more-hint">
        + {{ hiddenCount }} 条更多（详情请打开项目百科）
      </div>
    </div>
    <div v-else class="no-edges">
      {{ selectedNodeId ? '当前节点无匹配调用关系' : '暂无调用关系数据' }}
    </div>
  </el-card>
</template>

<style scoped>
.call-graph-card {
  max-height: 240px;
}
.cg-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.edge-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.edge-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.edge-arrow { color: #909399; font-size: 11px; }
.protocol-tag { margin-left: auto; transform: scale(0.9); }
.more-hint {
  font-size: 12px;
  color: #909399;
  text-align: center;
  padding: 4px 0;
}
.no-edges {
  font-size: 12px;
  color: #c0c4cc;
  text-align: center;
  padding: 12px 0;
}
</style>
