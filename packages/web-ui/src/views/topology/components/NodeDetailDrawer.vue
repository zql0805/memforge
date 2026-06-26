<script setup lang="ts">
// Created by dev on 2026/04/08
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DocumentCopy, CirclePlus, Close, View } from '@element-plus/icons-vue'
import type { ServiceNode, ServiceEdge, ApiNode, TopologyFullData, UserPathsCoverage } from '../types'
import { infraTagType, repoShortName } from '../types'
import { addTopologyEdge, removeTopologyEdge } from '../../../api/client'

const props = defineProps<{
  visible: boolean
  selectedNode: ServiceNode | null
  edges: ServiceEdge[]
  structuredData: TopologyFullData | null
  userPathsCoverage: UserPathsCoverage[]
  canEdit: boolean
  productLine: string
}>()

const router = useRouter()

const emit = defineEmits<{
  'update:visible': [val: boolean]
  selectNode: [repoId: string]
  openEdit: []
  edgeChanged: []
}>()

const apiNode = computed<ApiNode | null>(() => {
  if (!props.selectedNode || !props.structuredData) return null
  return props.structuredData.nodes.find(n => n.repoId === props.selectedNode!.id) ?? null
})

const upstreamEdges = computed(() => {
  if (!props.selectedNode) return []
  const id = props.selectedNode.id
  return props.edges.filter(e => e.toRepoId === id || e.to === props.selectedNode!.name)
})

const downstreamEdges = computed(() => {
  if (!props.selectedNode) return []
  const id = props.selectedNode.id
  return props.edges.filter(e => e.fromRepoId === id || e.from === props.selectedNode!.name)
})

interface DepGroup { type: string; items: Array<{ name: string; detail?: string }> }
const groupedDeps = computed<DepGroup[]>(() => {
  if (!apiNode.value?.dependencies?.length) return []
  const groups = new Map<string, Array<{ name: string; detail?: string }>>()
  for (const dep of apiNode.value.dependencies as Array<Record<string, string>>) {
    const type = dep.type || 'other'
    if (!groups.has(type)) groups.set(type, [])
    const name = dep.serviceUri || dep.artifactId || dep.name || dep.package || JSON.stringify(dep)
    groups.get(type)!.push({ name, detail: dep.groupId })
  }
  return [...groups.entries()].map(([type, items]) => ({ type, items }))
})

const signalEntries = computed<Array<{ key: string; value: boolean }>>(() => {
  if (!apiNode.value?.signals) return []
  return Object.entries(apiNode.value.signals)
    .filter(([, v]) => v === true)
    .map(([key]) => ({ key, value: true }))
})

const infraList = computed(() => {
  if (!apiNode.value?.metadata?.infra) return []
  const infra = apiNode.value.metadata.infra as Array<{ type: string; host?: string; port?: string; database?: string; cluster?: string; env: string }>
  return infra.map(item => {
    let display = ''
    if (item.cluster) display = item.cluster
    else if (item.host && item.database) display = `${item.host}/${item.database}`
    else if (item.host) display = item.host + (item.port ? `:${item.port}` : '')
    else display = item.cluster ?? '?'
    return { type: item.type, display, env: item.env }
  })
})

interface InfraGrp { type: string; items: typeof infraList.value }
const groupedInfra = computed<InfraGrp[]>(() => {
  const groups = new Map<string, typeof infraList.value>()
  for (const item of infraList.value) {
    if (!groups.has(item.type)) groups.set(item.type, [])
    groups.get(item.type)!.push(item)
  }
  return [...groups.entries()].map(([type, items]) => ({ type, items }))
})

const clonedByUsers = computed(() => {
  if (!props.selectedNode) return []
  return props.userPathsCoverage.filter(uc => uc.repoCount > 0)
})

function copyText(text: string): void {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      ElMessage.success('已复制')
    }).catch(() => {
      fallbackCopy(text)
    })
  } else {
    fallbackCopy(text)
  }
}

function fallbackCopy(text: string): void {
  const el = document.createElement('textarea')
  el.value = text
  el.style.position = 'fixed'
  el.style.opacity = '0'
  document.body.appendChild(el)
  el.select()
  try {
    document.execCommand('copy')
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('复制失败，请手动复制')
  } finally {
    document.body.removeChild(el)
  }
}

function goToNode(repoId: string): void {
  emit('selectNode', repoId)
  emit('update:visible', false)
}

// ─── 调用链编辑 ─────────────────────────────────
const addEdgeDialogVisible = ref(false)
const addEdgeDirection = ref<'downstream' | 'upstream'>('downstream')
const addEdgeTargetRepoId = ref('')
const addEdgeProtocol = ref('HTTP API')
const addEdgeLoading = ref(false)

const PROTOCOL_OPTIONS = ['MOA RPC', 'HTTP API', 'SDK', 'Kafka', 'gRPC', 'RPC']

const availableNodes = computed(() => {
  if (!props.structuredData || !props.selectedNode) return []
  return props.structuredData.nodes
    .filter(n => n.repoId !== props.selectedNode!.id)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
})

function openAddEdgeDialog(): void {
  addEdgeTargetRepoId.value = ''
  addEdgeProtocol.value = 'HTTP API'
  addEdgeDirection.value = 'downstream'
  addEdgeDialogVisible.value = true
}

function findApiEdgeId(fromRepoId: string, toRepoId: string): string | null {
  return props.structuredData?.edges.find(
    e => e.fromRepoId === fromRepoId && e.toRepoId === toRepoId,
  )?.id ?? null
}

async function handleRemoveEdge(fromRepoId: string | undefined, toRepoId: string | undefined): Promise<void> {
  if (!fromRepoId || !toRepoId || !props.productLine) return
  const edgeId = findApiEdgeId(fromRepoId, toRepoId)
  if (!edgeId) {
    ElMessage.error('未找到调用关系记录，可能已被删除')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定要删除 ${repoShortName(fromRepoId)} → ${repoShortName(toRepoId)} 的调用关系吗？`,
      '确认删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    await removeTopologyEdge(props.productLine, edgeId)
    ElMessage.success('调用关系已删除')
    emit('edgeChanged')
  } catch {
    // 用户取消或删除失败时不做处理
  }
}

async function submitAddEdge(): Promise<void> {
  if (!addEdgeTargetRepoId.value || !props.selectedNode || !props.productLine) return
  addEdgeLoading.value = true
  try {
    const fromRepoId = addEdgeDirection.value === 'downstream'
      ? props.selectedNode.id
      : addEdgeTargetRepoId.value
    const toRepoId = addEdgeDirection.value === 'downstream'
      ? addEdgeTargetRepoId.value
      : props.selectedNode.id
    await addTopologyEdge(props.productLine, { fromRepoId, toRepoId, protocol: addEdgeProtocol.value })
    ElMessage.success('调用关系已添加')
    addEdgeDialogVisible.value = false
    emit('edgeChanged')
  } catch (err) {
    ElMessage.error('添加失败：' + (err as Error).message)
  } finally {
    addEdgeLoading.value = false
  }
}
</script>

<template>
  <el-drawer
    :model-value="visible"
    title="项目百科"
    :size="520"
    direction="rtl"
    @update:model-value="emit('update:visible', $event)"
  >
    <template v-if="selectedNode && apiNode">
      <!-- 顶部 Hero 区域 -->
      <div class="node-hero">
        <div class="hero-main">
          <span class="hero-name">{{ apiNode.displayName }}</span>
          <el-tag size="small" effect="dark" class="hero-tech">{{ apiNode.techStack ?? '未知' }}</el-tag>
        </div>
        <div class="hero-meta">
          <span class="hero-repo-id">{{ apiNode.repoId }}</span>
          <span class="hero-layer">第 {{ apiNode.layerIndex }} 层 · {{ apiNode.layerName ?? '待归类' }}</span>
        </div>
        <p v-if="apiNode.description" class="hero-desc">{{ apiNode.description }}</p>
      </div>

      <!-- 本地路径 -->
      <div v-if="apiNode.localPath" class="detail-section">
        <h4 class="section-title">本地路径</h4>
        <div class="copyable" @click="copyText(apiNode.localPath!)">
          <code class="path-code">{{ apiNode.localPath }}</code>
          <el-icon class="copy-icon"><DocumentCopy /></el-icon>
        </div>
      </div>

      <!-- Git 信息 -->
      <div v-if="apiNode.gitRemoteUrl" class="detail-section">
        <h4 class="section-title">Git 信息</h4>
        <div class="info-grid">
          <div class="info-row">
            <span class="info-label">Remote</span>
            <div class="copyable" @click="copyText(apiNode.gitRemoteUrl!)">
              <code class="info-value mono">{{ apiNode.gitRemoteUrl }}</code>
              <el-icon class="copy-icon"><DocumentCopy /></el-icon>
            </div>
          </div>
          <div v-if="apiNode.gitHost" class="info-row">
            <span class="info-label">Host</span>
            <span class="info-value">{{ apiNode.gitHost }}</span>
          </div>
          <div v-if="apiNode.gitGroup" class="info-row">
            <span class="info-label">Group</span>
            <span class="info-value">{{ apiNode.gitGroup }}</span>
          </div>
        </div>
      </div>

      <!-- 调用关系 -->
      <div class="detail-section">
        <div class="section-header">
          <h4 class="section-title">调用关系</h4>
          <el-button v-if="canEdit" size="small" :icon="CirclePlus" type="primary" link @click="openAddEdgeDialog">
            添加
          </el-button>
        </div>
        <div v-if="upstreamEdges.length > 0" class="edge-section">
          <span class="edge-label">上游调用方 ({{ upstreamEdges.length }})</span>
          <div class="edge-tags">
            <span v-for="e in upstreamEdges" :key="`u-${e.fromRepoId ?? e.from}`" class="edge-item">
              <el-tag
                size="small" type="warning" class="edge-tag clickable"
                @click="e.fromRepoId && goToNode(e.fromRepoId)"
              >
                {{ repoShortName(e.fromRepoId ?? e.from) }}
                <span class="edge-protocol">{{ e.protocol }}</span>
              </el-tag>
              <el-icon
                v-if="canEdit"
                class="edge-delete-btn"
                title="删除此调用关系"
                @click.stop="handleRemoveEdge(e.fromRepoId, selectedNode?.id)"
              >
                <Close />
              </el-icon>
            </span>
          </div>
        </div>
        <div v-if="downstreamEdges.length > 0" class="edge-section">
          <span class="edge-label">下游依赖 ({{ downstreamEdges.length }})</span>
          <div class="edge-tags">
            <span v-for="e in downstreamEdges" :key="`d-${e.toRepoId ?? e.to}`" class="edge-item">
              <el-tag
                size="small" class="edge-tag clickable"
                @click="e.toRepoId && goToNode(e.toRepoId)"
              >
                {{ repoShortName(e.toRepoId ?? e.to) }}
                <span class="edge-protocol">{{ e.protocol }}</span>
              </el-tag>
              <el-icon
                v-if="canEdit"
                class="edge-delete-btn"
                title="删除此调用关系"
                @click.stop="handleRemoveEdge(selectedNode?.id, e.toRepoId)"
              >
                <Close />
              </el-icon>
            </span>
          </div>
        </div>
        <div v-if="upstreamEdges.length === 0 && downstreamEdges.length === 0" class="no-edges">
          无调用关系
        </div>
      </div>

      <!-- 基础设施 -->
      <div v-if="groupedInfra.length > 0" class="detail-section">
        <h4 class="section-title">基础设施</h4>
        <div v-for="group in groupedInfra" :key="group.type" class="infra-group-row">
          <el-tag :type="infraTagType(group.type)" size="small" class="infra-type-tag">{{ group.type.toUpperCase() }}</el-tag>
          <div class="infra-items">
            <el-tag
              v-for="(item, i) in group.items" :key="i"
              size="small" effect="plain"
              :title="`${item.display} [${item.env}]`"
            >
              {{ item.display }}
              <span v-if="item.env !== 'default'" class="infra-env">{{ item.env }}</span>
            </el-tag>
          </div>
        </div>
      </div>

      <!-- 依赖清单 -->
      <div v-if="groupedDeps.length > 0" class="detail-section">
        <h4 class="section-title">依赖清单</h4>
        <div v-for="group in groupedDeps" :key="group.type" class="dep-group">
          <el-tag size="small" effect="dark" class="dep-type-tag">{{ group.type }}</el-tag>
          <div class="dep-items">
            <el-tag
              v-for="(item, i) in group.items" :key="i"
              size="small" effect="plain"
              :title="item.detail ? `${item.detail}:${item.name}` : item.name"
            >
              {{ item.name }}
            </el-tag>
          </div>
        </div>
      </div>

      <!-- 仓库特征 -->
      <div v-if="signalEntries.length > 0" class="detail-section">
        <h4 class="section-title">仓库特征</h4>
        <div class="signal-tags">
          <el-tag v-for="s in signalEntries" :key="s.key" size="small" type="success" effect="plain">
            {{ s.key }}
          </el-tag>
        </div>
      </div>

      <!-- 扫描信息 + 团队覆盖 -->
      <div class="detail-section">
        <h4 class="section-title">元信息</h4>
        <div class="info-grid">
          <div v-if="apiNode.scannedBy" class="info-row">
            <span class="info-label">扫描者</span>
            <span class="info-value">{{ apiNode.scannedBy }}</span>
          </div>
          <div v-if="apiNode.lastScannedAt" class="info-row">
            <span class="info-label">扫描时间</span>
            <span class="info-value">{{ new Date(apiNode.lastScannedAt).toLocaleString() }}</span>
          </div>
          <div v-if="apiNode.isManual" class="info-row">
            <span class="info-label">来源</span>
            <el-tag size="small" type="warning">手动添加</el-tag>
          </div>
        </div>
        <div v-if="clonedByUsers.length > 0" style="margin-top: 8px;">
          <span class="info-label" style="display: block; margin-bottom: 4px;">团队覆盖</span>
          <div class="user-list">
            <el-tag v-for="uc in clonedByUsers" :key="uc.userId" size="small" type="info" class="user-tag">
              {{ uc.userId === '_system_' ? '旧数据' : (uc.displayName || uc.userId.slice(0, 8)) }}
            </el-tag>
          </div>
        </div>
      </div>

      <div class="detail-actions">
        <el-button size="small" type="primary" :icon="View" @click="router.push({ name: 'ProjectDetail', params: { productLine, repoId: selectedNode!.id } })">
          查看详情
        </el-button>
        <el-button v-if="canEdit" size="small" @click="emit('openEdit')">编辑节点</el-button>
        <el-button v-if="apiNode.gitRemoteUrl" size="small" @click="copyText(apiNode.gitRemoteUrl!)">复制 Git 地址</el-button>
      </div>
    </template>
    <el-empty v-else description="未选择服务节点" />
  </el-drawer>

  <!-- 添加调用关系对话框 -->
  <el-dialog v-model="addEdgeDialogVisible" title="添加调用关系" width="440" :close-on-click-modal="false">
    <el-form label-width="90px">
      <el-form-item label="方向">
        <el-radio-group v-model="addEdgeDirection">
          <el-radio value="downstream">我调用 → 目标（下游）</el-radio>
          <el-radio value="upstream">目标调用 → 我（上游）</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="目标服务">
        <el-select
          v-model="addEdgeTargetRepoId"
          filterable
          placeholder="搜索并选择服务"
          style="width: 100%"
        >
          <el-option
            v-for="n in availableNodes"
            :key="n.repoId"
            :label="`${n.displayName} (${n.repoId})`"
            :value="n.repoId"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="协议">
        <el-select v-model="addEdgeProtocol" allow-create filterable style="width: 100%">
          <el-option v-for="p in PROTOCOL_OPTIONS" :key="p" :label="p" :value="p" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="addEdgeDialogVisible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="addEdgeLoading"
        :disabled="!addEdgeTargetRepoId"
        @click="submitAddEdge"
      >
        确认添加
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* Hero */
.node-hero {
  padding: 20px;
  background: var(--mf-bg-card, #2a2f36);
  border-bottom: 1px solid var(--mf-border, rgba(255, 255, 255, 0.08));
}
.hero-main {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.hero-name {
  font-size: 18px;
  font-weight: 700;
  color: var(--mf-text-primary, #d4d8de);
}
.hero-tech { flex-shrink: 0; }
.hero-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--mf-text-secondary, #8e949e);
}
.hero-repo-id {
  font-family: 'SF Mono', 'Menlo', monospace;
}
.hero-desc {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--mf-text-secondary, #8e949e);
  line-height: 1.5;
}

/* Section */
.detail-section {
  margin-bottom: 22px;
  padding: 0 20px;
}
.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--mf-text-secondary, #8e949e);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 10px;
  padding-bottom: 0;
}

/* Info grid */
.info-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.info-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-height: 24px;
}
.info-label {
  font-size: 12px;
  color: var(--mf-text-secondary, #8e949e);
  flex-shrink: 0;
  min-width: 60px;
}
.info-value {
  font-size: 13px;
  color: var(--mf-text-primary, #d4d8de);
  word-break: break-all;
}
.info-value.mono {
  font-family: 'SF Mono', 'Menlo', monospace;
  font-size: 12px;
}

/* Copyable */
.copyable {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  border-radius: 4px;
}
.copyable:hover { background: rgba(255, 255, 255, 0.04); }
.copyable:hover code { color: var(--mf-primary, #5b9bd5); }
.copy-icon { font-size: 12px; color: var(--mf-text-muted, #5a6170); }
.copyable:hover .copy-icon { color: var(--mf-primary, #5b9bd5); }
.path-code {
  font-size: 12px;
  color: var(--mf-text-secondary, #8e949e);
  font-family: 'SF Mono', 'Menlo', monospace;
  background: var(--mf-bg-deep, #1e2228);
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--mf-border, rgba(255, 255, 255, 0.08));
}

/* Tags */
.user-list { display: flex; flex-wrap: wrap; gap: 4px; }
.user-tag { font-family: 'SF Mono', 'Menlo', monospace; }
.dep-group { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 8px; }
.dep-type-tag { flex-shrink: 0; }
.dep-items { display: flex; flex-wrap: wrap; gap: 4px; }
.signal-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.infra-group-row { display: flex; align-items: flex-start; margin-bottom: 6px; gap: 6px; }
.infra-type-tag { flex-shrink: 0; }
.infra-items { display: flex; flex-wrap: wrap; gap: 4px; }
.infra-env { font-size: 10px; color: var(--el-text-color-secondary, #909399); margin-left: 2px; }

/* Edges */
.section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.section-header .section-title { margin: 0; }
.edge-section { margin-bottom: 12px; }
.edge-label {
  font-size: 12px;
  color: var(--mf-text-secondary, #8e949e);
  display: block;
  margin-bottom: 6px;
}
.edge-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.edge-item { display: inline-flex; align-items: center; gap: 2px; }
.edge-tag.clickable { cursor: pointer; }
.edge-tag.clickable:hover { opacity: 0.75; }
.edge-protocol { font-size: 10px; color: var(--mf-text-secondary, #8e949e); margin-left: 3px; }
.edge-delete-btn { font-size: 11px; color: var(--mf-text-muted, #5a6170); cursor: pointer; }
.edge-delete-btn:hover { color: var(--mf-danger, #e06060); }
.no-edges { font-size: 12px; color: var(--mf-text-muted, #5a6170); }
.detail-actions {
  margin-top: 20px;
  padding: 16px 20px;
  border-top: 1px solid var(--mf-border, rgba(255, 255, 255, 0.08));
  display: flex;
  gap: 8px;
}
</style>
