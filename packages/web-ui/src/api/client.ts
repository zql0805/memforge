// Created by dev on 2026/04/05
// Copyright © 2026
// API 客户端 — 与 Gateway REST API 通信

import axios, { type AxiosInstance, type AxiosError } from 'axios'
import { ElMessage } from 'element-plus'
import { getAccessToken, getRefreshToken, setTokens, clearTokens } from '../utils/token-storage'

function resolveBaseURL(): string {
  if (import.meta.env.VITE_API_BASE_URL) return import.meta.env.VITE_API_BASE_URL
  const { protocol, hostname, port } = window.location
  // 本地开发时使用相对路径，由 Vite proxy 转发到远程服务器
  if (import.meta.env.DEV) return ''
  return port ? `${protocol}//${hostname}:${port}` : `${protocol}//${hostname}`
}

const baseURL = resolveBaseURL()
export { baseURL as gatewayBaseURL }

function generateUUID(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}

function getDeviceId(): string {
  let id = localStorage.getItem('memforge_device_id')
  if (!id) {
    id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : generateUUID()
    localStorage.setItem('memforge_device_id', id)
  }
  return id
}

function mapHttpErrorMessage(status: number | undefined, data: unknown): string {
  if (status === 401) return '请重新登录'
  if (status === 403) return '权限不足'
  if (status === 500) return '服务异常，请稍后重试'
  if (data && typeof data === 'object') {
    const payload = data as Record<string, unknown>
    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message
    }
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error
    }
  }
  if (status && status >= 500) return '服务异常，请稍后重试'
  if (status === 404) return '请求的资源不存在'
  return '操作失败，请稍后重试'
}

const client: AxiosInstance = axios.create({
  baseURL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

client.interceptors.request.use(config => {
  const token = getAccessToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  config.headers['X-Device-Id'] = getDeviceId()
  return config
})

let isRefreshing = false
let pendingRequests: Array<{ resolve: (token: string) => void; reject: (err: unknown) => void }> = []
let tokenRefreshCallback: ((token: string) => void) | null = null
let unauthorizedCallback: (() => void) | null = null

/** 401 且 refresh 失败时触发，供 App.vue 弹出登录框 */
export function setUnauthorizedCallback(cb: () => void): void {
  unauthorizedCallback = cb
}

/** 注册 token 刷新成功回调，供 auth store 同步 Vue ref */
export function setTokenRefreshCallback(cb: (token: string) => void): void {
  tokenRefreshCallback = cb
}

function handleUnauthorized(): void {
  clearTokens()
  ElMessage.warning('登录已过期，请重新登录')
  if (unauthorizedCallback) {
    unauthorizedCallback()
  } else if (window.location.pathname !== '/dashboard') {
    window.location.href = '/dashboard'
  }
}

async function tryRefreshToken(): Promise<string | null> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return null
  try {
    const { data } = await axios.post(`${baseURL}/oauth/token`, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'memforge-web',
    })
    setTokens(data.access_token, data.refresh_token)
    tokenRefreshCallback?.(data.access_token as string)
    return data.access_token as string
  } catch (err) {
    console.error('Token refresh 失败:', err)
    clearTokens()
    return null
  }
}

client.interceptors.response.use(
  response => response,
  async (error: AxiosError) => {
    const originalRequest = error.config
    if (error.response?.status === 401 && originalRequest && !(originalRequest as unknown as Record<string, unknown>)._retry) {
      (originalRequest as unknown as Record<string, unknown>)._retry = true

      if (!isRefreshing) {
        isRefreshing = true
        const newToken = await tryRefreshToken()
        isRefreshing = false

        if (newToken) {
          pendingRequests.forEach(p => p.resolve(newToken))
          pendingRequests = []
          originalRequest.headers.Authorization = `Bearer ${newToken}`
          return client(originalRequest)
        } else {
          pendingRequests.forEach(p => p.reject(error))
          pendingRequests = []
          handleUnauthorized()
          return Promise.reject(error)
        }
      }

      return new Promise((resolve, reject) => {
        pendingRequests.push({
          resolve: (token: string) => {
            originalRequest.headers.Authorization = `Bearer ${token}`
            resolve(client(originalRequest))
          },
          reject,
        })
      })
    } else if (error.response?.status === 403) {
      const data = error.response?.data as Record<string, unknown> | undefined
      const errCode = data?.error as string | undefined
      if (errCode === 'device_pending_approval' || errCode === 'device_revoked') {
        // 设备相关错误由 auth store 处理，不显示通用提示
      } else {
        ElMessage.error(mapHttpErrorMessage(403, data))
      }
    } else if (error.response?.status === 429) {
      ElMessage.warning('请求过于频繁，请稍后重试')
    } else if (error.response) {
      ElMessage.error(mapHttpErrorMessage(error.response.status, error.response.data))
    } else if (error.code === 'ECONNABORTED') {
      ElMessage.error('请求超时，请稍后重试')
    } else {
      ElMessage.error('网络异常，请检查连接后重试')
    }
    return Promise.reject(error)
  },
)

export default client

// ─── API 方法 ────────────────────────

export interface MemoryEntry {
  id: string
  title: string
  content: string
  scope: string
  source: string
  tags: string[]
  projectId?: string
  metadata: Record<string, unknown>
  isArchived: boolean
  visibility?: 'personal' | 'team' | 'product_line' | 'global'
  createdAt: string
  updatedAt: string
}

export interface Rule {
  id: string
  title: string
  description: string
  ruleType: string
  category: string
  language: string | null
  severity: string
  status: string
  appliedCount: number
  violatedCount: number
  createdAt: string
}

export interface AuditLog {
  id: number
  action: string
  resource_type: string
  details: Record<string, unknown>
  user_id: string | null
  ip_address: string | null
  created_at: string
}

export interface ProductLineAccess {
  productLine: string
  accessLevel: 'read' | 'write' | 'manage'
  grantedBy: string | null
  createdAt: string
}

export interface UserInfo {
  id: string
  org_id: string
  email: string | null
  display_name: string | null
  role: string
  is_super_admin: boolean
  product_lines: ProductLineAccess[]
  primary_team: { id: string; name: string; slug: string } | null
  team_status: 'active' | 'needs_team_selection' | 'pending_approval'
  accessible_tools: Array<{ tool: string; permission: string; auto_approve: boolean }>
}

export interface UserListItem {
  id: string
  orgId: string
  externalId: string
  email: string | null
  displayName: string | null
  role: string
  isSuperAdmin: boolean
  productLines: ProductLineAccess[]
}

export interface ProductLineMember {
  userId: string
  displayName: string | null
  email: string | null
  role: string
  accessLevel: 'read' | 'write' | 'manage'
}

export interface McpCallOptions {
  /** 毫秒；拓扑全量扫描等长任务需单独加长，默认 30000 */
  timeout?: number
}

/** MCP JSON-RPC 调用封装 */
export async function mcpCall<T>(
  method: string,
  params?: Record<string, unknown>,
  options?: McpCallOptions,
): Promise<T> {
  const response = await client.post(
    '/mcp/legacy',
    {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    },
    { timeout: options?.timeout ?? 30000 },
  )
  if (response.data.error) {
    throw new Error(response.data.error.message ?? 'MCP 调用失败')
  }
  return response.data.result as T
}

export async function getUserInfo(): Promise<UserInfo> {
  const { data } = await client.get('/api/userinfo')
  return data
}

export async function getAuditLogs(page = 1, pageSize = 50): Promise<{ logs: AuditLog[]; page: number; page_size: number }> {
  const { data } = await client.get('/api/audit-logs', { params: { page, page_size: pageSize } })
  return data
}

export async function getToken(
  externalId: string,
  password: string,
  displayName?: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number; is_new_user?: boolean }> {
  const { data } = await client.post('/oauth/token', {
    grant_type: 'client_credentials',
    client_id: 'memforge-web',
    external_id: externalId,
    password,
    display_name: displayName,
    device_id: getDeviceId(),
    device_name: parseLocalDeviceName(),
    device_type: 'web',
  })
  return data
}

function parseLocalDeviceName(): string {
  const ua = navigator.userAgent
  if (ua.includes('Chrome') && !ua.includes('Edg')) return 'Chrome 浏览器'
  if (ua.includes('Edg')) return 'Edge 浏览器'
  if (ua.includes('Firefox')) return 'Firefox 浏览器'
  if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari 浏览器'
  return '浏览器'
}

export { getDeviceId }

// ─── Topology REST API ────────────────────────

export interface TopologyNode {
  id: string
  productLine: string
  repoId: string
  displayName: string
  techStack: string | null
  layerName: string | null
  layerIndex: number
  description: string
  localPath: string | null
  gitRemoteUrl: string | null
  gitHost: string | null
  gitGroup: string | null
  dependencies: unknown[]
  signals: Record<string, unknown>
  scannedBy: string | null
  lastScannedAt: string | null
  isManual: boolean
  isHidden: boolean
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface TopologyEdge {
  id: string
  productLine: string
  fromRepoId: string
  toRepoId: string
  protocol: string
  sourceFile: string | null
  confidence: number
  isManual: boolean
  isHidden: boolean
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface TopologyLayer {
  id: string
  productLine: string
  layerIndex: number
  name: string
  color: string
  isCustom: boolean
}

export interface TopologyFullData {
  productLine: string
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  layers: TopologyLayer[]
}

export async function getTopology(productLine: string): Promise<TopologyFullData> {
  const { data } = await client.get(`/api/topology/${productLine}`)
  return data
}

export async function getTopologyProductLines(): Promise<string[]> {
  const { data } = await client.get('/api/topology/product-lines')
  return data.productLines
}

export async function updateTopologyNode(
  productLine: string,
  repoId: string,
  updates: Partial<{
    displayName: string
    layerIndex: number
    layerName: string
    description: string
    isHidden: boolean
  }>,
): Promise<TopologyNode> {
  const { data } = await client.put(`/api/topology/${productLine}/nodes/${repoId}`, updates)
  return data
}

export async function addTopologyNode(
  productLine: string,
  node: { repoId: string; displayName: string; techStack?: string; layerIndex?: number; layerName?: string; description?: string; localPath?: string },
): Promise<TopologyNode> {
  const { data } = await client.post(`/api/topology/${productLine}/nodes`, node)
  return data
}

export async function addTopologyEdge(
  productLine: string,
  edge: { fromRepoId: string; toRepoId: string; protocol: string },
): Promise<TopologyEdge> {
  const { data } = await client.post(`/api/topology/${productLine}/edges`, edge)
  return data
}

export async function removeTopologyEdge(productLine: string, edgeId: string): Promise<void> {
  await client.delete(`/api/topology/${productLine}/edges/${edgeId}`)
}

export async function moveTopologyNodes(
  sourceProductLine: string,
  targetProductLine: string,
  repoIds: string[],
): Promise<{ nodesMoved: number; edgesMoved: number }> {
  const { data } = await client.post(`/api/topology/${sourceProductLine}/move-nodes`, {
    target_product_line: targetProductLine,
    repo_ids: repoIds,
  })
  return data
}

export async function copyTopologyNodes(
  sourceProductLine: string,
  targetProductLine: string,
  repoIds: string[],
): Promise<{ nodesCopied: number; edgesCopied: number }> {
  const { data } = await client.post(`/api/topology/${sourceProductLine}/copy-nodes`, {
    target_product_line: targetProductLine,
    repo_ids: repoIds,
  })
  return data
}

export interface ReleaseOrderResult {
  batches: Array<{ batch: number; repos: string[] }>
  cycles: string[]
}

export async function getTopologyReleaseOrder(productLine: string): Promise<ReleaseOrderResult> {
  const { data } = await client.get(`/api/topology/${productLine}/release-order`)
  return data
}

export interface ChangeImpactResult {
  directCallers: string[]
  indirectCallers: string[]
}

export async function getTopologyChangeImpact(productLine: string, repoId: string): Promise<ChangeImpactResult> {
  const { data } = await client.get(`/api/topology/${productLine}/impact/${repoId}`)
  return data
}

export interface UserPathsCoverage {
  userId: string
  displayName: string
  repoCount: number
  updatedAt: string
}

export async function getTopologyUserPaths(productLine: string): Promise<UserPathsCoverage[]> {
  const { data } = await client.get(`/api/topology/${productLine}/user-paths`)
  return data.coverage ?? []
}

// ─── 调用关系图 API ────────────────────────

export interface CallGraphNode {
  id: string
  name: string
  layer: string
  techStack: string
  appKey: string | null
  gitUrl: string | null
  description: string | null
}

export interface CallGraphEdge {
  id: string
  source: string
  target: string
  protocol: string
  traffic1dAvg: number
  interfaceCount: number
}

export interface InterfaceDetail {
  url: string
  methodName: string | null
  protocol: string
  traffic1dAvg: number
  traffic1dPeak: number
}

export interface CallGraphResponse {
  nodes: CallGraphNode[]
  edges: CallGraphEdge[]
  lastTrafficUpdate: string | null
}

export async function getCallGraph(productLine: string): Promise<CallGraphResponse> {
  const { data } = await client.get(`/api/topology/${productLine}/call-graph`)
  return data
}

export async function getEdgeInterfaces(
  productLine: string, from: string, to: string,
): Promise<{ interfaces: InterfaceDetail[] }> {
  const { data } = await client.get(`/api/topology/${productLine}/call-graph/interfaces`, {
    params: { from, to },
  })
  return data
}

export async function searchCallGraph(
  productLine: string,
  query: string,
  type: 'url' | 'node' | 'appkey' = 'url',
): Promise<CallGraphResponse> {
  const { data } = await client.get(`/api/topology/${productLine}/call-graph/search`, {
    params: { q: query, type },
  })
  return data
}

export async function refreshCallGraphTraffic(productLine: string): Promise<{ updated: number }> {
  const { data } = await client.post(`/api/topology/${productLine}/call-graph/refresh-traffic`)
  return data
}

// ─── 用户管理 API ────────────────────────

export async function listUsers(): Promise<UserListItem[]> {
  const { data } = await client.get('/api/users')
  return data.users
}

export async function updateUserRole(userId: string, role: string): Promise<void> {
  await client.put(`/api/users/${userId}/role`, { role })
}

export async function deactivateUser(userId: string): Promise<void> {
  await client.delete(`/api/users/${userId}`)
}

export async function getUserProductLines(userId: string): Promise<ProductLineAccess[]> {
  const { data } = await client.get(`/api/users/${userId}/product-lines`)
  return data.productLines
}

export async function grantProductLineAccess(
  userId: string,
  productLine: string,
  accessLevel: 'read' | 'write' | 'manage',
): Promise<void> {
  await client.post(`/api/users/${userId}/product-lines`, {
    product_line: productLine,
    access_level: accessLevel,
  })
}

export async function revokeProductLineAccess(userId: string, productLine: string): Promise<void> {
  await client.delete(`/api/users/${userId}/product-lines/${productLine}`)
}

export async function updateMyProfile(displayName: string): Promise<{ display_name: string }> {
  const { data } = await client.put('/api/users/me/profile', { display_name: displayName })
  return data
}

export async function changeMyPassword(oldPassword: string, newPassword: string): Promise<void> {
  await client.put('/api/users/me/password', { old_password: oldPassword, new_password: newPassword })
}

export async function resetUserPassword(userId: string, newPassword: string): Promise<void> {
  await client.put(`/api/users/${userId}/reset-password`, { new_password: newPassword })
}

export async function unlockUser(userId: string): Promise<{ was_locked: boolean; message: string }> {
  const { data } = await client.delete(`/api/users/${userId}/lock`)
  return data
}

// ─── 产品线 API ────────────────────────

export async function getMyProductLines(): Promise<ProductLineAccess[]> {
  const { data } = await client.get('/api/product-lines')
  return data.productLines
}

export async function getProductLineMembers(productLine: string): Promise<ProductLineMember[]> {
  const { data } = await client.get(`/api/product-lines/${productLine}/members`)
  return data.members
}

/** 查询记忆库中实际存在的 project_id 列表（排除 _global_ / default） */
export async function getDistinctProjectIds(): Promise<string[]> {
  const { data } = await client.get('/api/memories/distinct-projects')
  return data.projectIds as string[]
}

// ─── API Key 管理 ─────────────────────────────

export interface ApiKeyRecord {
  id: string
  userId: string
  name: string
  keyPrefix: string
  lastUsedAt: string | null
  expiresAt: string | null
  isActive: boolean
  createdAt: string
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const { data } = await client.get('/api/api-keys')
  return data.keys
}

export async function createApiKey(name: string, expiresInDays?: number): Promise<{
  key: string
  record: ApiKeyRecord
  message: string
}> {
  const { data } = await client.post('/api/api-keys', { name, expires_in_days: expiresInDays })
  return data
}

export async function revokeApiKey(keyId: string): Promise<void> {
  await client.delete(`/api/api-keys/${keyId}`)
}

// ─── MCP 客户端在线状态 + 远程扫描 API ────────

export interface McpClientStatus {
  userId: string
  connectedAt: string
  machineInfo: { hostname?: string; platform?: string; cwd?: string }
  scanning: boolean
  scanProgress: { phase: string; detail?: string; percent?: number } | null
}

export async function getMcpClients(): Promise<McpClientStatus[]> {
  const { data } = await client.get('/api/mcp-clients')
  return data.clients
}

export async function triggerRemoteScan(params: {
  product_line: string
  user_id?: string
  scan_roots?: string[]
  git_patterns?: string[]
  force?: boolean
}): Promise<{ success: boolean; data?: unknown }> {
  const { data } = await client.post('/api/topology/scan-remote', params, { timeout: 15 * 60 * 1000 })
  return data
}

/**
 * 创建扫描进度 SSE 连接
 * @returns EventSource 实例，调用方需监听 message 事件和手动关闭
 */
export async function subscribeScanProgress(userId: string): Promise<EventSource> {
  const { data } = await client.post<{ ticket: string }>('/api/sse-ticket')
  const url = `${baseURL}/api/topology/scan-progress/${userId}?ticket=${encodeURIComponent(data.ticket)}`
  return new EventSource(url)
}

// ─── 设备管理 API ─────────────────────────────

export interface TrustedDevice {
  id: string
  userId: string
  deviceId: string
  deviceName: string | null
  deviceType: string
  userAgent: string | null
  lastIp: string | null
  status: 'pending' | 'approved' | 'revoked'
  approvedBy: string | null
  approvedAt: string | null
  lastSeenAt: string | null
  createdAt: string
  displayName?: string | null
  externalId?: string
  userRole?: string
}

export async function getDeviceVerificationStatus(): Promise<{ enabled: boolean }> {
  const { data } = await client.get('/api/devices/status')
  return data
}

export async function listDevices(status?: string): Promise<{ devices: TrustedDevice[]; pending_count: number }> {
  const params = status ? { status } : {}
  const { data } = await client.get('/api/devices', { params })
  return data
}

export async function listPendingDevices(): Promise<{ devices: TrustedDevice[] }> {
  const { data } = await client.get('/api/devices/pending')
  return data
}

export async function getPendingDeviceCount(): Promise<number> {
  const { data } = await client.get('/api/devices/pending-count')
  return data.count
}

export async function approveDevice(id: string): Promise<void> {
  await client.put(`/api/devices/${id}/approve`)
}

export async function revokeDevice(id: string): Promise<void> {
  await client.put(`/api/devices/${id}/revoke`)
}

export async function removeDevice(id: string): Promise<void> {
  await client.delete(`/api/devices/${id}`)
}

export async function getMyDevices(): Promise<TrustedDevice[]> {
  const { data } = await client.get('/api/devices/my')
  return data.devices
}

// ═══════════════════════════════════════════════
//  团队管理 API
// ═══════════════════════════════════════════════

export interface TeamInfo {
  id: string
  name: string
  slug: string
  description: string | null
  created_at: string
  member_count: number
}

export interface TeamMember {
  user_id: string
  role: string
  is_primary: boolean
  joined_at: string
  external_id: string
  display_name: string | null
  email: string | null
}

export async function listTeams(): Promise<TeamInfo[]> {
  const { data } = await client.get('/api/teams')
  return data
}

export async function createTeam(name: string, slug: string, description?: string): Promise<TeamInfo> {
  const { data } = await client.post('/api/teams', { name, slug, description })
  return data
}

export async function updateTeam(teamId: string, name: string, description?: string): Promise<TeamInfo> {
  const { data } = await client.put(`/api/teams/${teamId}`, { name, description })
  return data
}

export async function getTeamMembers(teamId: string): Promise<TeamMember[]> {
  const { data } = await client.get(`/api/teams/${teamId}/members`)
  return data
}

export async function addTeamMember(teamId: string, userId: string, role?: string, isPrimary?: boolean): Promise<void> {
  await client.post(`/api/teams/${teamId}/members`, { userId, role, isPrimary })
}

export async function removeTeamMember(teamId: string, userId: string): Promise<void> {
  await client.delete(`/api/teams/${teamId}/members/${userId}`)
}

export async function updateMemoryVisibility(entryId: string, visibility: string): Promise<void> {
  await client.put(`/api/memories/${entryId}/visibility`, { visibility })
}

// ═══════════════════════════════════════════════
//  团队加入申请 API
// ═══════════════════════════════════════════════

export interface JoinRequest {
  id: string
  team_id: string
  user_id: string
  status: 'pending' | 'approved' | 'rejected'
  message: string | null
  created_at: string
  reviewed_at: string | null
  external_id?: string
  display_name?: string | null
  email?: string | null
  team_name?: string
  team_slug?: string
}

export async function submitJoinRequest(teamId: string, message?: string): Promise<JoinRequest> {
  const { data } = await client.post(`/api/teams/${teamId}/join-requests`, { message })
  return data
}

export async function getTeamJoinRequests(teamId: string, status?: string): Promise<JoinRequest[]> {
  const params = status ? { status } : {}
  const { data } = await client.get(`/api/teams/${teamId}/join-requests`, { params })
  return data
}

export async function approveJoinRequest(requestId: string): Promise<void> {
  await client.put(`/api/teams/join-requests/${requestId}/approve`)
}

export async function rejectJoinRequest(requestId: string): Promise<void> {
  await client.put(`/api/teams/join-requests/${requestId}/reject`)
}

export async function getMyJoinRequests(): Promise<JoinRequest[]> {
  const { data } = await client.get('/api/teams/my-requests')
  return data
}

// ═══════════════════════════════════════════════
//  团队-产品线关联 API
// ═══════════════════════════════════════════════

export interface TeamProductLine {
  id: string
  product_line: string
  access_level: 'read' | 'write' | 'manage'
  created_at: string
}

export async function getTeamProductLines(teamId: string): Promise<TeamProductLine[]> {
  const { data } = await client.get(`/api/teams/${teamId}/product-lines`)
  return data
}

export async function addTeamProductLine(
  teamId: string,
  productLine: string,
  accessLevel: 'read' | 'write' | 'manage' = 'read',
): Promise<TeamProductLine> {
  const { data } = await client.post(`/api/teams/${teamId}/product-lines`, {
    product_line: productLine,
    access_level: accessLevel,
  })
  return data
}

export async function updateTeamProductLineAccess(
  teamId: string,
  productLine: string,
  accessLevel: 'read' | 'write' | 'manage',
): Promise<void> {
  await client.put(`/api/teams/${teamId}/product-lines/${productLine}`, {
    access_level: accessLevel,
  })
}

export async function removeTeamProductLine(teamId: string, productLine: string): Promise<void> {
  await client.delete(`/api/teams/${teamId}/product-lines/${productLine}`)
}

export async function listAllProductLines(): Promise<string[]> {
  const { data } = await client.get('/api/product-lines', { params: { all: 'true' } })
  return data.productLines
}

// ═══════════════════════════════════════════════
//  Git 历史知识引擎 API
// ═══════════════════════════════════════════════

export interface ProjectGitStatsApi {
  productLine: string
  repoId: string
  latestLocalHash: string | null
  latestRemoteHash: string | null
  localBehindCount: number
  defaultBranch: string
  commitsLast7d: number
  commitsLast30d: number
  activeContributors7d: number
  activeContributors30d: number
  hotFiles30d: Array<{ file: string; count: number; lastModified: string }>
  firstCommitAt: string | null
  lastCommitAt: string | null
  totalCommits: number
  topContributors: Array<{ name: string; commits: number; lastActive: string }>
  lastFetchedAt: string | null
  lastAnalyzedAt: string | null
}

export interface ProjectProfile {
  repoId: string
  productLine: string
  displayName: string
  techStack: string
  description: string
  totalCommits?: number
  firstCommitAt?: string
  lastCommitAt?: string
  commitsLast7d?: number
  commitsLast30d?: number
  activeContributors7d?: number
  activeContributors30d?: number
  topContributors?: Array<{ name: string; commits: number; lastActive: string }>
  hotFiles30d?: Array<{ file: string; count: number; lastModified: string }>
  defaultBranch?: string
  localBehindCount?: number
  bootstrapProfile?: Record<string, unknown>
}

export interface TimelineEvent {
  id: string
  title: string
  content: string
  scope: string
  category: string
  date: string
  author: string
  commitHash: string
  tags: string[]
}

export interface ChangelogEntry {
  id: string
  title: string
  content: string
  scope: string
  source: string
  date: string
  author: string
  commitHash: string
  category: string
  filesChanged: number
  insertions: number
  deletions: number
}

export interface HealthAlert {
  type: 'stale' | 'hot' | 'single_maintainer'
  severity: 'critical' | 'warning' | 'info'
  repoId: string
  message: string
  detail: string
}

export async function getProjectProfile(pl: string, repoId: string): Promise<ProjectProfile> {
  const { data } = await client.get(`/api/topology/${pl}/nodes/${encodeURIComponent(repoId)}/profile`)
  return data.profile
}

export async function getProjectTimeline(pl: string, repoId: string, limit = 20): Promise<TimelineEvent[]> {
  const { data } = await client.get(`/api/topology/${pl}/nodes/${encodeURIComponent(repoId)}/timeline`, { params: { limit } })
  return data.timeline
}

export async function getProjectChangelog(pl: string, repoId: string, limit = 30): Promise<ChangelogEntry[]> {
  const { data } = await client.get(`/api/topology/${pl}/nodes/${encodeURIComponent(repoId)}/changelog`, { params: { limit } })
  return data.changelog
}

export async function getProductLineGitStats(pl: string): Promise<ProjectGitStatsApi[]> {
  const { data } = await client.get(`/api/topology/${pl}/git-stats`)
  return data.stats
}

export async function getProductLineHealthAlerts(pl: string): Promise<HealthAlert[]> {
  const { data } = await client.get(`/api/topology/${pl}/health-alerts`)
  return data.alerts
}

// ── 产品线设置 ──

export interface ProductLineSettings {
  git_token?: string
  has_git_token?: boolean
  [key: string]: unknown
}

export async function getProductLineSettings(pl: string): Promise<ProductLineSettings> {
  const { data } = await client.get(`/api/topology/${pl}/settings`)
  return data.settings ?? {}
}

export async function updateProductLineSettings(pl: string, updates: Record<string, unknown>): Promise<void> {
  await client.put(`/api/topology/${pl}/settings`, updates)
}

// ── Git 历史导入 ──

export interface BootstrapStatus {
  lastRunAt: string | null
  status: string | null
  runCount: number
  totalCommits: number
  processedCommits: number
  storedMemories: number
  progressPercent: number
}

export async function getBootstrapStatus(pl: string, repoId: string): Promise<BootstrapStatus | null> {
  const { data } = await client.get(`/api/topology/${pl}/nodes/${encodeURIComponent(repoId)}/bootstrap-status`)
  return data.status
}

export async function triggerBootstrap(
  pl: string, repoId: string, projectRoot: string, depth: string = '6months',
): Promise<{ message: string }> {
  const { data } = await client.post(`/api/topology/${pl}/nodes/${encodeURIComponent(repoId)}/bootstrap`, {
    project_root: projectRoot, depth,
  })
  return data
}


// ── Knowledge Base ──

export interface KBSearchResult {
  id: string
  title: string
  question?: string
  content: string
  summary?: string | null
  category: string | null
  tags: string[]
  answerType: string
  confidence: number
  helpfulRatio: number
  verified: boolean
  media: Array<{ type: string; url: string; visible_text?: string; description?: string }>
}

export interface KBSearchResponse {
  results: KBSearchResult[]
  autoReplySuggested: boolean
  total: number
}

export interface KnowledgeItem {
  id: string
  projectId: string
  productLine: string | null
  knowledgeType: string
  category: string | null
  title: string
  question?: string | null
  content: string
  summary?: string | null
  metadata?: Record<string, unknown>
  tags: string[]
  answerType: string
  status: string
  version: number
  verifiedBy: string | null
  verifiedAt: string | null
  helpfulCount: number
  unhelpfulCount: number
  queryCount: number
  media: Array<{ type: string; url: string; visible_text?: string; description?: string }>
  sourceType: string | null
  sourceRef: string | null
  visibility: string
  createdBy: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

export interface KnowledgeCategory {
  id: string
  name: string
  slug: string
  parentId?: string | null
  description?: string | null
  productLine?: string | null
  icon?: string | null
  sortOrder?: number
  children?: KnowledgeCategory[]
}

export async function searchKnowledge(query: string, opts?: {
  productLine?: string
  knowledgeType?: string
  category?: string
  limit?: number
  minConfidence?: number
}): Promise<KBSearchResponse> {
  const { data } = await client.post('/api/knowledge/search', {
    query,
    product_line: opts?.productLine,
    knowledge_type: opts?.knowledgeType,
    category: opts?.category,
    limit: opts?.limit ?? 5,
    min_confidence: opts?.minConfidence ?? 0.3,
  })
  return data
}

export async function storeKnowledge(input: {
  projectId: string
  productLine?: string
  knowledgeType?: string
  category?: string
  title: string
  question?: string
  content: string
  summary?: string
  metadata?: Record<string, unknown>
  tags?: string[]
  answerType?: string
  visibility?: string
}): Promise<{ success: boolean; id: string }> {
  const { data } = await client.post('/api/knowledge/store', {
    project_id: input.projectId,
    product_line: input.productLine,
    knowledge_type: input.knowledgeType,
    category: input.category,
    title: input.title,
    question: input.question,
    content: input.content,
    summary: input.summary,
    metadata: input.metadata,
    tags: input.tags,
    answer_type: input.answerType,
    visibility: input.visibility,
  })
  return data
}

export async function getKnowledgeItem(id: string): Promise<KnowledgeItem> {
  const { data } = await client.get(`/api/knowledge/${id}`)
  return data
}

export async function updateKnowledge(id: string, input: {
  title?: string
  content?: string
  summary?: string
  question?: string
  category?: string
  knowledgeType?: string
  tags?: string[]
  metadata?: Record<string, unknown>
  visibility?: string
}): Promise<{ success: boolean; item: KnowledgeItem }> {
  const { data } = await client.put(`/api/knowledge/${id}`, {
    title: input.title,
    content: input.content,
    summary: input.summary,
    question: input.question,
    category: input.category,
    knowledge_type: input.knowledgeType,
    tags: input.tags,
    metadata: input.metadata,
    visibility: input.visibility,
  })
  return data
}

export async function publishKnowledge(id: string): Promise<{ success: boolean }> {
  const { data } = await client.post(`/api/knowledge/${id}/publish`)
  return data
}

export async function archiveKnowledge(id: string): Promise<{ success: boolean }> {
  const { data } = await client.post(`/api/knowledge/${id}/archive`)
  return data
}

export async function deleteKnowledge(id: string): Promise<{ success: boolean }> {
  const { data } = await client.delete(`/api/knowledge/${id}`)
  return data
}

export async function submitKnowledgeFeedback(knowledgeId: string, helpful: boolean, comment?: string): Promise<void> {
  await client.post('/api/knowledge/feedback', {
    knowledge_id: knowledgeId,
    helpful,
    comment,
  })
}

export async function getKnowledgeCategories(productLine?: string): Promise<Array<{ category: string; count: number }>> {
  const params = productLine ? `?product_line=${productLine}` : ''
  const { data } = await client.get(`/api/knowledge/categories${params}`)
  return data.categories
}

export async function listManagedCategories(productLine?: string): Promise<KnowledgeCategory[]> {
  const params = productLine ? `?product_line=${productLine}` : ''
  const { data } = await client.get(`/api/knowledge/categories${params}`)
  return data.categories ?? data
}

export async function createCategory(input: {
  name: string
  slug: string
  parentId?: string
  description?: string
  productLine?: string
  icon?: string
  sortOrder?: number
}): Promise<{ id: string }> {
  const { data } = await client.post('/api/knowledge/categories', {
    name: input.name,
    slug: input.slug,
    parent_id: input.parentId,
    description: input.description,
    product_line: input.productLine,
    icon: input.icon,
    sort_order: input.sortOrder,
  })
  return data
}

export async function updateCategory(id: string, input: Partial<{
  name: string
  slug: string
  description: string
  icon: string
  sortOrder: number
}>): Promise<void> {
  await client.put(`/api/knowledge/categories/${id}`, {
    name: input.name,
    slug: input.slug,
    description: input.description,
    icon: input.icon,
    sort_order: input.sortOrder,
  })
}

export async function deleteManagedCategory(id: string): Promise<void> {
  await client.delete(`/api/knowledge/categories/${id}`)
}

export async function getKnowledgeStats(productLine?: string): Promise<Record<string, unknown>> {
  const params = productLine ? `?product_line=${productLine}` : ''
  const { data } = await client.get(`/api/knowledge/stats${params}`)
  return data
}

// ─── Reviews API ───

export interface ReviewRecord {
  id: string
  repo_id: string
  commit_hash: string
  branch: string
  author: string
  classification: string
  summary: string
  findings: Array<{
    severity: string
    category: string
    file: string
    line?: number
    description: string
    suggestion: string
    source: string
  }>
  llm_skipped: boolean
  notified: boolean
  reviewed_at: string
  created_at: string
  review_type?: 'commit' | 'merge_request'
  mr_iid?: number
  mr_url?: string
}

export interface ReviewStats {
  total: number
  byClassification: Record<string, number>
  findings: { total_findings: number; p0: number; p1: number; p2: number }
  recent: Array<{
    repo_id: string
    commit_hash: string
    classification: string
    summary: string
    reviewed_at: string
    review_type?: string
    mr_iid?: number
  }>
  byReviewType?: Record<string, number>
}

export async function getReviews(opts?: {
  repoId?: string
  reviewType?: string
  limit?: number
  offset?: number
}): Promise<{ reviews: ReviewRecord[]; total: number }> {
  const params = new URLSearchParams()
  if (opts?.repoId) params.set('repo_id', opts.repoId)
  if (opts?.reviewType) params.set('review_type', opts.reviewType)
  if (opts?.limit) params.set('limit', String(opts.limit))
  if (opts?.offset) params.set('offset', String(opts.offset))
  const qs = params.toString()
  const { data } = await client.get(`/api/reviews${qs ? '?' + qs : ''}`)
  return data
}

export async function getReviewStats(repoId?: string): Promise<ReviewStats> {
  const qs = repoId ? `?repo_id=${repoId}` : ''
  const { data } = await client.get(`/api/reviews/stats${qs}`)
  return data
}

export async function getReviewByCommit(commitHash: string): Promise<ReviewRecord> {
  const { data } = await client.get(`/api/reviews/${commitHash}`)
  return data
}

// ─── Webhooks API ───

export interface WebhookConfig {
  id: string
  platform: string
  instance_url: string
  project_path: string
  product_line: string | null
  webhook_id: number | null
  is_active: boolean
  events: string[]
  created_by: string | null
  created_at: string
  updated_at: string
}

export async function getWebhooks(productLine?: string): Promise<{ configs: WebhookConfig[]; total: number }> {
  const qs = productLine ? `?product_line=${productLine}` : ''
  const { data } = await client.get(`/api/webhooks${qs}`)
  return data
}

export async function getWebhookStats(): Promise<{ total: number; active: number; byProductLine: Record<string, number> }> {
  const { data } = await client.get('/api/webhooks/stats')
  return data
}

export async function deactivateWebhook(id: string): Promise<void> {
  await client.delete(`/api/webhooks/${id}`)
}

export async function listKnowledge(opts?: {
  productLine?: string
  status?: string
  knowledgeType?: string
  category?: string
  search?: string
  page?: number
  pageSize?: number
}): Promise<{ items: KnowledgeItem[]; total: number }> {
  const params = new URLSearchParams()
  if (opts?.productLine) params.set('product_line', opts.productLine)
  if (opts?.status) params.set('status', opts.status)
  if (opts?.knowledgeType) params.set('knowledge_type', opts.knowledgeType)
  if (opts?.category) params.set('category', opts.category)
  if (opts?.search) params.set('search', opts.search)
  if (opts?.page) params.set('page', String(opts.page))
  if (opts?.pageSize) params.set('page_size', String(opts.pageSize))
  const qs = params.toString()
  const { data } = await client.get(`/api/knowledge/list${qs ? '?' + qs : ''}`)
  return data
}
