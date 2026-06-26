<script setup lang="ts">
// Created by dev on 2026/06/10
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { getCallGraph, searchCallGraph, refreshCallGraphTraffic } from '../../../../api/client'
import type { CallGraphNode, CallGraphEdge, CallGraphResponse } from '../../../../api/client'
import SearchBar from './SearchBar.vue'
import CallGraphCanvas from './CallGraphCanvas.vue'

const props = defineProps<{
  productLine: string
}>()

const loading = ref(false)
const refreshing = ref(false)
const nodes = ref<CallGraphNode[]>([])
const edges = ref<CallGraphEdge[]>([])
const lastTrafficUpdate = ref<string | null>(null)
const isSearchResult = ref(false)

async function loadFullGraph() {
  loading.value = true
  isSearchResult.value = false
  try {
    const data = await getCallGraph(props.productLine)
    applyData(data)
  } catch (err) {
    ElMessage.error('加载调用关系图失败')
  } finally {
    loading.value = false
  }
}

async function handleSearch(query: string, type: 'url' | 'node' | 'appkey') {
  loading.value = true
  try {
    const data = await searchCallGraph(props.productLine, query, type)
    if (data.nodes.length === 0) {
      ElMessage.warning('未找到匹配结果')
      return
    }
    isSearchResult.value = true
    applyData(data)
  } catch (err) {
    ElMessage.error('搜索失败')
  } finally {
    loading.value = false
  }
}

function handleClearSearch() {
  loadFullGraph()
}

async function handleRefreshTraffic() {
  refreshing.value = true
  try {
    const result = await refreshCallGraphTraffic(props.productLine)
    ElMessage.success(`已刷新 ${result.updated} 个接口的流量数据`)
    await loadFullGraph()
  } catch (err) {
    ElMessage.error('流量刷新失败')
  } finally {
    refreshing.value = false
  }
}

function applyData(data: CallGraphResponse) {
  nodes.value = data.nodes
  edges.value = data.edges
  lastTrafficUpdate.value = data.lastTrafficUpdate
}

function handleSelectNodes(_ids: string[]) {
  // 多选过滤逻辑由 Canvas 内部处理
}

onMounted(() => {
  loadFullGraph()
})
</script>

<template>
  <div class="cg-panel" v-loading="loading">
    <div class="cg-toolbar">
      <SearchBar @search="handleSearch" @clear="handleClearSearch" />
      <div class="cg-toolbar-right">
        <el-tag v-if="isSearchResult" type="warning" size="small" closable @close="handleClearSearch">
          搜索结果：{{ nodes.length }} 节点
        </el-tag>
        <span v-if="lastTrafficUpdate" class="traffic-time">
          流量更新：{{ new Date(lastTrafficUpdate).toLocaleString() }}
        </span>
        <el-button size="small" :loading="refreshing" @click="handleRefreshTraffic">
          刷新流量
        </el-button>
      </div>
    </div>

    <div v-if="nodes.length > 0" class="cg-body">
      <CallGraphCanvas
        :nodes="nodes"
        :edges="edges"
        :product-line="productLine"
        @select-nodes="handleSelectNodes"
      />
    </div>

    <div v-else-if="!loading" class="cg-empty">
      <p>暂无调用关系数据。请先执行拓扑扫描。</p>
    </div>
  </div>
</template>

<style scoped>
.cg-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 12px;
}
.cg-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.cg-toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.traffic-time {
  font-size: 12px;
  color: var(--mf-text-muted, #909399);
}
.cg-body {
  flex: 1;
  min-height: 500px;
  border: 1px solid var(--mf-border, #dcdfe6);
  border-radius: 8px;
  overflow: hidden;
}
.cg-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--mf-text-muted, #909399);
}
</style>
