// Created by dev on 2026/04/08
import type {
  TopologyNode as ApiNode, TopologyEdge as ApiEdge, TopologyFullData,
  ReleaseOrderResult, ChangeImpactResult, McpClientStatus, UserPathsCoverage,
} from '../../api/client'

export type { ApiNode, ApiEdge, TopologyFullData, ReleaseOrderResult, ChangeImpactResult, McpClientStatus, UserPathsCoverage }

export interface ServiceNode {
  id: string
  name: string
  techStack: string
  layer: string
  description: string
}

export interface ServiceEdge {
  from: string
  to: string
  protocol: string
  fromRepoId?: string
  toRepoId?: string
}

export interface PLConfig {
  name: string
  scanRoots: string[]
  gitPatterns: string[]
  lastScanAt?: string
  repoCount?: number
  edgeCount?: number
  builtin?: boolean
}

export interface InfraDisplay { type: string; display: string; env: string }
export interface InfraGroup { type: string; items: InfraDisplay[] }

export interface LayerData {
  name: string
  services: string[]
}

export const LAYER_COLORS: Record<string, string> = {
  '前端': '#409eff',
  '接口网关': '#67c23a',
  '管理后台RPC': '#e6a23c',
  '微服务': '#f56c6c',
  '支付/充值': '#909399',
  '公共库': '#b37feb',
}

export function getLayerColor(layerName: string): string {
  for (const [key, color] of Object.entries(LAYER_COLORS)) {
    if (layerName.includes(key)) return color
  }
  return '#909399'
}

export function repoShortName(repoId: string): string {
  return repoId.split('/').pop() ?? repoId
}

export function infraTagType(type: string): 'success' | 'warning' | 'danger' | 'info' {
  switch (type) {
    case 'mysql': return 'success'
    case 'redis': return 'danger'
    case 'kafka': return 'warning'
    default: return 'info'
  }
}
