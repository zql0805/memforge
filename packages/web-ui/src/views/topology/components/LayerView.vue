<script setup lang="ts">
// Created by dev on 2026/04/08
import { ref, computed } from 'vue'
import type { ServiceNode, LayerData, ServiceEdge } from '../types'
import { getLayerColor } from '../types'

const props = defineProps<{
  layers: LayerData[]
  nodes: ServiceNode[]
  edges: ServiceEdge[]
  selectedNodeId: string | null
}>()

const emit = defineEmits<{
  selectNode: [node: ServiceNode]
}>()

const searchQuery = ref('')
const collapsedLayers = ref<Set<string>>(new Set())
const expandedLayers = ref<Set<string>>(new Set())
const FOLD_THRESHOLD = 8
// TODO(P2): 节点列表超过 100 项时应引入虚拟列表（如 vue-virtual-scroller）替代 slice 截断
const LIST_DISPLAY_LIMIT = 100

const filteredLayers = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return props.layers
  return props.layers
    .map(layer => ({
      ...layer,
      services: layer.services.filter(svc => {
        const node = props.nodes.find(n => n.id === svc || n.name === svc)
        if (!node) return svc.toLowerCase().includes(q)
        return node.name.toLowerCase().includes(q)
          || node.id.toLowerCase().includes(q)
          || node.description.toLowerCase().includes(q)
      }),
    }))
    .filter(layer => layer.services.length > 0)
})

const relatedNodeIds = computed<Set<string>>(() => {
  if (!props.selectedNodeId) return new Set()
  const set = new Set<string>()
  for (const e of props.edges) {
    if (e.fromRepoId === props.selectedNodeId) set.add(e.toRepoId ?? e.to)
    else if (e.toRepoId === props.selectedNodeId) set.add(e.fromRepoId ?? e.from)
  }
  return set
})

function isCollapsed(layerName: string): boolean {
  return collapsedLayers.value.has(layerName)
}

function toggleCollapse(layerName: string): void {
  const s = new Set(collapsedLayers.value)
  if (s.has(layerName)) s.delete(layerName)
  else s.add(layerName)
  collapsedLayers.value = s
}

function getNodeDisplayName(nameOrId: string): string {
  const node = props.nodes.find(n => n.id === nameOrId || n.name === nameOrId)
  return node?.name ?? nameOrId.split('/').pop() ?? nameOrId
}

function getNodeTechStack(nameOrId: string): string {
  const node = props.nodes.find(n => n.name === nameOrId || n.id === nameOrId)
  return node?.techStack ?? ''
}

function findNodeByDisplayName(displayName: string, layerName: string): ServiceNode {
  const found = props.nodes.find(n => n.name === displayName || n.id === displayName)
  if (found) return found
  return { id: displayName, name: displayName, techStack: '', layer: layerName, description: '' }
}

function visibleServices(layer: LayerData): string[] {
  if (isCollapsed(layer.name) && layer.services.length > FOLD_THRESHOLD) {
    return layer.services.slice(0, FOLD_THRESHOLD)
  }
  if (layer.services.length > LIST_DISPLAY_LIMIT && !expandedLayers.value.has(layer.name)) {
    return layer.services.slice(0, LIST_DISPLAY_LIMIT)
  }
  return layer.services
}

function hiddenCount(layer: LayerData): number {
  if (isCollapsed(layer.name) && layer.services.length > FOLD_THRESHOLD) {
    return layer.services.length - FOLD_THRESHOLD
  }
  if (layer.services.length > LIST_DISPLAY_LIMIT && !expandedLayers.value.has(layer.name)) {
    return layer.services.length - LIST_DISPLAY_LIMIT
  }
  return 0
}

function showMoreLabel(layer: LayerData): string {
  if (isCollapsed(layer.name) && layer.services.length > FOLD_THRESHOLD) {
    return `+ ${hiddenCount(layer)} 更多`
  }
  return `显示更多（还有 ${hiddenCount(layer)} 项）`
}

function handleShowMore(layer: LayerData): void {
  if (isCollapsed(layer.name) && layer.services.length > FOLD_THRESHOLD) {
    toggleCollapse(layer.name)
    return
  }
  expandedLayers.value = new Set(expandedLayers.value).add(layer.name)
}

function chipClass(svcId: string): Record<string, boolean> {
  return {
    active: props.selectedNodeId === svcId,
    related: !!(props.selectedNodeId && relatedNodeIds.value.has(svcId)),
  }
}
</script>

<template>
  <div class="layer-view">
    <div v-if="nodes.length > 10" class="search-bar">
      <el-input
        v-model="searchQuery"
        placeholder="搜索服务名称..."
        clearable
        size="small"
        prefix-icon="Search"
        style="max-width: 280px"
      />
    </div>
    <div v-for="layer in filteredLayers" :key="layer.name" class="layer-group">
      <div
        class="layer-header"
        :style="{ borderLeftColor: getLayerColor(layer.name) }"
        @click="toggleCollapse(layer.name)"
      >
        <span class="layer-toggle">{{ isCollapsed(layer.name) ? '▸' : '▾' }}</span>
        {{ layer.name }}
        <el-tag size="small" type="info" class="layer-count">{{ layer.services.length }}</el-tag>
      </div>
      <div v-if="!isCollapsed(layer.name) || layer.services.length <= FOLD_THRESHOLD" class="layer-services">
        <div
          v-for="svc in visibleServices(layer)" :key="svc"
          class="service-chip"
          :class="chipClass(svc)"
          @click="emit('selectNode', findNodeByDisplayName(svc, layer.name))"
        >
          <span>{{ getNodeDisplayName(svc) }}</span>
          <el-tag v-if="getNodeTechStack(svc)" size="small" type="info" class="tech-badge">{{ getNodeTechStack(svc) }}</el-tag>
        </div>
        <div
          v-if="hiddenCount(layer) > 0"
          class="service-chip more-chip"
          @click="handleShowMore(layer)"
        >
          {{ showMoreLabel(layer) }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layer-view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.search-bar {
  margin-bottom: 4px;
}
.layer-group {
  border: 1px solid var(--mf-border, rgba(0,229,255,0.12));
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--mf-bg-surface, rgba(15,29,50,0.85));
}
.layer-header {
  font-weight: 600;
  font-size: 14px;
  color: var(--mf-primary, #00e5ff);
  padding-left: 10px;
  border-left: 3px solid var(--mf-primary, #00e5ff);
  margin-bottom: 8px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
.layer-toggle {
  font-size: 11px;
  color: var(--mf-text-muted, #4a6478);
  width: 12px;
}
.layer-count {
  margin-left: auto;
  transform: scale(0.9);
}
.layer-services {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.service-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-radius: 6px;
  background: var(--mf-bg-deep, #0a1628);
  color: var(--mf-text-secondary, #8ba4b8);
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  cursor: pointer;
  border: 1px solid var(--mf-border, rgba(0,229,255,0.12));
}
.tech-badge {
  transform: scale(0.8);
  padding: 0 3px;
}
.service-chip:hover {
  background: var(--mf-primary-dim, rgba(91,155,213,0.1));
  color: var(--mf-primary, #5b9bd5);
  border-color: var(--mf-border-active, rgba(91,155,213,0.25));
}
.service-chip.active {
  background: var(--mf-primary, #5b9bd5);
  color: #fff;
  border-color: var(--mf-primary, #5b9bd5);
  box-shadow: 0 0 16px var(--mf-primary-glow, rgba(0,229,255,0.4));
  font-weight: 600;
}
.service-chip.active :deep(.tech-badge) {
  background: rgba(255,255,255,0.2) !important;
  color: #fff !important;
  border-color: rgba(255,255,255,0.3) !important;
}
.service-chip.related {
  border-color: var(--mf-warning, #e5a84b);
  background: rgba(229,168,75,0.08);
}
.service-chip.active.related {
  background: var(--mf-primary, #5b9bd5);
  color: #fff;
  border-color: var(--mf-primary, #5b9bd5);
}
.more-chip {
  background: transparent;
  color: var(--mf-text-muted, #5a6170);
  border: 1px dashed var(--mf-border-active, rgba(91,155,213,0.25));
  font-size: 12px;
}
.more-chip:hover {
  color: #409eff;
  border-color: #409eff;
}
</style>
