<script setup lang="ts">
// Created by dev on 2026/04/05
import { ref, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CopyDocument, Delete, Key, Plus } from '@element-plus/icons-vue'
import {
  getUserInfo, listApiKeys, createApiKey, revokeApiKey,
  type UserInfo, type ApiKeyRecord,
} from '../api/client'
import { useAuthStore } from '../stores/auth'

const authStore = useAuthStore()
const userInfo = ref<UserInfo | null>(null)
const loading = ref(false)

// ─── API Key 管理 ───
const apiKeys = ref<ApiKeyRecord[]>([])
const apiKeysLoading = ref(false)
const newKeyDialogVisible = ref(false)
const newKeyName = ref('Cursor MCP')
const newKeyExpiry = ref<number | undefined>(undefined)
const newlyCreatedKey = ref<string | null>(null)
const creatingKey = ref(false)

const expiryOptions = [
  { value: undefined, label: '永不过期' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
  { value: 365, label: '1 年' },
]

const gatewayBaseUrl = computed(() => {
  const { protocol, host } = window.location
  return `${protocol}//${host}`
})

const installCommandWithKey = computed(() => {
  const key = newlyCreatedKey.value
  if (!key) return null
  return `curl -fsSL "${gatewayBaseUrl.value}/api/setup/install-script?key=${key}" | bash`
})

const installCommandGeneric = computed(() => {
  const key = apiKeys.value.find(k => k.isActive)?.keyPrefix
  const keyParam = key ? `?key=${key}...` : '?key=YOUR_API_KEY'
  return `curl -fsSL "${gatewayBaseUrl.value}/api/setup/install-script${keyParam}" | bash`
})

async function loadUserInfo(): Promise<void> {
  if (!authStore.isAuthenticated) return
  loading.value = true
  try {
    userInfo.value = await getUserInfo()
  } catch (e) {
    console.error('加载用户信息失败:', e)
    ElMessage.error('加载用户信息失败')
  } finally {
    loading.value = false
  }
}

async function loadApiKeys(): Promise<void> {
  apiKeysLoading.value = true
  try {
    apiKeys.value = await listApiKeys()
  } catch (e) {
    console.error('加载 API Key 列表失败:', e)
    ElMessage.error('加载 API Key 列表失败')
  } finally {
    apiKeysLoading.value = false
  }
}

async function handleCreateKey(): Promise<void> {
  creatingKey.value = true
  try {
    const result = await createApiKey(newKeyName.value, newKeyExpiry.value)
    newlyCreatedKey.value = result.key
    ElMessage.success('API Key 已生成，请立即复制保存')
    await loadApiKeys()
  } catch {
    ElMessage.error('生成 API Key 失败')
  } finally {
    creatingKey.value = false
  }
}

async function handleRevokeKey(key: ApiKeyRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定撤销 API Key "${key.name}" (${key.keyPrefix}...)？撤销后使用该 Key 的 MCP 客户端将无法连接。`,
      '撤销 API Key',
      { type: 'warning', confirmButtonText: '撤销', cancelButtonText: '取消' },
    )
    await revokeApiKey(key.id)
    ElMessage.success('API Key 已撤销')
    await loadApiKeys()
  } catch {
    // 取消
  }
}

function copyToClipboard(text: string): void {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      ElMessage.success('已复制到剪贴板')
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
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.warning('复制失败，请手动复制')
  } finally {
    document.body.removeChild(el)
  }
}

function resetNewKeyDialog(): void {
  newKeyName.value = 'Cursor MCP'
  newKeyExpiry.value = undefined
  newlyCreatedKey.value = null
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('zh-CN')
}

onMounted(() => {
  loadUserInfo()
  loadApiKeys()
})

const activeTab = ref('apikeys')
</script>

<template>
  <div>
    <el-card>
      <template #header>系统设置</template>

      <el-tabs v-model="activeTab" tab-position="left">

        <!-- ─── API Key 管理（首 Tab） ─── -->
        <el-tab-pane label="API 密钥" name="apikeys">
          <div style="max-width: 800px">
            <el-alert type="info" :closable="false" style="margin-bottom: 16px">
              API Key 用于 MCP 客户端连接 Memforge 服务。
              生成 Key 后，通过「一键安装」标签页执行安装命令即可自动完成 Cursor 配置。
            </el-alert>

            <el-button type="primary" :icon="Plus" @click="newKeyDialogVisible = true; resetNewKeyDialog()">
              生成新 API Key
            </el-button>

            <el-table
              v-loading="apiKeysLoading"
              :data="apiKeys"
              size="small"
              stripe
              style="margin-top: 16px"
              empty-text="暂无 API Key，点击上方按钮生成"
            >
              <el-table-column prop="name" label="名称" width="150" />
              <el-table-column prop="keyPrefix" label="Key 前缀" width="140">
                <template #default="{ row }">
                  <code>{{ row.keyPrefix }}...</code>
                </template>
              </el-table-column>
              <el-table-column label="创建时间" width="180">
                <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="最后使用" width="180">
                <template #default="{ row }">{{ formatDate(row.lastUsedAt) }}</template>
              </el-table-column>
              <el-table-column label="过期时间" width="180">
                <template #default="{ row }">
                  <template v-if="row.expiresAt">{{ formatDate(row.expiresAt) }}</template>
                  <el-tag v-else size="small" type="success">永不过期</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="80">
                <template #default="{ row }">
                  <el-tag :type="row.isActive ? 'success' : 'danger'" size="small">
                    {{ row.isActive ? '有效' : '已撤销' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="80" fixed="right">
                <template #default="{ row }">
                  <el-button
                    v-if="row.isActive"
                    type="danger"
                    :icon="Delete"
                    size="small"
                    text
                    @click="handleRevokeKey(row)"
                  >撤销</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <!-- 生成 API Key 对话框 -->
          <el-dialog
            v-model="newKeyDialogVisible"
            :title="newlyCreatedKey ? '安装 Memforge MCP' : '生成新 API Key'"
            width="600px"
            :close-on-click-modal="!newlyCreatedKey"
          >
            <!-- 生成前：填写信息 -->
            <template v-if="!newlyCreatedKey">
              <el-form label-width="80px">
                <el-form-item label="名称">
                  <el-input v-model="newKeyName" placeholder="例如：Cursor MCP, 家里电脑" />
                </el-form-item>
                <el-form-item label="有效期">
                  <el-select v-model="newKeyExpiry" placeholder="选择有效期">
                    <el-option
                      v-for="opt in expiryOptions"
                      :key="String(opt.value)"
                      :value="opt.value"
                      :label="opt.label"
                    />
                  </el-select>
                </el-form-item>
              </el-form>
            </template>

            <!-- 生成后：展示安装命令 -->
            <template v-else>
              <el-alert type="warning" :closable="false" style="margin-bottom: 16px">
                请立即复制安装命令或 API Key。关闭对话框后将无法再次查看完整密钥。
              </el-alert>

              <div style="margin-bottom: 16px;">
                <div style="font-size: 13px; font-weight: 600; margin-bottom: 8px; color: var(--el-text-color-primary, #303133)">一键安装命令</div>
                <div style="font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px; padding: 12px; background: var(--mf-bg-deepest, #1a1d23); border-radius: 6px; word-break: break-all; color: var(--mf-text-primary, #e0e0e0); line-height: 1.6">
                  {{ installCommandWithKey }}
                </div>
                <div style="margin-top: 8px; display: flex; gap: 8px">
                  <el-button type="primary" :icon="CopyDocument" @click="copyToClipboard(installCommandWithKey ?? '')">
                    复制安装命令
                  </el-button>
                  <el-button :icon="CopyDocument" @click="copyToClipboard(newlyCreatedKey ?? '')">
                    仅复制 API Key
                  </el-button>
                </div>
              </div>

              <el-divider />
              <div style="font-size: 13px; color: var(--el-text-color-regular, #606266)">
                <p><strong>使用方法：</strong></p>
                <ol style="padding-left: 20px; line-height: 2">
                  <li>在终端中执行上方安装命令（需要 Node.js 18+）</li>
                  <li>脚本会自动下载代理并合并到 <code>~/.cursor/mcp.json</code></li>
                  <li>重启 Cursor，Memforge MCP 工具将自动可用</li>
                </ol>
              </div>
            </template>

            <template #footer>
              <template v-if="!newlyCreatedKey">
                <el-button @click="newKeyDialogVisible = false">取消</el-button>
                <el-button type="primary" :loading="creatingKey" :icon="Key" @click="handleCreateKey">
                  生成
                </el-button>
              </template>
              <template v-else>
                <el-button type="primary" @click="newKeyDialogVisible = false">我已保存，关闭</el-button>
              </template>
            </template>
          </el-dialog>
        </el-tab-pane>

        <!-- ─── 连接状态 ─── -->
        <el-tab-pane label="连接状态" name="connection">
          <div v-loading="loading" style="max-width: 600px">
            <el-descriptions v-if="userInfo" :column="1" border>
              <el-descriptions-item label="用户 ID">{{ userInfo.id }}</el-descriptions-item>
              <el-descriptions-item label="组织 ID">{{ userInfo.org_id }}</el-descriptions-item>
              <el-descriptions-item label="显示名称">{{ userInfo.display_name ?? '-' }}</el-descriptions-item>
              <el-descriptions-item label="邮箱">{{ userInfo.email ?? '-' }}</el-descriptions-item>
              <el-descriptions-item label="角色">
                <el-tag :type="userInfo.role === 'admin' ? 'danger' : 'success'" size="small">{{ userInfo.role }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="可用工具数">{{ userInfo.accessible_tools.length }}</el-descriptions-item>
            </el-descriptions>
            <el-empty v-else-if="!loading" description="未连接到 Gateway。请先在页面顶部连接。" />
          </div>
        </el-tab-pane>

        <!-- ─── 可用工具 ─── -->
        <el-tab-pane label="可用工具" name="tools">
          <el-table v-if="userInfo" :data="userInfo.accessible_tools" size="small" stripe style="max-width: 600px">
            <el-table-column prop="tool" label="工具名" width="220" />
            <el-table-column label="权限" width="100">
              <template #default="{ row }">
                <el-tag :type="row.permission === 'write' ? 'danger' : ''" size="small">{{ row.permission }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="自动授权" width="100">
              <template #default="{ row }">
                <el-tag :type="row.auto_approve ? 'success' : 'info'" size="small">{{ row.auto_approve ? '是' : '否' }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="请先连接 Gateway" />
        </el-tab-pane>

        <!-- ─── 一键安装 ─── -->
        <el-tab-pane label="一键安装" name="install">
          <div style="max-width: 800px">
            <el-alert type="success" :closable="false" style="margin-bottom: 20px">
              <template #title><strong>新用户接入指引</strong></template>
              <p style="margin: 8px 0 0">只需一条命令，即可在 Cursor 中自动配置 Memforge MCP。代理脚本支持自动更新。</p>
            </el-alert>

            <el-card shadow="never" style="margin-bottom: 16px">
              <template #header>
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <span>安装命令</span>
                  <el-button size="small" :icon="CopyDocument" @click="copyToClipboard(installCommandWithKey ?? installCommandGeneric)">复制</el-button>
                </div>
              </template>
              <div style="font-family: monospace; font-size: 13px; padding: 12px; background: var(--mf-bg-deepest, #1a1d23); border-radius: 4px; word-break: break-all; color: var(--mf-text-primary, #e0e0e0)">
                {{ installCommandWithKey ?? installCommandGeneric }}
              </div>
              <div v-if="!installCommandWithKey && !apiKeys.some(k => k.isActive)" style="margin-top: 8px; color: var(--mf-text-muted, #999); font-size: 12px">
                提示：请先在「API 密钥」标签页生成一个 API Key，替换命令中的 YOUR_API_KEY。
              </div>
            </el-card>

            <el-descriptions :column="1" border style="margin-bottom: 16px">
              <el-descriptions-item label="安装位置">~/.memforge/mcp-remote-proxy.mjs</el-descriptions-item>
              <el-descriptions-item label="配置文件">~/.cursor/mcp.json（自动合并）</el-descriptions-item>
              <el-descriptions-item label="自动更新">代理每次启动时检查服务端版本</el-descriptions-item>
              <el-descriptions-item label="需要 Node.js">v18+</el-descriptions-item>
            </el-descriptions>

            <el-card shadow="never">
              <template #header><span>安装后的功能</span></template>
              <el-table :data="[
                { feature: '记忆检索/存储', desc: 'recall_memory, store_memory 等', mode: '远程' },
                { feature: '编码规范', desc: 'get_system_rules, propose_rule', mode: '远程' },
                { feature: '产品线拓扑扫描', desc: 'scan_topology（扫描本地 Git 仓库）', mode: '本地执行' },
                { feature: 'Cursor Rules 同步', desc: '启动时自动从服务端拉取最新规则', mode: '自动' },
              ]" size="small" stripe>
                <el-table-column prop="feature" label="功能" width="160" />
                <el-table-column prop="desc" label="说明" />
                <el-table-column prop="mode" label="执行方式" width="100">
                  <template #default="{ row }">
                    <el-tag size="small" :type="row.mode === '本地执行' ? 'warning' : row.mode === '自动' ? 'success' : ''">{{ row.mode }}</el-tag>
                  </template>
                </el-table-column>
              </el-table>
            </el-card>
          </div>
        </el-tab-pane>


      </el-tabs>
    </el-card>
  </div>
</template>
