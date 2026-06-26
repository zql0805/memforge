// Created by dev on 2026/04/05
// Copyright © 2026

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getToken, getUserInfo, getDeviceId, setTokenRefreshCallback, gatewayBaseURL, type UserInfo } from '../api/client'
import { getAccessToken, setTokens, clearTokens } from '../utils/token-storage'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(getAccessToken())
  const user = ref<UserInfo | null>(null)
  const isConnecting = ref(false)
  const loginError = ref<string | null>(null)

  const devicePending = ref(false)
  const deviceRevoked = ref(false)
  const pendingDeviceId = ref<string | null>(null)

  const teamStatus = ref<'active' | 'needs_team_selection' | 'pending_approval'>('active')
  const needsTeamSetup = computed(() => teamStatus.value !== 'active')

  const isAuthenticated = computed(() => !!token.value)
  const userId = computed(() => user.value?.id ?? null)
  const role = computed(() => user.value?.role ?? null)
  const isAdmin = computed(() => user.value?.role === 'admin')
  const isLeadOrAdmin = computed(() => user.value?.role === 'admin' || user.value?.role === 'lead')
  const isSuperAdmin = computed(() => user.value?.is_super_admin === true)

  async function connect(externalId: string, password: string, displayName?: string): Promise<{ isNewUser: boolean; teamStatus: string }> {
    isConnecting.value = true
    loginError.value = null
    devicePending.value = false
    deviceRevoked.value = false
    try {
      const result = await getToken(externalId, password, displayName)
      token.value = result.access_token
      setTokens(result.access_token, result.refresh_token)
      teamStatus.value = (result as Record<string, unknown>).team_status as typeof teamStatus.value ?? 'active'
      await fetchUser()
      return { isNewUser: result.is_new_user ?? false, teamStatus: teamStatus.value }
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number; data?: { error?: string; message?: string; device_id?: string } }; message?: string; code?: string }
      if (axiosErr.response?.status === 403) {
        const errorCode = axiosErr.response?.data?.error
        if (errorCode === 'device_pending_approval') {
          devicePending.value = true
          pendingDeviceId.value = axiosErr.response?.data?.device_id ?? getDeviceId()
          loginError.value = null
          return { isNewUser: false, teamStatus: 'active' }
        }
        if (errorCode === 'device_revoked') {
          deviceRevoked.value = true
          loginError.value = '该设备已被管理员吊销，请联系管理员'
          return { isNewUser: false, teamStatus: 'active' }
        }
      }
      if (axiosErr.response?.status === 429 || axiosErr.response?.status === 423) {
        loginError.value = axiosErr.response.data?.message ?? '请求过于频繁，请稍后重试'
      } else if (axiosErr.response?.status === 401) {
        loginError.value = axiosErr.response.data?.message ?? '密码错误'
      } else if (axiosErr.response) {
        loginError.value = axiosErr.response.data?.message ?? `服务器返回 ${axiosErr.response.status}`
      } else {
        loginError.value = `网络连接失败 [${axiosErr.code ?? 'UNKNOWN'}]: ${axiosErr.message ?? '请检查网络'} (Gateway: ${gatewayBaseURL})`
      }
      throw err
    } finally {
      isConnecting.value = false
    }
  }

  function syncTokenFromStorage(): void {
    const stored = getAccessToken()
    if (stored && stored !== token.value) {
      token.value = stored
    }
  }

  // 拦截器静默刷新 token 时，立即同步到 Vue ref
  setTokenRefreshCallback((newToken: string) => {
    token.value = newToken
  })

  async function tryResumeSession(): Promise<boolean> {
    syncTokenFromStorage()
    if (!token.value) return false
    try {
      user.value = await getUserInfo()
      syncTokenFromStorage()
      if (user.value?.team_status) {
        teamStatus.value = user.value.team_status
      }
      return true
    } catch {
      logout()
      return false
    }
  }

  async function fetchUser(): Promise<void> {
    syncTokenFromStorage()
    if (!token.value) return
    try {
      user.value = await getUserInfo()
      syncTokenFromStorage()
      if (user.value?.team_status) {
        teamStatus.value = user.value.team_status
      }
    } catch {
      logout()
    }
  }

  function updateDisplayName(name: string): void {
    if (user.value) {
      user.value = { ...user.value, display_name: name }
    }
  }

  function logout(): void {
    token.value = null
    user.value = null
    devicePending.value = false
    deviceRevoked.value = false
    pendingDeviceId.value = null
    teamStatus.value = 'active'
    clearTokens()
  }

  function clearDeviceState(): void {
    devicePending.value = false
    deviceRevoked.value = false
    pendingDeviceId.value = null
    loginError.value = null
  }

  return {
    token, user, userId, role, isAdmin, isLeadOrAdmin, isSuperAdmin,
    isAuthenticated, isConnecting, loginError,
    devicePending, deviceRevoked, pendingDeviceId,
    teamStatus, needsTeamSetup,
    connect, tryResumeSession, fetchUser, logout, clearDeviceState, updateDisplayName,
  }
})
