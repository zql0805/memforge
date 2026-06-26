// Created by dev on 2026/06/11

/** 校验 redirect 为站内路径，防止开放重定向 */
export function safeRedirect(path: string | undefined | null, fallback = '/dashboard'): string {
  if (!path || typeof path !== 'string') return fallback
  const trimmed = path.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback
  return trimmed
}
