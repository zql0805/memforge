<script setup lang="ts">
// Created by dev on 2026/06/10
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import type { CallGraphNode, CallGraphEdge, InterfaceDetail } from '../../../../api/client'
import { getEdgeInterfaces } from '../../../../api/client'
import type { Graph as G6Graph, EdgeData, NodeData } from '@antv/g6'

interface G6NodeData {
  degree?: number
  label?: string
  traffic1dAvg?: number
}

interface G6NodeClickEvent {
  target?: { id?: string }
  originalEvent?: MouseEvent
}

function g6NodeData(d: EdgeData | NodeData): G6NodeData {
  return (d.data ?? {}) as G6NodeData
}

const props = defineProps<{
  nodes: CallGraphNode[]
  edges: CallGraphEdge[]
  productLine: string
}>()

const emit = defineEmits<{
  (e: 'select-nodes', ids: string[]): void
}>()

const containerRef = ref<HTMLDivElement>()
let graphInstance: G6Graph | null = null

const selectedNodeIds = ref<Set<string>>(new Set())
// 按需加载的接口详情
const loadedInterfaces = ref<InterfaceDetail[]>([])
const loadingInterfaces = ref(false)
// 当前已展开的聚合边 ID
let expandedEdgeId: string | null = null

const selectedNodes = computed<CallGraphNode[]>(() => {
  return props.nodes.filter(n => selectedNodeIds.value.has(n.id))
})

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function getNeighborIds(selected: Set<string>): Set<string> {
  const neighbors = new Set<string>()
  for (const edge of props.edges) {
    if (selected.has(edge.source)) neighbors.add(edge.target)
    if (selected.has(edge.target)) neighbors.add(edge.source)
  }
  return neighbors
}

/**
 * 收起已展开的详情边，恢复聚合边
 */
function collapseExpandedEdge() {
  if (!graphInstance || !expandedEdgeId) return
  try {
    // 删除动态添加的详情边
    const edgeData = graphInstance.getEdgeData()
    const detailIds = edgeData
      .filter(e => e.id?.startsWith(`${expandedEdgeId}__d`))
      .map(e => e.id!)
    if (detailIds.length > 0) {
      graphInstance.removeData({ edges: detailIds })
    }
    // 恢复聚合边
    graphInstance.showElement(expandedEdgeId)
  } catch { /* ignore */ }
  expandedEdgeId = null
}

/**
 * 选中两个有连接的节点时，加载接口详情并展开边
 */
async function loadInterfacesIfNeeded() {
  const sel = selectedNodeIds.value

  // 先收起之前展开的
  collapseExpandedEdge()

  if (sel.size !== 2) {
    loadedInterfaces.value = []
    return
  }
  const [a, b] = [...sel]
  const edge = props.edges.find(e =>
    (e.source === a && e.target === b) || (e.source === b && e.target === a),
  )
  if (!edge || edge.interfaceCount === 0) {
    loadedInterfaces.value = []
    return
  }
  loadingInterfaces.value = true
  try {
    const { interfaces } = await getEdgeInterfaces(props.productLine, edge.source, edge.target)
    loadedInterfaces.value = interfaces
    // 展开边分裂
    if (interfaces.length > 1 && graphInstance) {
      expandedEdgeId = edge.id
      graphInstance.hideElement(edge.id)
      const detailEdges = interfaces.map((iface, idx) => ({
        id: `${edge.id}__d${idx}`,
        source: edge.source,
        target: edge.target,
        data: {
          traffic1dAvg: iface.traffic1dAvg,
          label: iface.methodName || iface.url.split('/').pop() || iface.url,
          isDetail: true,
        },
      }))
      graphInstance.addData({ edges: detailEdges })
      await graphInstance.draw()
    }
  } catch {
    loadedInterfaces.value = []
  } finally {
    loadingInterfaces.value = false
  }
}

// 选中的边源/目标信息
const selectedEdgeInfo = computed(() => {
  const sel = selectedNodeIds.value
  if (sel.size !== 2) return null
  const [a, b] = [...sel]
  const edge = props.edges.find(e =>
    (e.source === a && e.target === b) || (e.source === b && e.target === a),
  )
  if (!edge) return null
  return { source: edge.source, target: edge.target, protocol: edge.protocol }
})

/**
 * 根据选中节点更新图中所有元素的透明度
 */
async function applySelectionFilter() {
  if (!graphInstance) return
  const selected = selectedNodeIds.value

  if (selected.size === 0) {
    for (const n of props.nodes) {
      graphInstance.setElementState(n.id, [])
    }
    for (const e of props.edges) {
      graphInstance.setElementState(e.id, [])
    }
  } else {
    const neighbors = getNeighborIds(selected)
    const relatedNodes = new Set([...selected, ...neighbors])

    for (const n of props.nodes) {
      const state = relatedNodes.has(n.id) ? (selected.has(n.id) ? ['selected'] : []) : ['inactive']
      graphInstance.setElementState(n.id, state)
    }
    for (const e of props.edges) {
      const isRelated = (selected.has(e.source) || selected.has(e.target)) &&
                        (relatedNodes.has(e.source) && relatedNodes.has(e.target))
      graphInstance.setElementState(e.id, isRelated ? [] : ['inactive'])
    }
  }

  await graphInstance.draw()
  // 选中两个节点时加载接口
  loadInterfacesIfNeeded()
}

async function initGraph() {
  if (!containerRef.value) return
  const { Graph } = await import('@antv/g6')

  if (graphInstance) {
    graphInstance.destroy()
    graphInstance = null
  }

  selectedNodeIds.value.clear()
  loadedInterfaces.value = []
  expandedEdgeId = null

  // 计算每个节点的度数（边数）
  const degreeMap = new Map<string, number>()
  for (const e of props.edges) {
    degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1)
    degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1)
  }

  const g6Nodes = props.nodes.map(n => ({
    id: n.id,
    data: { label: n.name, techStack: n.techStack, appKey: n.appKey, degree: degreeMap.get(n.id) ?? 0 },
  }))

  const g6Edges = props.edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    data: {
      protocol: e.protocol,
      traffic1dAvg: e.traffic1dAvg,
      interfaceCount: e.interfaceCount,
    },
  }))

  graphInstance = new Graph({
    container: containerRef.value,
    autoFit: 'view',
    data: { nodes: g6Nodes, edges: g6Edges as EdgeData[] },
    layout: {
      type: 'd3-force',
      preventOverlap: true,
      nodeSize: 80,
      linkDistance: 250,
      nodeStrength: -800,
    },
    node: {
      style: {
        size: (d: NodeData) => {
          const degree = g6NodeData(d).degree ?? 0
          return Math.max(36, 36 + Math.min(degree, 8) * 3)
        },
        labelText: (d: NodeData) => g6NodeData(d).label ?? d.id ?? '',
        labelFontSize: 11,
        labelFill: '#fff',
        labelPlacement: 'center',
        fill: '#4A90D9',
        stroke: '#fff',
        lineWidth: 2,
        opacity: 1,
      },
      state: {
        selected: { stroke: '#E6A23C', lineWidth: 3, fill: '#E6A23C', opacity: 1 },
        neighbor: { opacity: 0.6 },
        inactive: { opacity: 0.12 },
      },
    },
    edge: {
      style: {
        lineWidth: (d: EdgeData) => {
          const t = g6NodeData(d).traffic1dAvg ?? 0
          return Math.max(1, Math.min(6, Math.log10(t + 1) * 1.5))
        },
        stroke: (d: EdgeData) => {
          const data = g6NodeData(d)
          if ((data as any).isDetail) return '#E6A23C'
          return (data.traffic1dAvg ?? 0) > 0 ? '#67C23A' : '#DCDFE6'
        },
        lineDash: (d: EdgeData) => (g6NodeData(d).traffic1dAvg ?? 0) === 0 ? [4, 4] : undefined,
        endArrow: true,
        opacity: 1,
        labelText: (d: EdgeData) => {
          const data = g6NodeData(d) as any
          return data.isDetail ? (data.label ?? '') : ''
        },
        labelFontSize: 9,
        labelFill: '#606266',
        labelBackground: true,
        labelBackgroundFill: 'rgba(255,255,255,0.85)',
        labelBackgroundRadius: 3,
      },
      state: {
        neighbor: { opacity: 0.6 },
        inactive: { opacity: 0.12 },
      },
    },
    transforms: [{ type: 'process-parallel-edges', distance: 30 }],
    plugins: [{ type: 'minimap', position: 'right-bottom' }],
    behaviors: ['zoom-canvas', 'drag-canvas', 'drag-element'],
  })


  graphInstance.on('node:click', (evt) => {
    const event = evt as unknown as G6NodeClickEvent
    const nodeId = event.target?.id
    if (!nodeId) return

    const isShift = event.originalEvent?.shiftKey ?? false

    if (isShift || selectedNodeIds.value.has(nodeId)) {
      if (selectedNodeIds.value.has(nodeId)) {
        selectedNodeIds.value.delete(nodeId)
      } else {
        selectedNodeIds.value.add(nodeId)
      }
    } else {
      selectedNodeIds.value.clear()
      selectedNodeIds.value.add(nodeId)
    }

    applySelectionFilter()
    emit('select-nodes', [...selectedNodeIds.value])
  })

  graphInstance.on('canvas:click', () => {
    selectedNodeIds.value.clear()
    applySelectionFilter()
    emit('select-nodes', [])
  })

  await graphInstance.render()
}

onMounted(() => {
  nextTick(() => initGraph())
})

onBeforeUnmount(() => {
  if (graphInstance) {
    graphInstance.destroy()
    graphInstance = null
  }
})

watch(() => [props.nodes, props.edges], () => {
  nextTick(() => initGraph())
}, { deep: true })
</script>

<template>
  <div class="cg-layout">
    <!-- 左侧画布 -->
    <div class="cg-canvas-wrapper">
      <div ref="containerRef" class="cg-canvas" />
    </div>

    <!-- 右侧详情面板 -->
    <div v-if="selectedNodes.length > 0" class="cg-side-panel">
      <!-- 接口调用（在上） -->
      <div v-if="loadingInterfaces" class="panel-section">
        <div class="panel-section-title">接口调用</div>
        <div class="loading-hint">加载中...</div>
      </div>
      <div v-else-if="loadedInterfaces.length > 0 && selectedEdgeInfo" class="panel-section">
        <div class="panel-section-title">接口调用</div>
        <div class="edge-detail-block">
          <div class="edge-detail-header">
            {{ selectedEdgeInfo.source.split('/').pop() }} → {{ selectedEdgeInfo.target.split('/').pop() }}
            <el-tag size="small" type="warning">{{ selectedEdgeInfo.protocol }}</el-tag>
            <span class="iface-count">{{ loadedInterfaces.length }} 个接口</span>
          </div>
          <table class="edge-detail-table">
            <thead>
              <tr>
                <th>URI</th>
                <th>方法</th>
                <th>日均</th>
                <th>峰值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(iface, idx) in loadedInterfaces" :key="idx">
                <td class="td-url">{{ iface.url }}</td>
                <td>{{ iface.methodName || '-' }}</td>
                <td class="td-num">{{ fmtNum(iface.traffic1dAvg) }}</td>
                <td class="td-num">{{ fmtNum(iface.traffic1dPeak) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 节点详情（在下） -->
      <div class="panel-section">
        <div class="panel-section-title">节点详情</div>
        <div v-for="node in selectedNodes" :key="node.id" class="node-card">
          <div class="node-card-name">{{ node.name }}</div>
          <div class="node-card-row"><span class="card-label">ID:</span> {{ node.id }}</div>
          <div v-if="node.appKey" class="node-card-row"><span class="card-label">AppKey:</span> {{ node.appKey }}</div>
          <div v-if="node.techStack" class="node-card-row"><span class="card-label">技术栈:</span> {{ node.techStack }}</div>
          <div v-if="node.layer" class="node-card-row"><span class="card-label">分层:</span> {{ node.layer }}</div>
          <div v-if="node.gitUrl" class="node-card-row"><span class="card-label">Git:</span> <a :href="node.gitUrl" target="_blank" class="git-link">{{ node.gitUrl }}</a></div>
          <div v-if="node.description" class="node-card-row"><span class="card-label">描述:</span> {{ node.description }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cg-layout {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 520px;
  gap: 0;
}
.cg-canvas-wrapper {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  position: relative;
}
.cg-canvas {
  width: 100%;
  height: 100%;
  min-height: 520px;
}
.cg-side-panel {
  width: 340px;
  flex-shrink: 0;
  border-left: 1px solid var(--mf-border, #dcdfe6);
  padding: 12px 14px;
  overflow-y: auto;
  max-height: 520px;
  background: var(--mf-bg-surface, #fafafa);
  position: relative;
  z-index: 10;
}
.panel-section + .panel-section {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--mf-border, #ebeef5);
}
.panel-section-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
  color: var(--mf-text-primary, #303133);
}
.node-card {
  border: 1px solid var(--mf-border, #ebeef5);
  border-radius: 6px;
  padding: 8px 12px;
  background: #fff;
  margin-bottom: 8px;
}
.node-card:last-child {
  margin-bottom: 0;
}
.node-card-name {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
  color: var(--mf-text-primary, #303133);
}
.node-card-row {
  font-size: 12px;
  color: var(--mf-text-regular, #606266);
  line-height: 1.8;
}
.card-label {
  color: var(--mf-text-muted, #909399);
  margin-right: 4px;
}
.git-link {
  color: #409EFF;
  text-decoration: none;
  word-break: break-all;
}
.git-link:hover {
  text-decoration: underline;
}
.edge-detail-block + .edge-detail-block {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--mf-border, #ebeef5);
}
.edge-detail-header {
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.iface-count {
  font-weight: normal;
  font-size: 11px;
  color: var(--mf-text-muted, #909399);
}
.edge-detail-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  display: block;
  overflow-x: auto;
}
.edge-detail-table th {
  text-align: left;
  padding: 3px 6px 3px 0;
  color: var(--mf-text-muted, #909399);
  border-bottom: 1px solid var(--mf-border, #ebeef5);
  white-space: nowrap;
}
.edge-detail-table td {
  padding: 3px 6px 3px 0;
  border-bottom: 1px solid var(--mf-border, #f5f5f5);
}
.td-url {
  font-family: 'JetBrains Mono', monospace;
  word-break: break-all;
  max-width: 200px;
}
.td-num {
  text-align: right;
  font-family: 'JetBrains Mono', monospace;
  white-space: nowrap;
}
.loading-hint {
  color: var(--mf-text-muted, #909399);
  font-size: 12px;
  padding: 8px 0;
}
</style>
