<script setup lang="ts">
// Created by dev on 2026/04/05
import { ref, computed, onMounted } from 'vue'
import { indexDocuments, syncDocuments, watchDocs, recallMemory, type IndexResult } from '../api/mcp-tools'
import { useAuthStore } from '../stores/auth'
import { expandTildePath } from '../config/app-paths'
import { ElMessage } from 'element-plus'

const authStore = useAuthStore()
const activeTab = ref('index')
const showGuide = ref(false)

const STORAGE_KEY = 'memforge-docindex-project-root'

const projectRoot = ref(localStorage.getItem(STORAGE_KEY) ?? '')
const knownProjects = ref<Array<{ label: string; path: string; techStack: string; productLine: string }>>([])
const showProjectInput = ref(false)
const projectSearch = ref('')
const selectedPL = ref('')

function saveProjectRoot(): void {
  const v = projectRoot.value.trim()
  if (v) localStorage.setItem(STORAGE_KEY, v)
}

function clearProjectRoot(): void {
  projectRoot.value = ''
  localStorage.removeItem(STORAGE_KEY)
}

function selectProject(path: string): void {
  projectRoot.value = path
  saveProjectRoot()
}

const productLines = computed(() => {
  const pls = new Set<string>()
  for (const p of knownProjects.value) {
    if (p.productLine) pls.add(p.productLine)
  }
  return [...pls].sort()
})

const filteredProjects = computed(() => {
  let result = knownProjects.value
  if (selectedPL.value) {
    result = result.filter(p => p.productLine === selectedPL.value)
  }
  const q = projectSearch.value.trim().toLowerCase()
  if (q) {
    result = result.filter(p =>
      p.label.toLowerCase().includes(q) ||
      p.path.toLowerCase().includes(q) ||
      p.techStack.toLowerCase().includes(q),
    )
  }
  return result
})

async function detectProjects(): Promise<void> {
  if (!authStore.isAuthenticated) return
  try {
    const r = await recallMemory('服务节点 本地路径 仓库', 30, {
      tags_filter: ['topology', 'service'],
      scope_filter: ['architecture'],
      min_similarity: 0.2,
    })
    if (!r.success) return
    const seen = new Set<string>()
    for (const item of r.results) {
      const pathMatch = item.content.match(/本地路径[:：]\s*(.+)/)
      const nameMatch = item.content.match(/仓库ID[:：]\s*(.+)/)
      const techMatch = item.content.match(/技术栈[:：]\s*(.+)/)
      if (pathMatch) {
        const p = expandTildePath(pathMatch[1].trim())
        if (!seen.has(p)) {
          seen.add(p)
          let pl = ''
          for (const tag of item.tags) {
            const m = tag.match(/^pl:(.+)/)
            if (m) { pl = m[1]; break }
          }
          knownProjects.value.push({
            label: nameMatch ? nameMatch[1].trim() : p.split('/').pop() ?? p,
            path: p,
            techStack: techMatch ? techMatch[1].trim() : '',
            productLine: pl,
          })
        }
      }
    }
    knownProjects.value.sort((a, b) => a.label.localeCompare(b.label))
  } catch (e) {
    console.error('加载项目列表失败:', e)
  }
}

const projectDisplay = computed(() => {
  if (!projectRoot.value) return '未选择项目（将使用 Memforge 服务目录）'
  const found = knownProjects.value.find(p => p.path === projectRoot.value)
  return found ? `${found.label} (${found.path})` : projectRoot.value
})

const indexForm = ref({
  directory: 'docs',
  scope: 'domain_knowledge',
  recursive: true,
  dryRun: false,
  productLine: '',
})

const scopeOptions = [
  { value: 'domain_knowledge', label: '领域知识' },
  { value: 'architecture', label: '架构文档' },
  { value: 'convention', label: '团队约定' },
  { value: 'context', label: '上下文' },
  { value: 'coding_standard', label: '编码规范' },
]

const syncForm = ref({
  since: 'HEAD~5',
  directory: '',
  dryRun: false,
})

const watchDirectory = ref('docs')
const watchStatus = ref<{
  active: boolean
  directory: string
  filesProcessed: number
  lastEvent: string | null
} | null>(null)

const indexResult = ref<IndexResult | null>(null)
const syncResult = ref<{ synced: number; changes: Array<{ file: string; action: string }> } | null>(null)

const indexLoading = ref(false)
const syncLoading = ref(false)
const watchLoading = ref(false)

function buildProjectRootParam(): Record<string, string> {
  const root = projectRoot.value.trim()
  return root ? { project_root: root } : {}
}

async function handleIndex(): Promise<void> {
  if (!authStore.isAuthenticated) {
    ElMessage.warning('请先连接 Gateway')
    return
  }
  indexLoading.value = true
  try {
    const params: Parameters<typeof indexDocuments>[0] = {
      directory: indexForm.value.directory,
      scope: indexForm.value.scope,
      recursive: indexForm.value.recursive,
      dry_run: indexForm.value.dryRun,
      ...buildProjectRootParam(),
    }
    if (indexForm.value.productLine) params.product_line = indexForm.value.productLine

    const result = await indexDocuments(params)
    indexResult.value = result
    ElMessage.success(`索引完成：${result.totalStored ?? 0} 条已存储，${result.totalDuplicates ?? 0} 条重复`)
  } catch (err) {
    ElMessage.error(`索引失败: ${(err as Error).message}`)
  } finally {
    indexLoading.value = false
  }
}

async function handleSync(): Promise<void> {
  if (!authStore.isAuthenticated) {
    ElMessage.warning('请先连接 Gateway')
    return
  }
  syncLoading.value = true
  try {
    const params: Parameters<typeof syncDocuments>[0] = {
      ...buildProjectRootParam(),
    }
    if (syncForm.value.since) params.since = syncForm.value.since
    if (syncForm.value.directory) params.directory = syncForm.value.directory
    if (syncForm.value.dryRun) params.dry_run = true

    const result = await syncDocuments(params)
    syncResult.value = { synced: result.synced, changes: result.changes ?? [] }
    ElMessage.success(`同步完成：${result.synced} 个文档`)
  } catch (err) {
    ElMessage.error(`同步失败: ${(err as Error).message}`)
  } finally {
    syncLoading.value = false
  }
}

async function startWatch(): Promise<void> {
  if (!authStore.isAuthenticated) {
    ElMessage.warning('请先连接 Gateway')
    return
  }
  watchLoading.value = true
  try {
    const result = await watchDocs({
      action: 'start',
      directory: watchDirectory.value,
      ...buildProjectRootParam(),
    })
    watchStatus.value = {
      active: true,
      directory: result.directory ?? watchDirectory.value,
      filesProcessed: result.filesProcessed ?? 0,
      lastEvent: null,
    }
    ElMessage.success(`目录监控已启动: ${result.directory ?? watchDirectory.value}`)
  } catch (err) {
    ElMessage.error(`启动监控失败: ${(err as Error).message}`)
  } finally {
    watchLoading.value = false
  }
}

function stopWatch(): void {
  if (watchStatus.value) {
    watchDocs({
      action: 'stop',
      directory: watchDirectory.value,
      ...buildProjectRootParam(),
    }).catch(() => { /* ignore */ })
    watchStatus.value.active = false
    ElMessage.info('监控已停止')
  }
}

const watchStatusText = computed(() => {
  if (!watchStatus.value || !watchStatus.value.active) return '未启动'
  return `运行中 · 已处理 ${watchStatus.value.filesProcessed} 个文件`
})

const watchStatusType = computed(() => {
  if (!watchStatus.value || !watchStatus.value.active) return 'info'
  return 'success'
})

onMounted(() => {
  detectProjects()
})
</script>

<template>
  <div>
    <!-- 使用指南 -->
    <el-card style="margin-bottom: 16px" shadow="never">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center">
          <span style="font-weight: 600">文档索引使用指南</span>
          <el-button text :type="showGuide ? 'info' : 'primary'" size="small" @click="showGuide = !showGuide">
            {{ showGuide ? '收起' : '展开说明' }}
          </el-button>
        </div>
      </template>
      <p style="color: #606266; font-size: 13px; margin: 0">
        将项目文档（Markdown / Text）自动拆分为语义段落并存入记忆库，让 AI 编程助手在对话中检索和引用项目知识。
      </p>
      <div v-if="showGuide" style="margin-top: 16px">
        <el-descriptions :column="1" border size="small" style="margin-bottom: 16px">
          <el-descriptions-item label="批量索引">
            <strong>index_documents</strong> — 全量扫描指定目录下的 Markdown/Text 文件，拆分为语义段落存入记忆库。
            内置向量去重（相似度 ≥ 0.92 跳过），可安全重复执行。
            <el-tag size="small" type="info" style="margin-left: 8px">适合首次导入</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="Git 增量同步">
            <strong>sync_documents</strong> — 基于 git diff 仅处理自上次同步以来变更的文档文件，开销极低。
            <el-tag size="small" type="success" style="margin-left: 8px">推荐日常使用</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="目录监控">
            <strong>watch_docs</strong> — 启动后台 fs.watch 监听文件变化，带 500ms 防抖自动更新记忆库。
            <el-tag size="small" type="warning" style="margin-left: 8px">适合频繁更新项目</el-tag>
          </el-descriptions-item>
        </el-descriptions>
        <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px">
          <template #title>推荐工作流</template>
          <template #default>
            <ol style="margin: 4px 0 0 -20px; line-height: 1.8; font-size: 12px">
              <li>新项目首次接入：使用「批量索引」导入 docs/ 目录全部文档</li>
              <li>日常开发中：每次会话开始时 AI 自动调用「Git 增量同步」</li>
              <li>文档频繁更新的项目：启动「目录监控」实时跟踪变化</li>
            </ol>
          </template>
        </el-alert>
        <el-alert type="warning" :closable="false" show-icon>
          <template #title>注意事项</template>
          <template #default>
            <ul style="margin: 4px 0 0 -20px; line-height: 1.8; font-size: 12px">
              <li>项目文档统一存放在 <code>docs/</code> 目录下（<code>.cursor/prDocs/</code> 已弃用）</li>
              <li>支持文件格式：.md、.txt、.rst</li>
              <li>单文件上限约 100KB；超大文件建议拆分</li>
              <li>批量索引和 Git 同步均为幂等操作，重复执行不会产生重复数据</li>
            </ul>
          </template>
        </el-alert>
      </div>
    </el-card>

    <!-- 项目选择器 -->
    <el-card style="margin-bottom: 16px">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center">
          <span>目标项目</span>
          <el-button text type="primary" size="small" @click="showProjectInput = !showProjectInput">
            {{ showProjectInput ? '关闭' : '手动输入' }}
          </el-button>
        </div>
      </template>

      <el-alert v-if="!projectRoot" type="warning" :closable="false" show-icon style="margin-bottom: 12px">
        <template #title>
          未选择项目路径。所有操作将在 Memforge 服务自身目录下执行，这通常不是预期行为。
          请选择或输入要操作的项目路径。
        </template>
      </el-alert>

      <div v-if="showProjectInput" style="margin-bottom: 12px">
        <el-input
          v-model="projectRoot"
          placeholder="输入项目绝对路径，如 /home/user/projects/my-api"
          @change="saveProjectRoot"
        >
          <template #prepend>项目路径</template>
        </el-input>
      </div>

      <div v-if="knownProjects.length > 0">
        <el-row :gutter="12" style="margin-bottom: 8px">
          <el-col :span="8">
            <el-select v-model="selectedPL" placeholder="全部产品线" clearable size="small" style="width: 100%">
              <el-option v-for="pl in productLines" :key="pl" :label="pl" :value="pl" />
            </el-select>
          </el-col>
          <el-col :span="16">
            <el-input v-model="projectSearch" placeholder="搜索仓库名、路径或技术栈..." size="small" clearable prefix-icon="Search" />
          </el-col>
        </el-row>
        <div style="color: #909399; font-size: 12px; margin-bottom: 6px">
          {{ filteredProjects.length }} / {{ knownProjects.length }} 个仓库
        </div>
        <div class="project-grid">
          <div
            v-for="proj in filteredProjects"
            :key="proj.path"
            class="project-item"
            :class="{ active: projectRoot === proj.path }"
            @click="selectProject(proj.path)"
          >
            <div class="project-name">
              {{ proj.label }}
              <el-tag v-if="proj.techStack" size="small" type="info" style="margin-left: 4px; vertical-align: middle">{{ proj.techStack }}</el-tag>
            </div>
            <div class="project-path">{{ proj.path }}</div>
          </div>
        </div>
      </div>

      <div v-if="projectRoot" style="margin-top: 12px">
        <el-tag type="success" size="small">当前：{{ projectDisplay }}</el-tag>
        <el-button text type="danger" size="small" style="margin-left: 8px" @click="clearProjectRoot">
          清除
        </el-button>
      </div>
    </el-card>

    <el-tabs v-model="activeTab" type="border-card">
      <!-- 批量索引 -->
      <el-tab-pane label="批量索引" name="index">
        <el-row :gutter="20">
          <el-col :span="10">
            <el-card shadow="never">
              <template #header>
                <span>索引配置</span>
              </template>
              <el-form :model="indexForm" label-width="100px">
                <el-form-item label="目录路径">
                  <el-input v-model="indexForm.directory" placeholder="docs/" />
                  <div style="font-size: 11px; color: #909399; margin-top: 4px">
                    相对于上方选择的项目路径
                  </div>
                </el-form-item>
                <el-form-item label="记忆类型">
                  <el-select v-model="indexForm.scope" style="width: 100%">
                    <el-option v-for="opt in scopeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
                  </el-select>
                </el-form-item>
                <el-form-item label="产品线">
                  <el-input v-model="indexForm.productLine" placeholder="留空=当前项目；如 my-product" />
                </el-form-item>
                <el-form-item label="递归扫描">
                  <el-switch v-model="indexForm.recursive" />
                </el-form-item>
                <el-form-item label="试运行">
                  <el-switch v-model="indexForm.dryRun" />
                  <span style="margin-left: 8px; color: #909399; font-size: 12px">仅分析不存储</span>
                </el-form-item>
                <el-form-item>
                  <el-button type="primary" :loading="indexLoading" icon="FolderOpened" @click="handleIndex">
                    {{ indexForm.dryRun ? '预览索引' : '开始索引' }}
                  </el-button>
                </el-form-item>
              </el-form>
            </el-card>
          </el-col>

          <el-col :span="14">
            <el-card shadow="never">
              <template #header>
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <span>索引结果</span>
                  <el-tag v-if="indexResult" type="success" size="small">
                    {{ indexResult.totalFiles ?? 0 }} 文件 / {{ indexResult.totalStored ?? 0 }} 已存储
                  </el-tag>
                </div>
              </template>
              <el-empty v-if="!indexResult" description="配置参数后点击「开始索引」" />
              <el-table v-else :data="indexResult.results ?? []" stripe size="small">
                <el-table-column prop="file" label="文件" min-width="200" />
                <el-table-column prop="stored" label="已存储" width="80" align="center" />
                <el-table-column prop="duplicates" label="重复" width="70" align="center" />
                <el-table-column prop="errors" label="错误" width="70" align="center" />
              </el-table>
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- Git 同步 -->
      <el-tab-pane label="Git 同步" name="sync">
        <el-row :gutter="20">
          <el-col :span="10">
            <el-card shadow="never">
              <template #header>
                <span>同步配置</span>
              </template>
              <el-form :model="syncForm" label-width="100px">
                <el-form-item label="起始引用">
                  <el-input v-model="syncForm.since" placeholder="HEAD~5 或 commit hash" />
                </el-form-item>
                <el-form-item label="指定目录">
                  <el-input v-model="syncForm.directory" placeholder="留空则检测 docs/ 目录" />
                  <div style="font-size: 11px; color: #909399; margin-top: 4px">
                    基于上方选择的项目 Git 仓库执行 git diff
                  </div>
                </el-form-item>
                <el-form-item label="试运行">
                  <el-switch v-model="syncForm.dryRun" />
                </el-form-item>
                <el-form-item>
                  <el-button type="primary" :loading="syncLoading" icon="Refresh" @click="handleSync">
                    {{ syncForm.dryRun ? '预览同步' : '开始同步' }}
                  </el-button>
                </el-form-item>
              </el-form>
            </el-card>
          </el-col>

          <el-col :span="14">
            <el-card shadow="never">
              <template #header>
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <span>同步结果</span>
                  <el-tag v-if="syncResult" type="success" size="small">{{ syncResult.synced }} 个文档已同步</el-tag>
                </div>
              </template>
              <el-empty v-if="!syncResult" description="配置参数后点击「开始同步」" />
              <el-table v-else :data="syncResult.changes" stripe size="small">
                <el-table-column prop="file" label="文件" min-width="200" />
                <el-table-column label="操作" width="100">
                  <template #default="{ row }">
                    <el-tag :type="row.action === 'added' ? 'success' : row.action === 'modified' ? 'warning' : 'danger'" size="small">
                      {{ row.action }}
                    </el-tag>
                  </template>
                </el-table-column>
              </el-table>
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- 目录监控 -->
      <el-tab-pane label="目录监控" name="watch">
        <el-row :gutter="20">
          <el-col :span="10">
            <el-card shadow="never">
              <template #header>
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <span>监控控制</span>
                  <el-tag :type="watchStatusType" size="small">{{ watchStatusText }}</el-tag>
                </div>
              </template>
              <el-form label-width="100px">
                <el-form-item label="监控目录">
                  <el-input v-model="watchDirectory" placeholder="docs" :disabled="watchStatus?.active" />
                  <div style="font-size: 11px; color: #909399; margin-top: 4px">
                    相对于上方选择的项目路径
                  </div>
                </el-form-item>
                <el-form-item>
                  <el-button
                    v-if="!watchStatus?.active"
                    type="success"
                    icon="VideoPlay"
                    :loading="watchLoading"
                    @click="startWatch"
                  >
                    启动监控
                  </el-button>
                  <el-button
                    v-else
                    type="danger"
                    icon="VideoPause"
                    @click="stopWatch"
                  >
                    停止监控
                  </el-button>
                </el-form-item>
              </el-form>
            </el-card>
          </el-col>

          <el-col :span="14">
            <el-card shadow="never">
              <template #header>
                <span>工作原理</span>
              </template>
              <el-timeline>
                <el-timeline-item timestamp="步骤 1" placement="top">
                  <h4>初始扫描</h4>
                  <p style="color: #909399">启动时扫描目录下所有文档文件，去重后批量索引到记忆库。</p>
                </el-timeline-item>
                <el-timeline-item timestamp="步骤 2" placement="top">
                  <h4>持续监控</h4>
                  <p style="color: #909399">使用 fs.watch 监听文件变化（新增/修改/删除），带 500ms 防抖。</p>
                </el-timeline-item>
                <el-timeline-item timestamp="步骤 3" placement="top">
                  <h4>自动更新</h4>
                  <p style="color: #909399">文件修改时，先归档旧记忆，再重新拆分索引。文件删除时自动归档关联记忆。</p>
                </el-timeline-item>
              </el-timeline>
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 6px;
  max-height: 144px;
  overflow-y: auto;
}

.project-item {
  padding: 6px 10px;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  cursor: pointer;
}

.project-item:hover {
  border-color: #409eff;
  background: #ecf5ff;
}

.project-item.active {
  border-color: #409eff;
  background: #409eff;
  color: #fff;
}

.project-item.active .project-path {
  color: rgba(255, 255, 255, 0.8);
}

.project-name {
  font-size: 13px;
  font-weight: 500;
}

.project-path {
  font-size: 11px;
  color: #909399;
  margin-top: 2px;
  word-break: break-all;
}
</style>
