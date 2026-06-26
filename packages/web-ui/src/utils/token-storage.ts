// Created by dev on 2026/06/11
// SECURITY: 后续应迁移到 httpOnly cookie；当前使用 sessionStorage 降低 XSS 持久化风险

const TOKEN_KEY = 'memforge_token'
const REFRESH_KEY = 'memforge_refresh_token'

export function getAccessToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY)
}

export function getRefreshToken(): string | null {
  return sessionStorage.getItem(REFRESH_KEY)
}

export function setTokens(accessToken: string, refreshToken: string): void {
  sessionStorage.setItem(TOKEN_KEY, accessToken)
  sessionStorage.setItem(REFRESH_KEY, refreshToken)
}

export function clearTokens(): void {
  sessionStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(REFRESH_KEY)
}
