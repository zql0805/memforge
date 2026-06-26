<script setup lang="ts">
// Created by dev on 2026/04/08
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { View, Hide } from '@element-plus/icons-vue'
import { recallMemory, scanTopology as apiScanTopology, listMemories, archiveMemory, type MemoryRecallResult } from '../../api/mcp-tools'
import {
  getTopology, getTopologyProductLines, updateTopologyNode,
  getTopologyReleaseOrder, getTopologyChangeImpact,
  getMcpClients, triggerRemoteScan, subscribeScanProgress,
  getTopologyUserPaths, moveTopologyNodes, copyTopologyNodes,
  getProductLineSettings, updateProductLineSettings,
  type TopologyFullData,
  type McpClientStatus, type UserPathsCoverage,
} from '../../api/client'
import { useAuthStore } from '../../stores/auth'

import type {
  ServiceNode, ServiceEdge, PLConfig, ApiNode, ApiEdge,
  ReleaseOrderResult, ChangeImpactResult, LayerData,
} from './types'

import LayerView from './components/LayerView.vue'
import ForceGraph from './components/ForceGraph.vue'
import NodeSummary from './components/NodeSummary.vue'
import NodeDetailDrawer from './components/NodeDetailDrawer.vue'
import CallGraphQuick from './components/CallGraphQuick.vue'
import { defineAsyncComponent } from 'vue'
const CallGraphPanel = defineAsyncComponent(() => import('./components/call-graph/CallGraphPanel.vue'))
import ProductLineSelector from './components/ProductLineSelector.vue'
import ScanControl from './components/ScanControl.vue'
import ReleaseOrderDialog from './components/ReleaseOrderDialog.vue'
import ChangeImpactDialog from './components/ChangeImpactDialog.vue'
const router = useRouter()

const authStore = useAuthStore()
const loading = ref(false)
const loadingPhase = ref('')
const loadingProgress = ref(0)

// ─── 核心数据 ───
const nodes = ref<ServiceNode[]>([])
const edges = ref<ServiceEdge[]>([])
const layers = ref<LayerData[]>([])
const selectedNode = ref<ServiceNode | null>(null)
const productLines = ref<string[]>([])
const selectedProductLine = ref('')

const structuredData = ref<TopologyFullData | null>(null)
const apiEdges = ref<ApiEdge[]>([])

// ─── 编辑状态 ───
const editDrawerVisible = ref(false)
const editingNode = ref<ApiNode | null>(null)
const editForm = ref({ displayName: '', layerIndex: 0, layerName: '', description: '' })
const editSaving = ref(false)


// ─── 视图模式 ───
const viewMode = ref<'layer' | 'graph' | 'callgraph'>('layer')

// ─── 详情抽屉 ───
const detailDrawerVisible = ref(false)

// ─── 产品线配置 ───
const PL_CONFIGS_KEY = 'memforge-topology-pl-configs'
const STORAGE_KEY = 'memforge-topology-default-pl'
const KNOWN_PL_CONFIGS: Record<string, PLConfig> = {}

function loadPLConfigs(): Record<string, PLConfig> {
  try {
    const raw = localStorage.getItem(PL_CONFIGS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function savePLConfigs(configs: Record<string, PLConfig>): void {
  localStorage.setItem(PL_CONFIGS_KEY, JSON.stringify(configs))
}

function getPLConfig(name: string): PLConfig | null {
  const custom = loadPLConfigs()
  if (custom[name]) return custom[name]
  if (KNOWN_PL_CONFIGS[name]) return KNOWN_PL_CONFIGS[name]
  return null
}

const effectiveProductLine = computed(() => {
  const s = selectedProductLine.value?.trim()
  if (s) return s
  return scanProductLine.value.trim().toLowerCase()
})

const derivedServiceNames = computed(() => {
  if (nodes.value.length > 0) {
    return [...new Map(nodes.value.map(n => [n.name, n])).values()].map(n => n.name).sort()
  }
  const s = new Set<string>()
  for (const e of edges.value) { s.add(e.from); s.add(e.to) }
  return [...s].sort()
})

const inferredRepoCount = computed(() => derivedServiceNames.value.length)

const currentPLConfig = computed<PLConfig | null>(() => {
  if (!effectiveProductLine.value) return null
  const cfg = getPLConfig(effectiveProductLine.value)
  if (cfg) {
    return { ...cfg, repoCount: inferredRepoCount.value || cfg.repoCount, edgeCount: edges.value.length || cfg.edgeCount }
  }
  return { name: effectiveProductLine.value, scanRoots: [], gitPatterns: [], repoCount: inferredRepoCount.value, edgeCount: edges.value.length }
})

const graphStatsLabel = computed(() => {
  const n = inferredRepoCount.value
  const e = edges.value.length
  if (n === 0 && e === 0) return ''
  return `${n} 个服务 · ${e} 条调用链`
})

// ─── 扫描状态 ───
const scanning = ref(false)
const scanResult = ref<{ totalRepos: number; totalEdges: number; totalStored: number } | null>(null)
const scanError = ref('')
const scanProductLine = ref('')
const scanRootsText = ref('')
const forceScan = ref(false)

// ─── MCP 客户端 ───
const mcpClients = ref<McpClientStatus[]>([])
const remoteScanning = ref(false)
const remoteScanProgress = ref<{ phase: string; detail?: string; percent?: number } | null>(null)

// ─── 用户路径覆盖 ───
const userPathsCoverage = ref<UserPathsCoverage[]>([])
const totalNodesCount = computed(() => structuredData.value?.nodes.length ?? 0)
const currentUserClonedCount = computed(() => {
  if (!structuredData.value || !authStore.user) return 0
  return structuredData.value.nodes.filter(n => n.localPath).length
})

// ─── 扫描归属统计 ───
const scanContributors = computed<Array<{ userId: string; count: number; lastScanAt: string | null }>>(() => {
  if (!structuredData.value) return []
  const map = new Map<string, { count: number; lastScanAt: string | null }>()
  for (const n of structuredData.value.nodes) {
    const by = n.scannedBy ?? '_unknown_'
    const entry = map.get(by) ?? { count: 0, lastScanAt: null }
    entry.count++
    if (n.lastScannedAt && (!entry.lastScanAt || n.lastScannedAt > entry.lastScanAt)) {
      entry.lastScanAt = n.lastScannedAt
    }
    map.set(by, entry)
  }
  return [...map.entries()]
    .map(([userId, info]) => ({ userId, ...info }))
    .sort((a, b) => b.count - a.count)
})

const hasAnyOnlineClients = computed(() => mcpClients.value.length > 0)
const hasOnlineClients = computed(() => {
  const uid = authStore.user?.id
  if (!uid) return false
  return mcpClients.value.some(c => c.userId === uid)
})
const canManageProductLine = computed(() => {
  const role = authStore.role
  return role === 'admin' || role === 'lead'
})
const canEditScanConfig = computed(() => {
  return authStore.isAuthenticated
})

// ─── 发布顺序 & 变更影响 ───
const releaseOrder = ref<ReleaseOrderResult | null>(null)
const releaseOrderLoading = ref(false)
const releaseOrderDialogVisible = ref(false)
const releaseOrderError = ref('')
const changeImpact = ref<ChangeImpactResult | null>(null)
const changeImpactLoading = ref(false)
const changeImpactDialogVisible = ref(false)
const changeImpactError = ref('')
const changeImpactTargetRepoId = ref('')

// ─── 添加/编辑产品线弹窗 ───
const plDialogVisible = ref(false)
const plDialogMode = ref<'add' | 'edit'>('add')
const addPLForm = ref({ name: '', scanRoots: '', gitPatterns: '', gitToken: '' })
const addPLLoading = ref(false)
const showGitToken = ref(false)

// ─── 骨架屏数据 ───
const skeletonLayers = [
  { color: '#409eff', labelWidth: 140, chipWidths: [72, 88, 96, 68, 80, 92, 76, 84] },
  { color: '#67c23a', labelWidth: 160, chipWidths: [80, 96, 72, 88, 76, 92, 84, 68, 80, 96, 72, 88, 76, 92, 84, 68] },
  { color: '#e6a23c', labelWidth: 120, chipWidths: [88, 76, 92] },
  { color: '#f56c6c', labelWidth: 100, chipWidths: [76, 88, 72, 96, 80, 68, 92, 84, 76, 88, 72, 96, 80, 68, 92, 84, 76, 88, 72, 96, 80, 68, 92, 84, 76, 88, 72, 96, 80, 68] },
  { color: '#909399', labelWidth: 110, chipWidths: [84, 76, 88, 72, 96, 80] },
  { color: '#b37feb', labelWidth: 130, chipWidths: [92, 76] },
]

const hasTopologyPartialData = computed(
  () => layers.value.length === 0 && (nodes.value.length > 0 || edges.value.length > 0),
)

// ─── 节点操作 ───
function selectNode(node: ServiceNode): void {
  selectedNode.value = selectedNode.value?.id === node.id ? null : node
}

function findNodeByDisplayName(displayName: string, layerName: string): ServiceNode {
  const found = nodes.value.find(n => n.name === displayName || n.id === displayName)
  if (found) return found
  return { id: displayName, name: displayName, techStack: '', layer: layerName, description: '' }
}

function openDetailDrawer(): void {
  detailDrawerVisible.value = true
}

function openEditDrawer(node: ServiceNode): void {
  if (!canManageProductLine.value) {
    ElMessage.warning('仅管理员和 Leader 可编辑拓扑数据')
    return
  }
  const apiNode = structuredData.value?.nodes.find(n => n.repoId === node.id)
  if (!apiNode) {
    ElMessage.warning('该节点暂不支持编辑（仅从记忆解析的节点需重新扫描后编辑）')
    return
  }
  editingNode.value = apiNode
  editForm.value = {
    displayName: apiNode.displayName,
    layerIndex: apiNode.layerIndex,
    layerName: apiNode.layerName ?? '',
    description: apiNode.description ?? '',
  }
  editDrawerVisible.value = true
}

async function saveNodeEdit(): Promise<void> {
  if (!editingNode.value || !selectedProductLine.value) return
  editSaving.value = true
  try {
    await updateTopologyNode(selectedProductLine.value, editingNode.value.repoId, {
      displayName: editForm.value.displayName,
      layerIndex: editForm.value.layerIndex,
      layerName: editForm.value.layerName || undefined,
      description: editForm.value.description || undefined,
    })
    editDrawerVisible.value = false
    ElMessage.success('节点已更新')
    await loadTopology()
  } catch (err) {
    ElMessage.error((err as Error).message || '保存失败')
  } finally {
    editSaving.value = false
  }
}

// ─── 发布顺序 & 变更影响 ───
async function loadReleaseOrder(): Promise<void> {
  if (!selectedProductLine.value || !structuredData.value) return
  releaseOrderLoading.value = true
  releaseOrderError.value = ''
  try {
    releaseOrder.value = await getTopologyReleaseOrder(selectedProductLine.value)
    releaseOrderDialogVisible.value = true
  } catch (err) {
    releaseOrderError.value = (err as Error).message || '加载发布顺序失败'
    releaseOrderDialogVisible.value = true
  } finally {
    releaseOrderLoading.value = false
  }
}

async function openChangeImpactDialog(): Promise<void> {
  if (!selectedNode.value || !selectedProductLine.value) return
  changeImpactTargetRepoId.value = selectedNode.value.id
  changeImpactLoading.value = true
  changeImpactError.value = ''
  changeImpactDialogVisible.value = true
  try {
    changeImpact.value = await getTopologyChangeImpact(selectedProductLine.value, selectedNode.value.id)
  } catch (err) {
    changeImpactError.value = (err as Error).message || '加载变更影响失败'
  } finally {
    changeImpactLoading.value = false
  }
}

// ─── 产品线管理 ───
function showAddPLDialog(): void {
  plDialogMode.value = 'add'
  addPLForm.value = { name: '', scanRoots: '', gitPatterns: '', gitToken: '' }
  showGitToken.value = false
  plDialogVisible.value = true
}

async function showEditPLDialog(): Promise<void> {
  const cfg = currentPLConfig.value
  if (!cfg) return
  plDialogMode.value = 'edit'
  addPLForm.value = {
    name: cfg.name,
    scanRoots: cfg.scanRoots.join('\n'),
    gitPatterns: cfg.gitPatterns.join('\n'),
    gitToken: '',
  }
  showGitToken.value = false
  plDialogVisible.value = true
  try {
    const settings = await getProductLineSettings(cfg.name)
    if (settings.has_git_token) {
      addPLForm.value.gitToken = (settings.git_token as string) ?? '(已配置)'
    }
    const dbRoots = settings.scan_roots as string[] | undefined
    const dbPatterns = settings.git_patterns as string[] | undefined
    if (dbRoots?.length && !cfg.scanRoots.length) {
      addPLForm.value.scanRoots = dbRoots.join('\n')
      cfg.scanRoots = dbRoots
      const configs = loadPLConfigs()
      configs[cfg.name] = cfg
      savePLConfigs(configs)
    }
    if (dbPatterns?.length && !cfg.gitPatterns.length) {
      addPLForm.value.gitPatterns = dbPatterns.join('\n')
      cfg.gitPatterns = dbPatterns
    }
  } catch (e) {
    console.error('加载产品线配置失败:', e)
  }
}

function getDialogFormParams(): { name: string; roots: string[]; patterns: string[] } | null {
  const name = addPLForm.value.name.trim().toLowerCase()
  if (!name) { ElMessage.warning('请输入产品线名称'); return null }
  const roots = addPLForm.value.scanRoots.split('\n').map(s => s.trim()).filter(Boolean)
  const patterns = addPLForm.value.gitPatterns.split('\n').map(s => s.trim()).filter(Boolean)
  if (roots.length === 0) { ElMessage.warning('请至少指定一个扫描根目录'); return null }
  return { name, roots, patterns }
}

async function afterDialogScan(name: string, repoCount: number, edgeCount: number, roots: string[], patterns: string[]): Promise<void> {
  const configs = loadPLConfigs()
  configs[name] = { name, scanRoots: roots, gitPatterns: patterns, lastScanAt: new Date().toISOString(), repoCount, edgeCount, builtin: false }
  savePLConfigs(configs)

  const settingsPayload: Record<string, unknown> = { scan_roots: roots, git_patterns: patterns }
  const tokenVal = addPLForm.value.gitToken.trim()
  if (tokenVal && !tokenVal.includes('***') && tokenVal !== '(已配置)') {
    settingsPayload.git_token = tokenVal
  }
  try { await updateProductLineSettings(name, settingsPayload) } catch (err) { console.warn('保存产品线服务端配置失败', err) }

  plDialogVisible.value = false
  const action = plDialogMode.value === 'edit' ? '更新' : '添加'
  ElMessage.success(`产品线 ${name} ${action}完成：${repoCount} 个仓库，${edgeCount} 条调用链`)
  await detectProductLines()
  selectedProductLine.value = name
  localStorage.setItem(STORAGE_KEY, name)
  await loadTopology()
}

async function confirmAddPL(): Promise<void> {
  const params = getDialogFormParams()
  if (!params) return
  if (!hasOnlineClients.value) {
    ElMessage.warning('未检测到在线 MCP 客户端。请使用「服务器扫描」或确保 Cursor 已连接。')
    return
  }

  addPLLoading.value = true
  try {
    const scanParams: Record<string, unknown> = { product_line: params.name }
    if (params.roots.length > 0) scanParams.scan_roots = params.roots
    if (params.patterns.length > 0) scanParams.git_patterns = params.patterns

    const result = await triggerRemoteScan(scanParams as Parameters<typeof triggerRemoteScan>[0])
    const data = result.data as { repoCount?: number; edgeCount?: number } | undefined
    await afterDialogScan(params.name, data?.repoCount ?? 0, data?.edgeCount ?? 0, params.roots, params.patterns)
  } catch (err) {
    ElMessage.error((err as Error).message || '客户端扫描失败')
  } finally {
    addPLLoading.value = false
  }
}

async function confirmAddPLServer(): Promise<void> {
  const params = getDialogFormParams()
  if (!params) return

  addPLLoading.value = true
  try {
    const scanParams: Record<string, unknown> = { product_line: params.name, force: forceScan.value && canManageProductLine.value }
    if (params.roots.length > 0) scanParams.scan_roots = params.roots
    if (params.patterns.length > 0) scanParams.git_patterns = params.patterns

    const result = await apiScanTopology(scanParams as Parameters<typeof apiScanTopology>[0])
    await afterDialogScan(params.name, result.totalRepos ?? 0, result.totalEdges ?? 0, params.roots, params.patterns)
  } catch (err) {
    ElMessage.error((err as Error).message || '服务器扫描失败')
  } finally {
    addPLLoading.value = false
  }
}

async function savePLConfigOnly(): Promise<void> {
  const name = addPLForm.value.name.trim().toLowerCase()
  if (!name) { ElMessage.warning('请输入产品线名称'); return }
  const roots = addPLForm.value.scanRoots.split('\n').map(s => s.trim()).filter(Boolean)
  const patterns = addPLForm.value.gitPatterns.split('\n').map(s => s.trim()).filter(Boolean)
  const configs = loadPLConfigs()
  const existing = configs[name] ?? {}
  configs[name] = { ...existing, name, scanRoots: roots, gitPatterns: patterns, builtin: !!KNOWN_PL_CONFIGS[name] }
  savePLConfigs(configs)

  const settingsPayload: Record<string, unknown> = { scan_roots: roots, git_patterns: patterns }
  const tokenVal = addPLForm.value.gitToken.trim()
  if (tokenVal && !tokenVal.includes('***') && tokenVal !== '(已配置)') {
    settingsPayload.git_token = tokenVal
  }
  try {
    await updateProductLineSettings(name, settingsPayload)
  } catch { ElMessage.warning('服务端配置保存失败，已保存到本地') }

  plDialogVisible.value = false
  ElMessage.success(`产品线 ${name} 配置已保存（下次扫描时生效）`)
}

// ─── 用户路径覆盖 ───
async function loadUserPathsCoverage(): Promise<void> {
  if (!selectedProductLine.value || !authStore.isAuthenticated) return
  try {
    userPathsCoverage.value = await getTopologyUserPaths(selectedProductLine.value)
  } catch (e) {
    console.error('加载用户路径覆盖失败:', e)
    userPathsCoverage.value = []
  }
}

// ─── MCP 客户端轮询 ───
let mcpPollTimer: ReturnType<typeof setInterval> | null = null

async function refreshMcpClients(): Promise<void> {
  if (!authStore.isAuthenticated) return
  try { mcpClients.value = await getMcpClients() } catch (e) { console.error('加载 MCP 客户端状态失败:', e) }
}

function startMcpClientPoll(): void {
  refreshMcpClients()
  mcpPollTimer = setInterval(refreshMcpClients, 15_000)
}

function stopMcpClientPoll(): void {
  if (mcpPollTimer) { clearInterval(mcpPollTimer); mcpPollTimer = null }
}

// ─── 从 Axios 错误中提取后端返回的真实消息 ───
function extractErrorMessage(err: unknown, fallback: string): string {
  const axiosErr = err as { response?: { data?: { message?: string } }; message?: string }
  return axiosErr.response?.data?.message || axiosErr.message || fallback
}

// ─── 客户端扫描按钮 disabled 原因（用于 tooltip） ───
const clientScanDisabledReason = computed(() => {
  if (!authStore.isAuthenticated) return '请先登录后再操作'
  if (scanning.value) return '服务器扫描进行中，请等待完成'
  if (!hasOnlineClients.value) {
    if (hasAnyOnlineClients.value) return '你的 MCP 客户端未连接（其他用户的客户端在线，但无法代替扫描）'
    return '未检测到在线的 MCP 客户端，请确保 Cursor 已连接到 Memforge'
  }
  return ''
})

const serverScanDisabledReason = computed(() => {
  if (!authStore.isAuthenticated) return '请先登录后再操作'
  if (remoteScanning.value) return '客户端扫描进行中，请等待完成'
  return ''
})

// ─── 客户端扫描（通过 WebSocket 触发 MCP proxy 本地执行） ───
async function triggerClientScan(): Promise<void> {
  if (!authStore.isAuthenticated) {
    ElMessage.warning('请先登录后再操作')
    return
  }

  const plName = scanProductLine.value || selectedProductLine.value
  if (!plName) { ElMessage.warning('请先选择或输入产品线名称'); return }

  if (!hasOnlineClients.value) {
    ElMessage.warning('未检测到在线的 MCP 客户端。请确保 Cursor 已连接到 Memforge。')
    return
  }

  const cfg = plName ? getPLConfig(plName) : null
  const scanParams: Record<string, unknown> = { product_line: plName }
  if (cfg?.scanRoots?.length) {
    scanParams.scan_roots = cfg.scanRoots
  } else if (scanRootsText.value.trim()) {
    scanParams.scan_roots = scanRootsText.value.split('\n').map(s => s.trim()).filter(Boolean)
  }
  if (cfg?.gitPatterns?.length) scanParams.git_patterns = cfg.gitPatterns
  if (forceScan.value && canManageProductLine.value) scanParams.force = true

  remoteScanning.value = true
  remoteScanProgress.value = { phase: 'pending', detail: '正在连接 MCP 客户端…' }
  scanResult.value = null
  scanError.value = ''

  const userId = authStore.user?.id ?? ''
  let eventSource: EventSource | null = null
  if (userId) {
    try {
      eventSource = await subscribeScanProgress(userId)
      eventSource.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as { phase?: string; detail?: string; percent?: number }
          if (data.phase) remoteScanProgress.value = { phase: data.phase, detail: data.detail, percent: data.percent }
        } catch (err) { console.warn('解析扫描进度 SSE 消息失败', err) }
      }
    } catch (err) { console.warn('订阅扫描进度 SSE 失败', err) }
  }

  try {
    const result = await triggerRemoteScan(scanParams as Parameters<typeof triggerRemoteScan>[0])
    const data = result.data as { repoCount?: number; edgeCount?: number; importResult?: { nodesUpserted?: number; edgesUpserted?: number } } | undefined
    scanResult.value = { totalRepos: data?.repoCount ?? 0, totalEdges: data?.edgeCount ?? 0, totalStored: data?.importResult?.nodesUpserted ?? 0 }
    await afterScanSuccess(plName, data?.repoCount, data?.edgeCount)
    ElMessage.success('客户端扫描完成')
  } catch (err) {
    const msg = extractErrorMessage(err, '客户端扫描失败')
    scanError.value = msg
    ElMessage.error(msg)
  } finally {
    remoteScanning.value = false
    remoteScanProgress.value = null
    if (eventSource) eventSource.close()
  }
}

// ─── 服务器扫描（通过 MCP 工具在服务端 memory-service 执行） ───
async function triggerServerScan(): Promise<void> {
  if (!authStore.isAuthenticated) {
    ElMessage.warning('请先登录后再操作')
    return
  }

  const plName = scanProductLine.value || selectedProductLine.value
  if (!plName) { ElMessage.warning('请先选择或输入产品线名称'); return }

  const cfg = plName ? getPLConfig(plName) : null
  const params: Record<string, unknown> = { product_line: plName, force: forceScan.value && canManageProductLine.value }
  if (cfg?.scanRoots?.length) {
    params.scan_roots = cfg.scanRoots
  } else if (scanRootsText.value.trim()) {
    params.scan_roots = scanRootsText.value.split('\n').map(s => s.trim()).filter(Boolean)
  }
  if (cfg?.gitPatterns?.length) params.git_patterns = cfg.gitPatterns

  scanning.value = true
  scanResult.value = null
  scanError.value = ''

  try {
    const result = await apiScanTopology(params as Parameters<typeof apiScanTopology>[0])
    scanResult.value = { totalRepos: result.totalRepos, totalEdges: result.totalEdges, totalStored: result.totalStored }
    await afterScanSuccess(plName, result.totalRepos, result.totalEdges)
    ElMessage.success('服务器扫描完成')
  } catch (err) {
    const msg = extractErrorMessage(err, '服务器扫描失败')
    scanError.value = msg
    ElMessage.error(msg)
  } finally {
    scanning.value = false
  }
}

// ─── 扫描成功后公共处理 ───
async function afterScanSuccess(plName: string, repoCount?: number, edgeCount?: number): Promise<void> {
  if (plName) {
    const configs = loadPLConfigs()
    const existing = configs[plName] ?? { name: plName, scanRoots: [], gitPatterns: [] }
    if (!existing.scanRoots?.length && scanRootsText.value.trim()) {
      existing.scanRoots = scanRootsText.value.split('\n').map(s => s.trim()).filter(Boolean)
    }
    existing.lastScanAt = new Date().toISOString()
    existing.repoCount = repoCount ?? 0
    existing.edgeCount = edgeCount ?? 0
    configs[plName] = existing
    savePLConfigs(configs)
  }
  await detectProductLines()
  if (plName && !selectedProductLine.value) {
    selectedProductLine.value = plName
    localStorage.setItem(STORAGE_KEY, plName)
  }
  await loadTopology()
}


// ─── 拓扑加载 ───
async function detectProductLines(): Promise<void> {
  if (!authStore.isAuthenticated) return
  loadingPhase.value = '正在检测产品线…'
  loadingProgress.value = 10
  const found = new Set<string>()
  try {
    const apiPLs = await getTopologyProductLines()
    for (const pl of apiPLs) found.add(pl)
  } catch (e) {
    console.error('检测产品线失败:', e)
  }
  productLines.value = [...found].sort()
  if (productLines.value.length > 0 && !selectedProductLine.value) {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && productLines.value.includes(saved)) {
      selectedProductLine.value = saved
    } else {
      selectedProductLine.value = productLines.value[0]
    }
  }
}

function edgeDisplayName(repoId: string): string {
  const existing = nodes.value.find(n => n.id === repoId)
  if (existing) return existing.name
  return repoId.split('/').pop() ?? repoId
}

async function loadTopology(): Promise<void> {
  if (!authStore.isAuthenticated) return
  if (!selectedProductLine.value) { loading.value = false; return }
  loading.value = true
  loadingProgress.value = 20
  loadingPhase.value = `正在加载 ${selectedProductLine.value} 拓扑数据…`
  nodes.value = []
  edges.value = []
  layers.value = []
  apiEdges.value = []
  structuredData.value = null
  selectedNode.value = null

  let loadedFromApi = false

  if (selectedProductLine.value) {
    try {
      loadingPhase.value = '正在从结构化 API 加载…'
      loadingProgress.value = 40
      const data = await getTopology(selectedProductLine.value)
      if (data.nodes.length > 0) {
        structuredData.value = data
        apiEdges.value = data.edges
        const layerMap = new Map<string, { index: number; services: string[] }>()
        for (const n of data.nodes) {
          const lname = n.layerName || '待归类'
          if (!layerMap.has(lname)) layerMap.set(lname, { index: n.layerIndex ?? 99, services: [] })
          layerMap.get(lname)!.services.push(n.repoId)
        }
        const sortedLayers = [...layerMap.entries()].sort((a, b) => a[1].index - b[1].index)
        for (const [lname, info] of sortedLayers) {
          layers.value.push({ name: lname, services: info.services })
        }
        for (const n of data.nodes) {
          nodes.value.push({ id: n.repoId, name: n.displayName, techStack: n.techStack ?? '', layer: n.layerName ?? '', description: n.description ?? '' })
        }
        for (const e of data.edges) {
          edges.value.push({ from: edgeDisplayName(e.fromRepoId), to: edgeDisplayName(e.toRepoId), fromRepoId: e.fromRepoId, toRepoId: e.toRepoId, protocol: e.protocol })
        }
        loadedFromApi = true
        loadingProgress.value = 100
        loadUserPathsCoverage()
      }
    } catch (err) { console.warn('拓扑 REST API 加载失败，回退 MCP', err) }
  }

  if (!loadedFromApi) {
    try {
      const topoOpts: Record<string, unknown> = { tags_filter: ['topology'], scope_filter: ['architecture'], min_similarity: 0.3, max_content_length: 10000 }
      if (selectedProductLine.value) topoOpts.product_line = selectedProductLine.value
      loadingPhase.value = '正在查询服务节点与调用链…'
      loadingProgress.value = 40
      const [nodesResult, edgesResult, layersResult] = await Promise.allSettled([
        recallMemory('服务节点 架构', 30, topoOpts as Parameters<typeof recallMemory>[2]),
        recallMemory('调用关系 调用链 协议', 15, topoOpts as Parameters<typeof recallMemory>[2]),
        recallMemory('分层架构 全景 服务分层', 10, topoOpts as Parameters<typeof recallMemory>[2]),
      ])
      loadingPhase.value = '正在解析拓扑结构…'
      loadingProgress.value = 80
      if (layersResult.status === 'fulfilled' && layersResult.value.success) parseLayers(layersResult.value)
      if (nodesResult.status === 'fulfilled' && nodesResult.value.success) parseServiceNodes(nodesResult.value)
      if (edgesResult.status === 'fulfilled' && edgesResult.value.success) parseEdges(edgesResult.value)
      loadingProgress.value = 100
    } catch (err) { console.warn('MCP recall 拓扑降级失败', err) }
  }

  if (selectedProductLine.value && nodes.value.length === 0 && edges.value.length === 0) {
    ElMessage.info(`产品线「${selectedProductLine.value}」暂无拓扑数据，请点击「一键扫描」生成`)
  }

  loading.value = false
  loadingPhase.value = ''
  loadingProgress.value = 0
}

// ─── 记忆解析函数 (兼容旧格式) ───
function parseServiceNodes(result: MemoryRecallResult): void {
  const seen = new Set(nodes.value.map(n => n.id))
  for (const item of result.results) {
    const lines = item.content.split('\n')
    for (const line of lines) {
      const m1 = line.match(/^\s+(.+?)\s*\[([^\]]+)\]\s*\(([^)]+)\)/)
      if (m1 && !seen.has(m1[3])) {
        seen.add(m1[3])
        nodes.value.push({ id: m1[3], name: m1[1].trim(), techStack: m1[2], layer: '', description: line.trim() })
        continue
      }
      const m2 = line.match(/^[-*]\s+`?([^`]+)`?\s*[（(]([^)）]+)[)）]/)
      if (m2 && !seen.has(m2[1])) {
        seen.add(m2[1])
        nodes.value.push({ id: m2[1], name: m2[1], techStack: m2[2], layer: '', description: line.trim() })
      }
    }
  }
}

function parseEdges(result: MemoryRecallResult): void {
  for (const item of result.results) {
    const lines = item.content.split('\n')
    let protocol = ''
    for (const line of lines.slice(0, 8)) {
      const pm = line.match(/^协议[:：]\s*(.+)/)
      if (pm) { protocol = pm[1].trim(); break }
    }
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith('产品线:') || t.startsWith('协议:') || t.startsWith('调用数:')) continue
      const m1 = line.match(/^.+?\s*\(([^)]+)\)\s*→\s*.+?\s*\(([^)]+)\)/)
      if (m1) { edges.value.push({ from: edgeDisplayName(m1[1]), to: edgeDisplayName(m1[2]), fromRepoId: m1[1], toRepoId: m1[2], protocol: protocol || 'unknown' }); continue }
      const m2 = line.match(/`?([^`→]+)`?\s*→\s*`?([^`\s(]+)`?\s*[（(]([^)）]+)[)）]/)
      if (m2) { edges.value.push({ from: m2[1].trim(), to: m2[2].trim(), protocol: m2[3] }); continue }
      const m3 = t.match(/^(.+?)\s*→\s*(.+)$/)
      if (m3) { edges.value.push({ from: m3[1].trim(), to: m3[2].trim(), protocol: protocol || 'unknown' }) }
    }
  }
}

function parseLayers(result: MemoryRecallResult): void {
  for (const item of result.results) {
    const layersBeforeItem = layers.value.length
    const layerRe = /---\s*第\s*\d+\s*层[:：]\s*(.+?)\s*\(\d+\s*服务\)\s*---/g
    const content = item.content
    const positions: Array<{ name: string; start: number; end: number }> = []
    let lm: RegExpExecArray | null
    while ((lm = layerRe.exec(content)) !== null) {
      positions.push({ name: lm[1].trim(), start: lm.index, end: lm.index + lm[0].length })
    }
    const shortNameCount: Record<string, number> = {}
    const allServices: Array<{ repoId: string; desc: string; tech: string; layerName: string }> = []
    for (let i = 0; i < positions.length; i++) {
      const sectionStart = positions[i].end
      const sectionEnd = i + 1 < positions.length ? positions[i + 1].start : content.length
      const section = content.slice(sectionStart, sectionEnd)
      for (const sl of section.split('\n')) {
        const sm = sl.match(/^\s+(.+?)\s*\[([^\]]+)\]\s*\(([^)]+)\)/)
        if (sm) {
          const shortName = sm[3].split('/').pop() ?? sm[1].trim()
          shortNameCount[shortName] = (shortNameCount[shortName] ?? 0) + 1
          allServices.push({ repoId: sm[3], desc: sm[1].trim(), tech: sm[2], layerName: positions[i].name })
        }
      }
    }
    function uniqueDisplayName(repoId: string): string {
      const parts = repoId.split('/')
      const shortName = parts.pop() ?? repoId
      if ((shortNameCount[shortName] ?? 0) <= 1) return shortName
      const parent = parts.pop()
      return parent ? `${parent}/${shortName}` : shortName
    }
    const nodeSeen = new Set(nodes.value.map(n => n.id))
    let svcIdx = 0
    for (let i = 0; i < positions.length; i++) {
      const services: string[] = []
      const sectionStart = positions[i].end
      const sectionEnd = i + 1 < positions.length ? positions[i + 1].start : content.length
      const section = content.slice(sectionStart, sectionEnd)
      for (const sl of section.split('\n')) {
        const sm = sl.match(/^\s+(.+?)\s*\[([^\]]+)\]\s*\(([^)]+)\)/)
        if (sm) {
          const svc = allServices[svcIdx++]
          const displayName = uniqueDisplayName(svc.repoId)
          services.push(displayName)
          if (!nodeSeen.has(svc.repoId)) {
            nodeSeen.add(svc.repoId)
            nodes.value.push({ id: svc.repoId, name: displayName, techStack: svc.tech, layer: positions[i].name, description: svc.desc })
          }
        }
      }
      if (services.length > 0) layers.value.push({ name: positions[i].name, services })
    }
    if (layers.value.length === layersBeforeItem) {
      const sections = item.content.split(/#{2,3}\s+/)
      for (const sec of sections) {
        const nameMatch = sec.match(/^(.+?)[\n:]/)
        if (nameMatch) {
          const services: string[] = []
          const serviceMatches = sec.matchAll(/[-*]\s+`?([^`\n]+)`?/g)
          for (const m of serviceMatches) services.push(m[1])
          if (services.length > 0) layers.value.push({ name: nameMatch[1].trim(), services })
        }
      }
    }
    if (layers.value.length === layersBeforeItem) {
      const lines = item.content.split('\n')
      let li = 0
      const nodeSeen2 = new Set(nodes.value.map(n => n.id))
      while (li < lines.length) {
        const layerLine = lines[li].match(/^层级[:：]\s*L\d+\s*-\s*(.+)$/)
        if (layerLine) {
          const layerName = layerLine[1].trim()
          li++
          if (li < lines.length && /^服务数[:：]/.test(lines[li])) li++
          while (li < lines.length && lines[li].trim() === '') li++
          const services: string[] = []
          while (li < lines.length && lines[li].trim() !== '') {
            const sm = lines[li].match(/^\s*(.+?)\s*\[([^\]]+)\]\s*\(([^)]+)\)\s*$/)
            if (sm) {
              const repoId = sm[3]
              const short = repoId.includes('/') ? (repoId.split('/').pop() ?? repoId) : repoId
              services.push(short)
              if (!nodeSeen2.has(repoId)) {
                nodeSeen2.add(repoId)
                nodes.value.push({ id: repoId, name: short, techStack: sm[2], layer: layerName, description: sm[1].trim() })
              }
            }
            li++
          }
          if (services.length > 0) layers.value.push({ name: layerName, services })
          continue
        }
        li++
      }
    }
  }
}

// ─── 节点迁移（产品线拆分） ───
const NODE_PICKER_DISPLAY_LIMIT = 100
const showAllTopologyNodesInPicker = ref(false)
const visibleTopologyNodesForPicker = computed(() => {
  const allNodes = structuredData.value?.nodes ?? []
  if (showAllTopologyNodesInPicker.value || allNodes.length <= NODE_PICKER_DISPLAY_LIMIT) {
    return allNodes
  }
  return allNodes.slice(0, NODE_PICKER_DISPLAY_LIMIT)
})
const hiddenTopologyNodesCount = computed(() => {
  const total = structuredData.value?.nodes?.length ?? 0
  if (showAllTopologyNodesInPicker.value || total <= NODE_PICKER_DISPLAY_LIMIT) return 0
  return total - NODE_PICKER_DISPLAY_LIMIT
})

const moveNodesDialogVisible = ref(false)
const moveNodesTarget = ref('')
const moveNodesSelected = ref<string[]>([])
const moveNodesSaving = ref(false)

function openMoveNodesDialog(): void {
  if (!canManageProductLine.value) {
    ElMessage.warning('仅管理员和 Leader 可执行节点迁移')
    return
  }
  moveNodesTarget.value = ''
  moveNodesSelected.value = []
  showAllTopologyNodesInPicker.value = false
  moveNodesDialogVisible.value = true
}

async function confirmMoveNodes(): Promise<void> {
  const target = moveNodesTarget.value.trim().toLowerCase()
  if (!target) { ElMessage.warning('请输入目标产品线名称'); return }
  if (target === selectedProductLine.value) { ElMessage.warning('目标产品线不能与当前产品线相同'); return }
  if (moveNodesSelected.value.length === 0) { ElMessage.warning('请选择要迁移的节点'); return }
  moveNodesSaving.value = true
  try {
    const result = await moveTopologyNodes(selectedProductLine.value, target, moveNodesSelected.value)
    moveNodesDialogVisible.value = false
    ElMessage.success(`已迁移 ${result.nodesMoved} 个节点和 ${result.edgesMoved} 条边到 ${target}`)
    await detectProductLines()
    await loadTopology()
  } catch (err) {
    ElMessage.error((err as Error).message || '迁移失败')
  } finally {
    moveNodesSaving.value = false
  }
}

// ─── 节点复制（同一仓库存在于多个产品线） ───
const copyNodesDialogVisible = ref(false)
const copyNodesTarget = ref('')
const copyNodesSelected = ref<string[]>([])
const copyNodesSaving = ref(false)

function openCopyNodesDialog(): void {
  if (!canManageProductLine.value) {
    ElMessage.warning('仅管理员和 Leader 可执行节点复制')
    return
  }
  copyNodesTarget.value = ''
  copyNodesSelected.value = []
  showAllTopologyNodesInPicker.value = false
  copyNodesDialogVisible.value = true
}

async function confirmCopyNodes(): Promise<void> {
  const target = copyNodesTarget.value.trim().toLowerCase()
  if (!target) { ElMessage.warning('请输入目标产品线名称'); return }
  if (target === selectedProductLine.value) { ElMessage.warning('目标产品线不能与当前产品线相同'); return }
  if (copyNodesSelected.value.length === 0) { ElMessage.warning('请选择要复制的节点'); return }
  copyNodesSaving.value = true
  try {
    const result = await copyTopologyNodes(selectedProductLine.value, target, copyNodesSelected.value)
    copyNodesDialogVisible.value = false
    ElMessage.success(`已复制 ${result.nodesCopied} 个节点和 ${result.edgesCopied} 条边到 ${target}`)
    await detectProductLines()
  } catch (err) {
    ElMessage.error((err as Error).message || '复制失败')
  } finally {
    copyNodesSaving.value = false
  }
}

// ─── 产品线切换 ───
async function switchProductLine(pl: string): Promise<void> {
  selectedProductLine.value = pl
  localStorage.setItem(STORAGE_KEY, pl)
  await loadTopology()
}

// ─── 归档产品线 ───
async function deleteProductLine(): Promise<void> {
  if (!authStore.isAuthenticated) { ElMessage.warning('请先登录后再操作'); return }
  const pl = effectiveProductLine.value
  if (!pl) { ElMessage.warning('请先选择产品线'); return }
  try {
    await ElMessageBox.confirm(
      `将归档产品线「${pl}」在记忆库中的拓扑类记忆，便于清空残缺图后重新扫描。`,
      '归档拓扑记忆', { confirmButtonText: '确定归档', cancelButtonText: '取消', type: 'warning' },
    )
  } catch { return }
  try {
    loading.value = true
    loadingPhase.value = `正在归档 ${pl} 拓扑数据…`
    let page = 1
    const pageSize = 100
    let archivedCount = 0
    for (;;) {
      const memories = await listMemories({ tags: [`pl:${pl}`, 'topology'], page, page_size: pageSize, cross_project: true })
      if (!memories.success || !memories.entries?.length) break
      for (const mem of memories.entries) {
        if (mem.isArchived) continue
        try { await archiveMemory(mem.id, `产品线 ${pl} 拓扑数据删除`); archivedCount++ } catch { /* skip */ }
      }
      if (page >= (memories.pagination?.totalPages ?? 1)) break
      page++
    }
    if (archivedCount === 0) ElMessage.info('未找到未归档的拓扑记忆（可能已清空）')
    const configs = loadPLConfigs()
    delete configs[pl]
    savePLConfigs(configs)
    if (scanProductLine.value.trim().toLowerCase() === pl) scanProductLine.value = ''
    productLines.value = productLines.value.filter(p => p !== pl)
    if (selectedProductLine.value === pl) {
      selectedProductLine.value = productLines.value[0] ?? ''
      selectedProductLine.value ? localStorage.setItem(STORAGE_KEY, selectedProductLine.value) : localStorage.removeItem(STORAGE_KEY)
    }
    nodes.value = []; edges.value = []; layers.value = []
    if (selectedProductLine.value) await loadTopology()
    ElMessage.success(`产品线 ${pl} 拓扑数据已归档（${archivedCount} 条）`)
  } catch (err) {
    ElMessage.error((err as Error).message || '归档失败')
  } finally {
    loading.value = false
    loadingPhase.value = ''
  }
}

function goToProjectDetail(node: { id: string }): void {
  if (selectedProductLine.value) {
    router.push(`/topology/${encodeURIComponent(selectedProductLine.value)}/project/${node.id}`)
  }
}

// ─── 从抽屉导航到另一个节点 ───
function navigateToNode(repoId: string): void {
  const node = nodes.value.find(n => n.id === repoId)
  if (node) {
    selectedNode.value = node
    detailDrawerVisible.value = false
  }
}

// ─── 初始化 ───
const savedPL = localStorage.getItem(STORAGE_KEY)
if (savedPL) {
  loading.value = true
  loadingPhase.value = `正在加载 ${savedPL} 拓扑数据…`
  loadingProgress.value = 5
}

onMounted(async () => {
  startMcpClientPoll()
  await detectProductLines()
  await loadTopology()
})

onUnmounted(() => {
  stopMcpClientPoll()
})
</script>

<template>
  <div class="topology-page">
    <el-row :gutter="20">
      <!-- ─── 左侧主区域 ─── -->
      <el-col :span="viewMode === 'callgraph' ? 24 : 16">
        <el-card>
          <template #header>
            <div class="main-header">
              <div class="main-header-left">
                <el-select
                  v-if="productLines.length > 0"
                  v-model="selectedProductLine"
                  size="small"
                  style="width: 140px"
                  @change="switchProductLine"
                >
                  <el-option v-for="pl in productLines" :key="pl" :label="pl" :value="pl" />
                </el-select>
                <el-button v-if="canManageProductLine" size="small" type="primary" plain @click="showAddPLDialog">
                  + 添加产品线
                </el-button>
                <el-tag v-if="graphStatsLabel" type="info" size="small">{{ graphStatsLabel }}</el-tag>
              </div>
              <div class="main-header-right">
                <el-segmented
                  v-if="layers.length > 0"
                  v-model="viewMode"
                  :options="[{ label: '分层', value: 'layer' }, { label: '力导向', value: 'graph' }, { label: '调用关系', value: 'callgraph' }]"
                  size="small"
                />
                <el-button
                  v-if="structuredData"
                  text size="small"
                  :loading="releaseOrderLoading"
                  @click="loadReleaseOrder"
                >发布顺序</el-button>
                <el-tooltip
                  v-if="!loading && (layers.length > 0 || edges.length > 0)"
                  :content="clientScanDisabledReason"
                  :disabled="!clientScanDisabledReason"
                  placement="bottom"
                >
                  <el-button
                    text size="small" type="success"
                    :loading="remoteScanning"
                    :disabled="scanning || !hasOnlineClients"
                    @click="triggerClientScan"
                  >客户端扫描</el-button>
                </el-tooltip>
                <el-tooltip
                  v-if="canManageProductLine && !loading && (layers.length > 0 || edges.length > 0)"
                  :content="serverScanDisabledReason"
                  :disabled="!serverScanDisabledReason"
                  placement="bottom"
                >
                  <el-button
                    text size="small"
                    :loading="scanning"
                    :disabled="remoteScanning"
                    @click="triggerServerScan"
                  >服务器扫描</el-button>
                </el-tooltip>
                <el-dropdown v-if="canManageProductLine && structuredData && structuredData.nodes.length > 0" trigger="click">
                  <el-button text size="small">更多</el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item @click="openMoveNodesDialog">迁移节点</el-dropdown-item>
                      <el-dropdown-item @click="openCopyNodesDialog">复制到其他产品线</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </div>
          </template>

          <!-- 加载骨架 -->
          <div v-if="loading" class="loading-skeleton">
            <div class="loading-progress-bar">
              <div class="loading-progress-fill" :style="{ width: `${loadingProgress}%` }" />
            </div>
            <div class="loading-phase-text">{{ loadingPhase || '加载中…' }}</div>
            <div v-for="(sk, i) in skeletonLayers" :key="i" class="skeleton-layer">
              <div class="skeleton-header" :style="{ borderLeftColor: sk.color }">
                <div class="skeleton-header-bar" :style="{ width: sk.labelWidth + 'px' }" />
              </div>
              <div class="skeleton-chips">
                <div v-for="(w, j) in sk.chipWidths" :key="j" class="skeleton-chip" :style="{ width: w + 'px' }" />
              </div>
            </div>
          </div>

          <!-- 分层视图 -->
          <LayerView
            v-else-if="layers.length > 0 && viewMode === 'layer'"
            :layers="layers"
            :nodes="nodes"
            :edges="edges"
            :selected-node-id="selectedNode?.id ?? null"
            @select-node="selectNode($event)"
          />

          <!-- 力导向图 -->
          <ForceGraph
            v-else-if="layers.length > 0 && viewMode === 'graph'"
            :nodes="nodes"
            :edges="edges"
            :layers="layers"
            :selected-node-id="selectedNode?.id ?? null"
            @select-node="selectNode($event)"
            @view-node-detail="goToProjectDetail($event)"
          />

          <!-- 调用关系图 (G6) -->
          <CallGraphPanel
            v-else-if="viewMode === 'callgraph' && selectedProductLine"
            :product-line="selectedProductLine"
          />

          <!-- 部分数据回退 -->
          <div v-else-if="hasTopologyPartialData" class="layer-view topology-fallback">
            <el-alert type="warning" show-icon :closable="false" style="margin-bottom: 16px">
              未解析到分层架构记忆。下方由调用链推导服务节点；完整分层请「刷新扫描」。
            </el-alert>
            <div class="layer-group">
              <div class="layer-header" style="border-left-color: #909399">服务节点（推导）</div>
              <div class="layer-services">
                <div
                  v-for="name in derivedServiceNames" :key="name"
                  class="service-chip"
                  :class="{ active: selectedNode?.name === name }"
                  @click="selectNode(findNodeByDisplayName(name, '推导'))"
                >
                  <span>{{ name }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 空状态引导 -->
          <div v-else class="empty-guide">
            <div class="empty-icon">
              <svg viewBox="0 0 48 48" width="64" height="64" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="24" cy="24" r="22" stroke="#c0c4cc" stroke-width="2" stroke-dasharray="4 3" />
                <circle cx="14" cy="18" r="3" fill="#409eff" opacity="0.7" />
                <circle cx="34" cy="18" r="3" fill="#67c23a" opacity="0.7" />
                <circle cx="24" cy="34" r="3" fill="#e6a23c" opacity="0.7" />
                <line x1="16.5" y1="19.5" x2="31.5" y2="19.5" stroke="#dcdfe6" stroke-width="1.5" />
                <line x1="15.5" y1="20.5" x2="22.5" y2="32" stroke="#dcdfe6" stroke-width="1.5" />
                <line x1="32.5" y1="20.5" x2="25.5" y2="32" stroke="#dcdfe6" stroke-width="1.5" />
              </svg>
            </div>
            <h3 class="empty-title">尚未导入拓扑数据</h3>
            <p class="empty-desc">拓扑图可视化产品线内各服务的架构分层与调用关系。</p>
            <ScanControl
              :scanning="scanning"
              :remote-scanning="remoteScanning"
              :scan-product-line="scanProductLine"
              :scan-roots="scanRootsText"
              :scan-result="scanResult"
              :scan-error="scanError"
              :remote-scan-progress="remoteScanProgress"
              :mcp-clients="mcpClients"
              :has-online-clients="hasOnlineClients"
              :can-manage-product-line="canManageProductLine"
              :has-data="false"
              :client-scan-disabled-reason="clientScanDisabledReason"
              :server-scan-disabled-reason="serverScanDisabledReason"
              :force-scan="forceScan"
              @trigger-client-scan="triggerClientScan"
              @trigger-server-scan="triggerServerScan"
              @update:scan-product-line="scanProductLine = $event"
              @update:scan-roots="scanRootsText = $event"
              @update:force-scan="forceScan = $event"
            />
            <div class="guide-steps">
              <div class="guide-step">
                <div class="step-number">1</div>
                <div class="step-content">
                  <div class="step-title">连接 Cursor MCP</div>
                  <p class="known-pl-hint">
                    确保你的 Cursor 配置了 <code>MEMFORGE_GATEWAY_URL</code>，MCP 客户端会自动连接到 Memforge 服务。
                  </p>
                </div>
              </div>
              <div class="guide-step">
                <div class="step-number">2</div>
                <div class="step-content">
                  <div class="step-title">或通过 AI 对话扫描</div>
                  <code class="step-code">scan_topology({ product_line: "myapp", scan_roots: ["~/work/myapp"] })</code>
                </div>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>

      <!-- ─── 右侧面板（调用关系视图时隐藏） ─── -->
      <el-col v-if="viewMode !== 'callgraph'" :span="8">
        <!-- 产品线信息 -->
        <ProductLineSelector
          v-if="currentPLConfig"
          :product-lines="productLines"
          :selected-product-line="selectedProductLine"
          :current-p-l-config="currentPLConfig"
          :total-nodes-count="totalNodesCount"
          :current-user-cloned-count="currentUserClonedCount"
          :user-paths-coverage="userPathsCoverage"
          :scan-contributors="scanContributors"
          :can-manage-product-line="canManageProductLine"
          :can-edit-scan-config="canEditScanConfig"
          :has-online-clients="hasOnlineClients"
          :scanning="scanning"
          :remote-scanning="remoteScanning"
          :client-scan-disabled-reason="clientScanDisabledReason"
          :server-scan-disabled-reason="serverScanDisabledReason"
          :force-scan="forceScan"
          @switch-product-line="switchProductLine"
          @show-add-p-l-dialog="showAddPLDialog"
          @show-edit-p-l-dialog="showEditPLDialog"
          @trigger-client-scan="triggerClientScan"
          @trigger-server-scan="triggerServerScan"
          @delete-product-line="deleteProductLine"
          @update:force-scan="forceScan = $event"
        />

        <!-- 节点摘要 -->
        <NodeSummary
          v-if="selectedNode"
          :selected-node="selectedNode"
          :edges="edges"
          :structured-data="structuredData"
          @open-detail="openDetailDrawer"
          @open-change-impact="openChangeImpactDialog"
          @clear-selection="selectedNode = null"
        />

        <!-- 调用关系快览 -->
        <CallGraphQuick
          :edges="edges"
          :selected-node-id="selectedNode?.id ?? null"
          :selected-node-name="selectedNode?.name ?? null"
          style="margin-top: 16px"
        />
      </el-col>
    </el-row>

    <!-- ─── 项目百科抽屉 ─── -->
    <NodeDetailDrawer
      v-model:visible="detailDrawerVisible"
      :selected-node="selectedNode"
      :edges="edges"
      :structured-data="structuredData"
      :user-paths-coverage="userPathsCoverage"
      :can-edit="canManageProductLine"
      :product-line="selectedProductLine"
      @select-node="navigateToNode"
      @open-edit="openEditDrawer(selectedNode!)"
      @edge-changed="loadTopology"
    />

    <!-- ─── 发布顺序弹窗 ─── -->
    <ReleaseOrderDialog
      v-model:visible="releaseOrderDialogVisible"
      :loading="releaseOrderLoading"
      :result="releaseOrder"
      :error="releaseOrderError"
    />

    <!-- ─── 变更影响弹窗 ─── -->
    <ChangeImpactDialog
      v-model:visible="changeImpactDialogVisible"
      :loading="changeImpactLoading"
      :target-repo-id="changeImpactTargetRepoId"
      :result="changeImpact"
      :error="changeImpactError"
    />

    <!-- ─── 添加产品线弹窗 ─── -->
    <el-dialog v-model="plDialogVisible" :title="plDialogMode === 'edit' ? '编辑产品线配置' : '添加产品线'" width="520px" :close-on-click-modal="false" :close-on-press-escape="!addPLLoading" :show-close="!addPLLoading">
      <el-form label-width="110px" label-position="right">
        <el-form-item label="产品线名称" required>
          <el-input v-model="addPLForm.name" placeholder="如 myapp（小写英文）" :disabled="addPLLoading || plDialogMode === 'edit'" />
        </el-form-item>
        <el-form-item label="扫描根目录">
          <el-input v-model="addPLForm.scanRoots" type="textarea" :rows="3" placeholder="你电脑上的代码目录路径，如 ~/work/myapp&#10;每行一个" :disabled="addPLLoading" />
          <div class="form-hint">填写你本机的代码存放路径（非服务器路径）。扫描时 MCP 客户端会在你的电脑上查找 Git 仓库。内置产品线可留空使用默认配置。</div>
        </el-form-item>
        <el-form-item v-if="canManageProductLine" label="Git 地址匹配">
          <el-input v-model="addPLForm.gitPatterns" type="textarea" :rows="2" placeholder="每行一个 host 或 group 前缀（可选）" :disabled="addPLLoading" />
        </el-form-item>
        <el-form-item v-if="canManageProductLine" label="Git 访问令牌">
          <el-input v-model="addPLForm.gitToken" :type="showGitToken ? 'text' : 'password'" placeholder="用于服务端 git fetch（可选）" :disabled="addPLLoading">
            <template #suffix>
              <el-icon style="cursor: pointer" @click="showGitToken = !showGitToken">
                <View v-if="showGitToken" /><Hide v-else />
              </el-icon>
            </template>
          </el-input>
          <div class="form-hint">服务端部署时需要此令牌执行 git fetch 获取远程变更。本地 MCP 客户端使用你电脑的 SSH key，无需配置。</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="addPLLoading" @click="plDialogVisible = false">取消</el-button>
        <el-button v-if="plDialogMode === 'edit'" :disabled="addPLLoading" @click="savePLConfigOnly">仅保存配置</el-button>
        <el-button :loading="addPLLoading" :disabled="!hasOnlineClients" @click="confirmAddPL">
          {{ plDialogMode === 'edit' ? '客户端扫描' : '客户端扫描并添加' }}
        </el-button>
        <el-button v-if="canManageProductLine" type="primary" :loading="addPLLoading" @click="confirmAddPLServer">
          {{ plDialogMode === 'edit' ? '服务器扫描' : '服务器扫描并添加' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ─── 节点编辑抽屉 ─── -->
    <el-drawer v-model="editDrawerVisible" title="编辑服务节点" :size="420" direction="rtl">
      <el-form v-if="editingNode" label-width="90px" label-position="right">
        <el-form-item label="仓库 ID"><el-input :model-value="editingNode.repoId" disabled /></el-form-item>
        <el-form-item label="显示名"><el-input v-model="editForm.displayName" /></el-form-item>
        <el-form-item label="所属层级"><el-input-number v-model="editForm.layerIndex" :min="0" :max="10" /></el-form-item>
        <el-form-item label="层级名称"><el-input v-model="editForm.layerName" placeholder="如：微服务、接口网关" /></el-form-item>
        <el-form-item label="描述"><el-input v-model="editForm.description" type="textarea" :rows="3" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDrawerVisible = false">取消</el-button>
        <el-button type="primary" :loading="editSaving" @click="saveNodeEdit">保存</el-button>
      </template>
    </el-drawer>

    <!-- ─── 节点迁移弹窗（产品线拆分） ─── -->
    <el-dialog v-model="moveNodesDialogVisible" title="迁移节点到其他产品线" width="640px" :close-on-click-modal="false" :close-on-press-escape="!moveNodesSaving" :show-close="!moveNodesSaving">
      <el-alert type="info" show-icon :closable="false" style="margin-bottom: 16px">
        将选中的节点（及其关联的调用边）从当前产品线「{{ selectedProductLine }}」迁移到目标产品线。
        适用于产品线拆分场景（如 your-product → your-product-server / your-product-client）。
      </el-alert>
      <el-form label-width="110px" label-position="right">
        <el-form-item label="目标产品线" required>
          <el-autocomplete
            v-model="moveNodesTarget"
            :fetch-suggestions="(q: string, cb: (results: Array<{value: string}>) => void) => cb(productLines.filter(p => p !== selectedProductLine && p.includes(q)).map(p => ({ value: p })))"
            placeholder="输入或选择目标产品线（可新建）"
            style="width: 100%"
            :disabled="moveNodesSaving"
          />
          <div class="form-hint">输入已有产品线名称或新名称（如 your-product-client）。新名称会在迁移时自动创建。</div>
        </el-form-item>
        <el-form-item label="选择节点">
          <el-checkbox-group v-model="moveNodesSelected" style="max-height: 320px; overflow-y: auto; width: 100%">
            <div v-for="node in visibleTopologyNodesForPicker" :key="node.repoId" style="margin-bottom: 4px">
              <el-checkbox :value="node.repoId">
                <span style="font-family: monospace; font-size: 12px">{{ node.repoId }}</span>
                <el-tag v-if="node.techStack" size="small" type="info" style="margin-left: 6px">{{ node.techStack }}</el-tag>
              </el-checkbox>
            </div>
            <el-button
              v-if="hiddenTopologyNodesCount > 0"
              text
              type="primary"
              size="small"
              @click="showAllTopologyNodesInPicker = true"
            >
              显示更多（还有 {{ hiddenTopologyNodesCount }} 项）
            </el-button>
          </el-checkbox-group>
          <div class="form-hint">已选 {{ moveNodesSelected.length }} 个节点</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="moveNodesSaving" @click="moveNodesDialogVisible = false">取消</el-button>
        <el-button type="warning" :loading="moveNodesSaving" @click="confirmMoveNodes">
          {{ moveNodesSaving ? '迁移中…' : `迁移 ${moveNodesSelected.length} 个节点` }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ─── 节点复制弹窗（多产品线共享） ─── -->
    <el-dialog v-model="copyNodesDialogVisible" title="复制节点到其他产品线" width="640px" :close-on-click-modal="false" :close-on-press-escape="!copyNodesSaving" :show-close="!copyNodesSaving">
      <el-alert type="success" show-icon :closable="false" style="margin-bottom: 16px">
        将选中的节点复制到目标产品线，当前产品线的节点保持不变。
        适用于多团队共享仓库场景（如同一服务被前后端团队共同维护）。
      </el-alert>
      <el-form label-width="110px" label-position="right">
        <el-form-item label="目标产品线" required>
          <el-autocomplete
            v-model="copyNodesTarget"
            :fetch-suggestions="(q: string, cb: (results: Array<{value: string}>) => void) => cb(productLines.filter(p => p !== selectedProductLine && p.includes(q)).map(p => ({ value: p })))"
            placeholder="输入或选择目标产品线（可新建）"
            style="width: 100%"
            :disabled="copyNodesSaving"
          />
          <div class="form-hint">节点将同时存在于当前产品线和目标产品线中。仅复制两端都在选中列表中的调用边。</div>
        </el-form-item>
        <el-form-item label="选择节点">
          <el-checkbox-group v-model="copyNodesSelected" style="max-height: 320px; overflow-y: auto; width: 100%">
            <div v-for="node in visibleTopologyNodesForPicker" :key="node.repoId" style="margin-bottom: 4px">
              <el-checkbox :value="node.repoId">
                <span style="font-family: monospace; font-size: 12px">{{ node.repoId }}</span>
                <el-tag v-if="node.techStack" size="small" type="info" style="margin-left: 6px">{{ node.techStack }}</el-tag>
              </el-checkbox>
            </div>
            <el-button
              v-if="hiddenTopologyNodesCount > 0"
              text
              type="primary"
              size="small"
              @click="showAllTopologyNodesInPicker = true"
            >
              显示更多（还有 {{ hiddenTopologyNodesCount }} 项）
            </el-button>
          </el-checkbox-group>
          <div class="form-hint">已选 {{ copyNodesSelected.length }} 个节点</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="copyNodesSaving" @click="copyNodesDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="copyNodesSaving" @click="confirmCopyNodes">
          {{ copyNodesSaving ? '复制中…' : `复制 ${copyNodesSelected.length} 个节点` }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.topology-page { max-width: 1400px; }

.main-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.main-header-left { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.main-header-right { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.main-header-title { white-space: nowrap; font-weight: 600; }

/* 加载骨架 */
.loading-skeleton { display: flex; flex-direction: column; gap: 12px; }
.loading-progress-bar { height: 3px; background: var(--mf-bg-elevated); border-radius: 2px; overflow: hidden; }
.loading-progress-fill { height: 100%; background: var(--mf-primary); border-radius: 2px; }
.loading-phase-text { color: var(--mf-text-secondary); font-size: 13px; padding: 2px 0 4px; }
.skeleton-layer { border: 1px solid var(--mf-border); border-radius: 8px; padding: 12px; }
.skeleton-header { padding-left: 10px; border-left: 3px solid var(--mf-text-muted); margin-bottom: 10px; }
.skeleton-header-bar { height: 14px; background: var(--mf-bg-elevated); border-radius: 3px; }
.skeleton-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.skeleton-chip { height: 26px; background: var(--mf-bg-elevated); border-radius: 4px; }

/* 回退分层 */
.layer-view { display: flex; flex-direction: column; gap: 16px; }
.layer-group { border: 1px solid var(--mf-border); border-radius: 10px; padding: 14px; background: var(--mf-bg-surface); }
.layer-header { font-weight: 600; font-size: 14px; color: var(--mf-primary); padding-left: 10px; border-left: 3px solid var(--mf-primary); margin-bottom: 10px; }
.layer-services { display: flex; flex-wrap: wrap; gap: 8px; }
.service-chip { display: inline-flex; align-items: center; gap: 4px; padding: 6px 14px; border-radius: 6px; background: var(--mf-bg-deep); color: var(--mf-text-secondary); font-size: 13px; cursor: pointer; border: 1px solid var(--mf-border); font-family: 'JetBrains Mono', monospace; }
.service-chip:hover { background: var(--mf-primary-dim); color: var(--mf-primary); border-color: var(--mf-border-active); }
.service-chip.active { background: var(--mf-primary); color: var(--mf-bg-deepest); border-color: var(--mf-primary); font-weight: 600; }

/* 空引导 */
.empty-guide { padding: 32px 16px; text-align: center; }
.empty-icon { margin-bottom: 16px; }
.empty-title { font-size: 18px; font-weight: 600; color: var(--mf-text-primary); margin: 0 0 8px; }
.empty-desc { font-size: 13px; color: var(--mf-text-secondary); margin: 0 0 24px; }
.guide-steps { text-align: left; max-width: 520px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.guide-step { display: flex; gap: 12px; align-items: flex-start; }
.step-number { width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg, var(--mf-primary), var(--mf-accent)); color: var(--mf-bg-deepest); font-size: 13px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 2px; box-shadow: 0 0 12px var(--mf-primary-glow); }
.step-content { flex: 1; }
.step-title { font-size: 14px; font-weight: 500; color: var(--mf-text-primary); margin-bottom: 6px; }
.step-code { display: block; background: var(--mf-bg-deep); border: 1px solid var(--mf-border); padding: 8px 12px; border-radius: 6px; font-size: 12px; color: var(--mf-primary); font-family: 'JetBrains Mono', 'SF Mono', monospace; word-break: break-all; margin-bottom: 4px; }
.known-pl-hint { font-size: 12px; color: var(--mf-text-muted); margin: 8px 0 0; line-height: 1.5; }

/* 表单 */
.form-hint { font-size: 12px; color: var(--mf-text-muted); margin-top: 4px; line-height: 1.5; }
</style>
