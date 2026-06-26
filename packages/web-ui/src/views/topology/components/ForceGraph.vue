<script setup lang="ts">
// Created by dev on 2026/05/09
import { computed, ref } from 'vue'
import VChart from 'vue-echarts'
import type { EChartsOption } from 'echarts'
import { use } from 'echarts/core'
import { GraphChart } from 'echarts/charts'
import { TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

use([CanvasRenderer, GraphChart, TooltipComponent, LegendComponent])
import type { ServiceNode, ServiceEdge, LayerData } from '../types'
import type { ECElementEvent } from 'echarts/core'

type GraphElementData = { id?: string; source?: string; target?: string }

function asGraphElementData(data: ECElementEvent['data']): GraphElementData | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  return data as GraphElementData
}

const props = defineProps<{
  nodes: ServiceNode[]
  edges: ServiceEdge[]
  layers: LayerData[]
  selectedNodeId: string | null
}>()

const emit = defineEmits<{
  selectNode: [node: ServiceNode]
  viewNodeDetail: [node: ServiceNode]
}>()

const contextMenu = ref<{ visible: boolean; x: number; y: number; node: ServiceNode | null }>({
  visible: false, x: 0, y: 0, node: null,
})

const edgeDetail = ref<{ visible: boolean; edge: ServiceEdge | null }>({
  visible: false, edge: null,
})

const repulsion = ref(500)
const edgeLength = ref(160)

const LAYER_PALETTE = [
  '#06B6D4', '#3B82F6', '#8B5CF6', '#F59E0B',
  '#EF4444', '#10B981', '#EC4899', '#6366F1',
  '#F97316', '#14B8A6', '#6B7280',
]

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const TECH_SYMBOLS: Record<string, string> = {
  java: 'circle',
  php: 'diamond',
  vue: 'triangle',
  node: 'roundRect',
  flutter: 'rect',
  python: 'pin',
  kotlin: 'circle',
  unknown: 'circle',
}

const nodeLayerMap = computed(() => {
  const m = new Map<string, string>()
  for (const node of props.nodes) {
    if (node.layer) m.set(node.id, node.layer)
  }
  return m
})

const nodeEdgeCount = computed(() => {
  const m = new Map<string, number>()
  for (const e of props.edges) {
    const src = e.fromRepoId ?? e.from
    const tgt = e.toRepoId ?? e.to
    m.set(src, (m.get(src) ?? 0) + 1)
    m.set(tgt, (m.get(tgt) ?? 0) + 1)
  }
  return m
})

const graphOption = computed<EChartsOption>(() => {
  const layerNames = props.layers.length > 0
    ? props.layers.map(l => l.name)
    : ['全部']

  const categories = layerNames.map((name, i) => ({
    name,
    itemStyle: { color: LAYER_PALETTE[i % LAYER_PALETTE.length] },
  }))

  const categoryIndex = new Map<string, number>()
  categories.forEach((c, i) => categoryIndex.set(c.name, i))

  const graphNodes = props.nodes.map(n => {
    const layer = nodeLayerMap.value.get(n.id) ?? layerNames[0]
    const catIdx = categoryIndex.get(layer) ?? 0
    const isSelected = n.id === props.selectedNodeId
    const degree = nodeEdgeCount.value.get(n.id) ?? 0
    const baseSize = Math.max(16, Math.min(40, 16 + degree * 3))

    return {
      id: n.id,
      name: n.name,
      category: catIdx,
      symbol: TECH_SYMBOLS[n.techStack?.toLowerCase()] ?? 'circle',
      symbolSize: isSelected ? baseSize + 12 : baseSize,
      itemStyle: isSelected
        ? {
            borderColor: '#fff',
            borderWidth: 3,
            shadowBlur: 16,
            shadowColor: 'rgba(59,130,246,0.6)',
          }
        : {
            borderColor: 'rgba(255,255,255,0.15)',
            borderWidth: 1,
          },
      label: {
        show: true,
        fontSize: isSelected ? 13 : 11,
        fontWeight: isSelected ? ('bold' as const) : ('normal' as const),
        color: '#e4e7ec',
        backgroundColor: 'rgba(30, 34, 43, 0.75)',
        padding: [2, 6],
        borderRadius: 3,
      },
    }
  })

  const edgeIdSet = new Set(props.nodes.map(n => n.id))
  const nameToId = new Map(props.nodes.map(n => [n.name, n.id]))

  const graphEdges = props.edges
    .map(e => {
      const src = e.fromRepoId && edgeIdSet.has(e.fromRepoId) ? e.fromRepoId : nameToId.get(e.from)
      const tgt = e.toRepoId && edgeIdSet.has(e.toRepoId) ? e.toRepoId : nameToId.get(e.to)
      if (!src || !tgt) return null
      const isHighlighted = src === props.selectedNodeId || tgt === props.selectedNodeId
      return {
        source: src,
        target: tgt,
        lineStyle: {
          width: isHighlighted ? 2.5 : 1.2,
          opacity: props.selectedNodeId ? (isHighlighted ? 0.9 : 0.12) : 0.35,
          curveness: 0.25,
          color: isHighlighted ? '#60a5fa' : 'rgba(140, 150, 170, 0.5)',
        },
        label: {
          show: isHighlighted,
          formatter: escHtml(e.protocol ?? ''),
          fontSize: 10,
          color: '#a0aec0',
          backgroundColor: 'rgba(30, 34, 43, 0.8)',
          padding: [1, 4],
          borderRadius: 2,
        },
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(30, 34, 43, 0.95)',
      borderColor: 'rgba(255,255,255,0.1)',
      textStyle: { color: '#e4e7ec', fontSize: 12 },
      formatter: (p) => {
        const params = (Array.isArray(p) ? p[0] : p) as ECElementEvent
        const data = asGraphElementData(params.data)
        if (params.dataType === 'node') {
          const node = props.nodes.find(n => n.id === data?.id)
          if (!node) return escHtml(String(params.name ?? ''))
          return `<strong style="font-size:14px">${escHtml(node.name)}</strong><br/>
            <span style="color:#8e949e">ID:</span> ${escHtml(node.id)}<br/>
            <span style="color:#8e949e">技术栈:</span> ${escHtml(node.techStack || '-')}<br/>
            <span style="color:#8e949e">层级:</span> ${escHtml(node.layer || '-')}<br/>
            <span style="color:#8e949e">连接:</span> ${nodeEdgeCount.value.get(node.id) ?? 0} 条`
        }
        if (params.dataType === 'edge' && data) {
          return `<span style="color:#8e949e">${escHtml(String(data.source ?? ''))}</span><br/>→ ${escHtml(String(data.target ?? ''))}`
        }
        return ''
      },
    },
    legend: [{
      data: categories.map(c => c.name),
      orient: 'vertical',
      left: 10,
      top: 10,
      textStyle: { fontSize: 11, color: '#c5cad3' },
      inactiveColor: '#4a5060',
    }],
    animationDuration: 800,
    animationEasingUpdate: 'quinticInOut',
    series: [{
      type: 'graph',
      layout: 'force',
      data: graphNodes,
      links: graphEdges,
      categories,
      roam: true,
      draggable: true,
      force: {
        repulsion: repulsion.value,
        edgeLength: edgeLength.value,
        gravity: 0.06,
        friction: 0.6,
        layoutAnimation: true,
      },
      emphasis: {
        focus: 'adjacency',
        lineStyle: { width: 3.5 },
        itemStyle: {
          shadowBlur: 20,
          shadowColor: 'rgba(59,130,246,0.5)',
          borderWidth: 3,
        },
      },
      edgeSymbol: ['none', 'arrow'],
      edgeSymbolSize: [0, 10],
      label: {
        show: true,
        position: 'bottom',
        distance: 6,
        fontSize: 11,
        color: '#e4e7ec',
      },
      lineStyle: {
        color: 'rgba(140, 150, 170, 0.5)',
        curveness: 0.25,
      },
    }],
  }
})

function handleClick(params: ECElementEvent): void {
  contextMenu.value.visible = false
  const data = asGraphElementData(params.data)
  if (params.dataType === 'node' && data?.id) {
    const node = props.nodes.find(n => n.id === data.id)
    if (node) emit('selectNode', node)
  }
  if (params.dataType === 'edge' && data?.source && data?.target) {
    const edge = props.edges.find(e => {
      const src = e.fromRepoId ?? e.from
      const tgt = e.toRepoId ?? e.to
      return src === data.source && tgt === data.target
    })
    if (edge) {
      edgeDetail.value = { visible: true, edge }
    }
  }
}

function handleContextMenu(params: ECElementEvent): void {
  const data = asGraphElementData(params.data)
  if (params.dataType === 'node' && data?.id) {
    params.event?.event?.preventDefault?.()
    const node = props.nodes.find(n => n.id === data.id)
    if (node) {
      const mouseEvent = params.event?.event as MouseEvent | undefined
      contextMenu.value = {
        visible: true,
        x: mouseEvent?.clientX ?? 0,
        y: mouseEvent?.clientY ?? 0,
        node,
      }
    }
  }
}

function onMenuAction(action: string): void {
  const node = contextMenu.value.node
  contextMenu.value.visible = false
  if (!node) return
  if (action === 'select') emit('selectNode', node)
  if (action === 'detail') emit('viewNodeDetail', node)
}

function closeContextMenu(): void {
  contextMenu.value.visible = false
}
</script>

<template>
  <div class="force-graph-container" @click="closeContextMenu">
    <div class="graph-controls">
      <label>斥力 <el-slider v-model="repulsion" :min="50" :max="1200" :step="10" style="width: 120px; display: inline-flex; vertical-align: middle; margin: 0 8px" /></label>
      <label>边长 <el-slider v-model="edgeLength" :min="30" :max="400" :step="10" style="width: 120px; display: inline-flex; vertical-align: middle; margin: 0 8px" /></label>
    </div>
    <v-chart
      :option="graphOption"
      autoresize
      class="force-chart"
      @click="handleClick"
      @contextmenu="handleContextMenu"
    />

    <!-- 节点右键菜单 -->
    <Teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="ctx-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      >
        <div class="ctx-menu-title">{{ contextMenu.node?.name }}</div>
        <div class="ctx-menu-item" @click.stop="onMenuAction('select')">高亮调用链</div>
        <div class="ctx-menu-item" @click.stop="onMenuAction('detail')">查看项目百科</div>
      </div>
    </Teleport>

    <!-- 边详情对话框 -->
    <el-dialog v-model="edgeDetail.visible" title="调用关系详情" width="420px" destroy-on-close>
      <template v-if="edgeDetail.edge">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="调用方">{{ edgeDetail.edge.from }}</el-descriptions-item>
          <el-descriptions-item label="被调用方">{{ edgeDetail.edge.to }}</el-descriptions-item>
          <el-descriptions-item label="协议">
            <el-tag size="small">{{ edgeDetail.edge.protocol ?? '-' }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item v-if="edgeDetail.edge.fromRepoId" label="调用方 RepoId">
            {{ edgeDetail.edge.fromRepoId }}
          </el-descriptions-item>
          <el-descriptions-item v-if="edgeDetail.edge.toRepoId" label="被调用方 RepoId">
            {{ edgeDetail.edge.toRepoId }}
          </el-descriptions-item>
        </el-descriptions>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.force-graph-container {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 500px;
}
.graph-controls {
  position: absolute;
  top: 8px;
  right: 12px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 16px;
  background: rgba(30, 34, 43, 0.85);
  backdrop-filter: blur(6px);
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 12px;
  color: #c5cad3;
  box-shadow: 0 2px 8px rgba(0,0,0,0.25);
  border: 1px solid rgba(255,255,255,0.06);
}
.force-chart {
  width: 100%;
  height: 100%;
  min-height: 500px;
}
.ctx-menu {
  position: fixed;
  z-index: 9999;
  min-width: 140px;
  background: rgba(30, 34, 43, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  padding: 4px 0;
  backdrop-filter: blur(8px);
}
.ctx-menu-title {
  padding: 6px 14px;
  font-size: 12px;
  color: #8e949e;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.ctx-menu-item {
  padding: 8px 14px;
  font-size: 13px;
  color: #e4e7ec;
  cursor: pointer;
  transition: background 0.15s;
}
.ctx-menu-item:hover {
  background: rgba(59, 130, 246, 0.15);
  color: #93bbfc;
}
</style>
