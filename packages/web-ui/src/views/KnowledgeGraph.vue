<template>
  <div class="knowledge-graph-page">
    <!-- 统计概览 -->
    <el-row :gutter="16" style="margin-bottom: 16px">
      <el-col :span="6">
        <el-card shadow="never" class="stat-card" body-style="padding: 16px">
          <div class="stat-number">{{ stats.memories }}</div>
          <div class="stat-label">记忆条目</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="stat-card" body-style="padding: 16px">
          <div class="stat-number stat-rule">{{ stats.rules }}</div>
          <div class="stat-label">编码规范</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="stat-card" body-style="padding: 16px">
          <div class="stat-number stat-edge">{{ graphEdges.length }}</div>
          <div class="stat-label">当前关联边</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="stat-card" body-style="padding: 16px">
          <div class="stat-number stat-node">{{ graphNodes.length }}</div>
          <div class="stat-label">当前图谱节点</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 快速探索 -->
    <el-card v-if="quickEntries.length > 0 && graphNodes.length === 0" shadow="never" style="margin-bottom: 16px">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center">
          <span>快速探索</span>
          <el-button text type="primary" size="small" @click="loadQuickEntries">刷新推荐</el-button>
        </div>
      </template>
      <div class="quick-entries">
        <div
          v-for="item in quickEntries"
          :key="item.id"
          class="quick-entry-chip"
          @click="loadGraph(item.id, item.type)"
        >
          <span class="chip-icon">{{ nodeIcon(item.type) }}</span>
          <span class="chip-text">{{ truncLabel(item.title, 28) }}</span>
          <el-tag v-if="item.scope" size="small" type="info" style="margin-left: 4px">{{ item.scope }}</el-tag>
        </div>
      </div>
    </el-card>

    <el-card>
      <template #header>
        <div class="card-header">
          <span>知识图谱</span>
          <div class="search-bar">
            <el-input
              v-model="searchQuery"
              placeholder="搜索记忆或规则..."
              prefix-icon="Search"
              style="width: 280px"
              clearable
              @keyup.enter="handleSearch"
            />
            <el-select v-model="searchType" style="width: 100px">
              <el-option label="记忆" value="entry" />
              <el-option label="规则" value="rule" />
            </el-select>
            <el-button type="primary" :loading="searchLoading" @click="handleSearch">查询图谱</el-button>
          </div>
        </div>
      </template>

      <div class="graph-container" v-loading="searchLoading">
        <!-- SVG 图谱可视化 -->
        <div v-if="graphNodes.length > 0" class="graph-visual">
          <svg ref="svgRef" :width="svgWidth" :height="svgHeight" class="graph-svg">
            <!-- 边 -->
            <line
              v-for="(edge, i) in layoutEdges"
              :key="'e' + i"
              :x1="edge.x1" :y1="edge.y1"
              :x2="edge.x2" :y2="edge.y2"
              class="graph-edge"
              :class="'edge-' + edge.relation"
            />
            <!-- 边标签 -->
            <text
              v-for="(edge, i) in layoutEdges"
              :key="'el' + i"
              :x="(edge.x1 + edge.x2) / 2"
              :y="(edge.y1 + edge.y2) / 2 - 6"
              class="edge-label"
            >{{ relationLabel(edge.relation) }}</text>
            <!-- 节点 -->
            <g
              v-for="node in layoutNodes"
              :key="node.id"
              :transform="`translate(${node.x}, ${node.y})`"
              class="graph-node-g"
              :class="{ 'node-center': node.isCenter }"
              @click="handleNodeClick(node)"
            >
              <circle
                :r="node.isCenter ? 28 : 22"
                :class="'node-circle node-' + node.type"
              />
              <text class="node-icon" dy="5" text-anchor="middle">{{ nodeIcon(node.type) }}</text>
              <text
                class="node-text"
                :dy="node.isCenter ? 44 : 38"
                text-anchor="middle"
              >{{ truncLabel(node.label, 12) }}</text>
            </g>
          </svg>
        </div>

        <el-empty v-if="!searchLoading && graphNodes.length === 0"
          description="选择一个记忆或规则作为中心节点，或从上方「快速探索」选择"
        >
          <template #image>
            <div style="font-size: 48px">🔗</div>
          </template>
        </el-empty>

        <!-- 关系列表 -->
        <div v-if="graphEdges.length > 0" class="edge-table">
          <el-divider>关系连线 ({{ graphEdges.length }} 条)</el-divider>
          <el-table :data="graphEdges" size="small" stripe max-height="300">
            <el-table-column label="源节点" min-width="180">
              <template #default="{ row }">
                <el-tag size="small" :type="nodeTagType(row.sourceType)">
                  {{ nodeIcon(row.sourceType) }} {{ truncLabel(row.source, 25) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="关系" width="100">
              <template #default="{ row }">
                {{ relationLabel(row.relation) }}
              </template>
            </el-table-column>
            <el-table-column label="目标节点" min-width="180">
              <template #default="{ row }">
                <el-tag size="small" :type="nodeTagType(row.targetType)">
                  {{ nodeIcon(row.targetType) }} {{ truncLabel(row.target, 25) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="置信度" width="80" align="center">
              <template #default="{ row }">
                <el-tag :type="confidenceType(row.confidence)" size="small" effect="plain">
                  {{ typeof row.confidence === 'number' ? (row.confidence * 100).toFixed(0) + '%' : '-' }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </el-card>

    <!-- 节点详情面板 -->
    <el-drawer v-model="showNodeDetail" title="节点详情" direction="rtl" size="400px">
      <template v-if="selectedNodeDetail">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="标题">{{ selectedNodeDetail.title }}</el-descriptions-item>
          <el-descriptions-item label="类型">
            <el-tag size="small">{{ selectedNodeDetail.scope ?? selectedNodeDetail.category ?? '-' }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item v-if="selectedNodeDetail.tags?.length" label="标签">
            <el-tag v-for="t in selectedNodeDetail.tags" :key="t" size="small" style="margin-right: 4px">{{ t }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item v-if="selectedNodeDetail.severity" label="严重性">
            {{ selectedNodeDetail.severity }}
          </el-descriptions-item>
          <el-descriptions-item v-if="selectedNodeDetail.created_at" label="创建时间">
            {{ new Date(selectedNodeDetail.created_at).toLocaleDateString() }}
          </el-descriptions-item>
        </el-descriptions>
        <el-divider />
        <div v-if="selectedNodeDetail.content || selectedNodeDetail.description" class="node-detail-content">
          {{ selectedNodeDetail.content || selectedNodeDetail.description }}
        </div>
      </template>
    </el-drawer>

    <!-- 搜索结果 -->
    <el-dialog v-model="showSearchResults" title="选择中心节点" width="650px">
      <el-table :data="searchResults" size="small" highlight-current-row @row-click="selectCenterNode" style="cursor: pointer">
        <el-table-column label="标题" min-width="250">
          <template #default="{ row }">
            <span>{{ row.title }}</span>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag size="small">{{ row.scope }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="相似度" width="80" align="center">
          <template #default="{ row }">
            {{ row.similarity ? (row.similarity * 100).toFixed(0) + '%' : '-' }}
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
// Created by dev on 2026/04/07
import { ref, computed, onMounted } from 'vue'
import { getKnowledgeGraph, recallMemory, listRules, listMemories, getRule, type KnowledgeGraphResult } from '../api/mcp-tools'
import { useAuthStore } from '../stores/auth'
import { useProjectContext } from '../stores/project-context'
import { ElMessage } from 'element-plus'

const authStore = useAuthStore()
const projectCtx = useProjectContext()
const searchQuery = ref('')
const searchType = ref('entry')
const searchLoading = ref(false)
const showSearchResults = ref(false)
const showNodeDetail = ref(false)
const centerId = ref('')

const stats = ref({ memories: 0, rules: 0 })
const quickEntries = ref<Array<{ id: string; title: string; type: string; scope?: string }>>([])
interface NodeDetail {
  title: string
  content?: string
  description?: string
  scope?: string
  category?: string
  tags?: string[]
  severity?: string
  created_at?: string
}
const selectedNodeDetail = ref<NodeDetail | null>(null)

const searchResults = ref<Array<{ id: string; title: string; scope: string; similarity?: number }>>([])
const graphNodes = ref<KnowledgeGraphResult['nodes']>([])
const graphEdges = ref<KnowledgeGraphResult['edges']>([])

const svgWidth = 700
const svgHeight = 400

async function loadStats(): Promise<void> {
  if (!authStore.isAuthenticated) return
  try {
    const [memResult, ruleResult] = await Promise.all([
      listMemories({ page: 1, page_size: 1, ...projectCtx.queryParams }),
      listRules({ page: 1, page_size: 1, ...projectCtx.queryParams }),
    ])
    stats.value.memories = memResult.pagination?.total ?? 0
    stats.value.rules = ruleResult.pagination?.total ?? 0
  } catch (e) {
    console.error('加载知识图谱统计失败:', e)
  }
}

async function loadQuickEntries(): Promise<void> {
  if (!authStore.isAuthenticated) return
  try {
    const scopes = ['architecture', 'bug_pattern', 'coding_standard', 'lesson_learned', 'performance_insight']
    const randomScope = scopes[Math.floor(Math.random() * scopes.length)]
    const opts: Record<string, unknown> = { scope_filter: [randomScope] }
    if (projectCtx.selectedProductLine) opts.product_line = projectCtx.selectedProductLine
    else opts.cross_project = true
    const result = await recallMemory(randomScope, 8, opts as Parameters<typeof recallMemory>[2])
    const items: typeof quickEntries.value = []
    if (result.success) {
      for (const r of result.results) {
        items.push({ id: r.id, title: r.title, type: 'entry', scope: r.scope })
      }
    }
    const ruleResult = await listRules({ page: 1, page_size: 4, ...projectCtx.queryParams })
    if (ruleResult.success) {
      for (const r of ruleResult.rules) {
        items.push({ id: r.id, title: r.title, type: 'rule', scope: r.category })
      }
    }
    quickEntries.value = items.slice(0, 12)
  } catch (e) {
    console.error('加载快捷入口失败:', e)
  }
}

onMounted(() => {
  loadStats()
  loadQuickEntries()
})

interface LayoutNode {
  id: string
  type: string
  label: string
  x: number
  y: number
  isCenter: boolean
}

const layoutNodes = computed<LayoutNode[]>(() => {
  if (graphNodes.value.length === 0) return []
  const cx = svgWidth / 2
  const cy = svgHeight / 2
  const radius = Math.min(svgWidth, svgHeight) * 0.32

  return graphNodes.value.map((n) => {
    const isCenter = n.id === centerId.value
    if (isCenter) {
      return { id: n.id, type: n.type, label: n.label, x: cx, y: cy, isCenter: true }
    }
    const nonCenterIdx = graphNodes.value.filter(nn => nn.id !== centerId.value).indexOf(n)
    const total = graphNodes.value.length - 1
    const angle = total > 0 ? (2 * Math.PI * nonCenterIdx) / total - Math.PI / 2 : 0
    return {
      id: n.id,
      type: n.type,
      label: n.label,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      isCenter: false,
    }
  })
})

const layoutEdges = computed(() => {
  const posByLabel = new Map(layoutNodes.value.map(n => [n.label, { x: n.x, y: n.y }]))
  const posById = new Map(layoutNodes.value.map(n => [n.id, { x: n.x, y: n.y }]))
  const fallback = { x: svgWidth / 2, y: svgHeight / 2 }
  return graphEdges.value.map(e => {
    const src = posById.get(e.source) ?? posByLabel.get(e.source) ?? fallback
    const tgt = posById.get(e.target) ?? posByLabel.get(e.target) ?? fallback
    return { ...e, x1: src.x, y1: src.y, x2: tgt.x, y2: tgt.y }
  }).filter(e => !(e.x1 === e.x2 && e.y1 === e.y2))
})

async function handleSearch(): Promise<void> {
  if (!authStore.isAuthenticated) {
    ElMessage.warning('请先连接 Gateway')
    return
  }
  if (!searchQuery.value.trim()) {
    ElMessage.warning('请输入搜索关键词')
    return
  }

  searchLoading.value = true
  try {
    if (searchType.value === 'entry') {
      const recallOpts: Record<string, unknown> = {}
      if (projectCtx.selectedProductLine) recallOpts.product_line = projectCtx.selectedProductLine
      else recallOpts.cross_project = true
      const result = await recallMemory(searchQuery.value, 10, recallOpts as Parameters<typeof recallMemory>[2])
      if (result.success && result.results.length > 0) {
        searchResults.value = result.results.map(r => ({
          id: r.id,
          title: r.title,
          scope: r.scope,
          similarity: r.similarity,
        }))
        if (result.results.length === 1) {
          await loadGraph(result.results[0].id, 'entry')
        } else {
          showSearchResults.value = true
        }
      } else {
        ElMessage.info('未找到匹配的记忆')
      }
    } else {
      const recallOpts: Record<string, unknown> = { scope_filter: ['coding_standard', 'convention'] }
      if (projectCtx.selectedProductLine) recallOpts.product_line = projectCtx.selectedProductLine
      else recallOpts.cross_project = true
      const result = await recallMemory(searchQuery.value, 10, recallOpts as Parameters<typeof recallMemory>[2])
      if (result.success && result.results.length > 0) {
        searchResults.value = result.results.map(r => ({
          id: r.id,
          title: r.title,
          scope: r.scope,
          similarity: r.similarity,
        }))
        if (result.results.length === 1) {
          await loadGraph(result.results[0].id, 'entry')
        } else {
          showSearchResults.value = true
        }
      } else {
        const ruleResult = await listRules({ page: 1, page_size: 10, search: searchQuery.value.trim(), ...projectCtx.queryParams })
        if (ruleResult.success && ruleResult.rules.length > 0) {
          searchResults.value = ruleResult.rules.map(r => ({
            id: r.id,
            title: r.title,
            scope: r.category,
          }))
          showSearchResults.value = true
        } else {
          ElMessage.info('未找到匹配的规则')
        }
      }
    }
  } catch (err) {
    ElMessage.error(`搜索失败: ${(err as Error).message}`)
  } finally {
    searchLoading.value = false
  }
}

async function selectCenterNode(row: { id: string }): Promise<void> {
  showSearchResults.value = false
  const type = searchType.value === 'rule' ? 'rule' : 'entry'
  await loadGraph(row.id, type)
}

async function loadGraph(id: string, type: string): Promise<void> {
  searchLoading.value = true
  centerId.value = id
  try {
    const result = await getKnowledgeGraph(id, type, 2)
    if (result.success) {
      graphNodes.value = result.nodes ?? []
      graphEdges.value = result.edges ?? []
      if (graphNodes.value.length === 0) {
        ElMessage.info('该节点暂无知识关联。AI 对话中存储记忆时会自动建立关联。')
      }
    }
  } catch (err) {
    ElMessage.error(`图谱加载失败: ${(err as Error).message}`)
  } finally {
    searchLoading.value = false
  }
}

async function handleNodeClick(node: LayoutNode): Promise<void> {
  if (node.id === centerId.value) {
    await loadNodeDetail(node.id, node.type)
  } else {
    await loadGraph(node.id, node.type)
  }
}

async function loadNodeDetail(id: string, type: string): Promise<void> {
  try {
    if (type === 'rule') {
      const result = await getRule(id)
      if (result.success && result.rule) {
        const r = result.rule
        selectedNodeDetail.value = {
          title: r.title,
          description: r.description,
          category: r.category,
          severity: r.severity,
          created_at: r.createdAt,
        }
        showNodeDetail.value = true
      }
    } else {
      const result = await recallMemory(id, 1, { min_similarity: 0 } as Parameters<typeof recallMemory>[2])
      if (result.success && result.results.length > 0) {
        const r = result.results[0]
        selectedNodeDetail.value = {
          title: r.title,
          content: r.content,
          scope: r.scope,
          tags: r.tags,
          created_at: r.createdAt,
        }
        showNodeDetail.value = true
      }
    }
  } catch (err) {
    ElMessage.error(`加载详情失败: ${(err as Error).message}`)
  }
}

function truncLabel(label: string, max: number): string {
  if (!label) return '?'
  return label.length > max ? label.substring(0, max) + '…' : label
}

function nodeIcon(type: string): string {
  const map: Record<string, string> = { entry: '💡', rule: '📏', skill: '🎯' }
  return map[type] ?? '•'
}

function nodeTagType(type: string): '' | 'success' | 'warning' | 'danger' | 'info' {
  const map: Record<string, '' | 'success' | 'warning' | 'danger' | 'info'> = { entry: '', rule: 'warning', skill: 'success' }
  return map[type] ?? 'info'
}

function confidenceType(conf: number): '' | 'success' | 'warning' | 'danger' {
  if (conf >= 0.8) return 'success'
  if (conf >= 0.6) return ''
  return 'warning'
}

function relationLabel(type: string): string {
  const map: Record<string, string> = {
    related_to: '相关',
    evolved_from: '演化自',
    derived_from: '衍生自',
    requires: '依赖',
    demonstrates: '体现',
    contradicts: '矛盾',
    superseded_by: '替代',
    guided_by: '指导',
    caused_by: '导致',
    fixed_by: '修复',
    references: '参考',
    produced: '产出',
  }
  return map[type] ?? type
}
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.search-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}
.graph-container { min-height: 300px; }

/* SVG 图谱 */
.graph-visual {
  display: flex;
  justify-content: center;
  padding: 16px 0;
}
.graph-svg {
  background: #fafbfc;
  border-radius: 8px;
  border: 1px solid #ebeef5;
}
.graph-edge {
  stroke: #c0c4cc;
  stroke-width: 1.5;
  stroke-dasharray: 4 3;
}
.edge-references { stroke: #409eff; }
.edge-produced { stroke: #67c23a; }
.edge-guided_by { stroke: #e6a23c; }
.edge-caused_by, .edge-fixed_by { stroke: #f56c6c; }
.edge-related_to { stroke: #909399; }

.edge-label {
  font-size: 10px;
  fill: #909399;
  text-anchor: middle;
  pointer-events: none;
}

.graph-node-g {
  cursor: pointer;
}

.node-circle {
  stroke-width: 2;
}
.node-entry { fill: #ecf5ff; stroke: #409eff; }
.node-rule { fill: #fdf6ec; stroke: #e6a23c; }
.node-skill { fill: #f0f9eb; stroke: #67c23a; }

.node-center .node-circle {
  stroke-width: 3;
  filter: drop-shadow(0 2px 6px rgba(64, 158, 255, 0.3));
}

.node-icon {
  font-size: 16px;
  pointer-events: none;
}
.node-text {
  font-size: 11px;
  fill: #606266;
  pointer-events: none;
}

.edge-table { margin-top: 8px; }

/* 统计卡片 */
.stat-card { text-align: center; }
.stat-number {
  font-size: 28px;
  font-weight: 700;
  color: #409eff;
  line-height: 1.2;
}
.stat-number.stat-rule { color: #e6a23c; }
.stat-number.stat-edge { color: #67c23a; }
.stat-number.stat-node { color: #909399; }
.stat-label {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

/* 快速探索 */
.quick-entries {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.quick-entry-chip {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  border: 1px solid #ebeef5;
  border-radius: 16px;
  cursor: pointer;
  font-size: 13px;
}
.quick-entry-chip:hover {
  border-color: #409eff;
  background: #ecf5ff;
}
.chip-icon { margin-right: 4px; }
.chip-text { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 节点详情 */
.node-detail-content {
  font-size: 13px;
  line-height: 1.8;
  color: #606266;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 400px;
  overflow-y: auto;
}
</style>
