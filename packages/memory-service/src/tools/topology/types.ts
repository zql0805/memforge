// Created by dev on 2026/04/06
// Copyright © 2026
// 拓扑扫描引擎 — 共享类型定义

export interface ScannedRepo {
  repoId: string;
  localPath: string;
  lang: string;
  remote: string;
  gitHost: string;
  gitGroup: string;
}

export interface RepoSignals {
  has_api_controllers?: boolean;
  has_inner_controllers?: boolean;
  has_task_controllers?: boolean;
  has_moa_consumers?: boolean;
  provides_moa?: boolean;
  has_spring_web?: boolean;
  has_proto?: boolean;
  has_grpc?: boolean;
  has_http_framework?: boolean;
  has_kafka?: boolean;
  has_mq?: boolean;
  has_ml?: boolean;
  has_celery?: boolean;
  has_firebase?: boolean;
  has_feign?: boolean;
  has_http_clients?: boolean;
  is_laravel?: boolean;
  web_framework?: string;
  has_php_service_calls?: boolean;
  has_inner_http_calls?: boolean;
  has_goback_callback?: boolean;
  has_redis_mq?: boolean;
  has_micro_frontend?: boolean;
  micro_frontend_framework?: string;
  [key: string]: unknown;
}

export interface DetectedEdge {
  from: string;
  to: string;
  label: string;
  confidence: number;
  evidence: string;
  autoDetected: boolean;
}

export interface DetectedDep {
  type: 'moa_consumer' | 'moa_provider' | 'maven' | 'go_module' | 'composer' | 'npm' | 'proxy' | 'env_api' | 'httpApi' | 'php_service' | 'inner_http' | 'http_callback' | 'redis_mq' | 'kafka_producer' | 'kafka_consumer' | 'micro_frontend';
  serviceUri?: string;
  groupId?: string;
  artifactId?: string;
  module?: string;
  domain?: string;
  /** PHP 框架内部 /service/... 路径（如 org/team/service） */
  servicePath?: string;
  /** Redis pub/sub 或 MQ topic 名称 */
  topic?: string;
  targetRepoId?: string;
  /** MOA 提供方方法名（如 getFirstChargeLevelInfo） */
  methodName?: string;
  /** MOA consumer 注入字段名（如 chargeLevelService），用于 Codegraph 查询 */
  consumerFieldName?: string;
  /** HTTP 端点路径（如 /api/live/room/full） */
  httpPath?: string;
  /** Java appKey（从 app.yaml 读取） */
  appKey?: string;
  source: string;
  confidence: number;
}

export const DEFAULT_GROUPS: Record<string, { label: string; color: string; layer: number }> = {
  'client':        { label: 'App客户端',    color: '#E94560', layer: 0 },
  'frontend':      { label: '前端',         color: '#7B68EE', layer: 0 },
  'admin-fe':      { label: '管理后台前端', color: '#9B59B6', layer: 0 },
  'api-gateway':   { label: '接口网关',     color: '#4A90D9', layer: 1 },
  'web-interface': { label: 'Web接口层',    color: '#3498DB', layer: 1 },
  'admin-web':     { label: '管理后台Web',  color: '#5B9BD5', layer: 2 },
  'admin-rpc':     { label: '管理后台RPC',  color: '#E87040', layer: 3 },
  'microservice':  { label: '微服务',       color: '#27AE60', layer: 4 },
  'payment':       { label: '支付/充值',    color: '#E74C3C', layer: 5 },
  'common':        { label: '公共库/协议',  color: '#95A5A6', layer: 6 },
  'infra':         { label: '基础设施',     color: '#16A085', layer: 6 },
  'tool':          { label: '工具',         color: '#708090', layer: 7 },
  'uncategorized': { label: '待归类',       color: '#F39C12', layer: 8 },
};

export interface InfraItem {
  type: 'mysql' | 'redis' | 'kafka' | 'momostore';
  cluster?: string;
  host?: string;
  port?: string;
  database?: string;
  env: string;
  source: string;
}

export interface RegistryRepo {
  desc: string;
  lang: string;
  layer: number;
  group: string;
  localPath: string;
  remote?: string;
  gitHost?: string;
  gitGroup?: string;
  dependencies?: DetectedDep[];
  signals?: Partial<RepoSignals>;
  infra?: InfraItem[];
  serverPort?: string;
  appKey?: string;
  /** 仓库关联的所有 appKey（PHP 多 appKey 场景：Nginx 按 URL 前缀分发不同 appKey） */
  appKeys?: string[];
}

export interface RegistryData {
  productLine: string;
  rootDir: string;
  gitHost: string;
  generatedAt: string;
  generatedBy: string;
  repos: Record<string, RegistryRepo>;
  edges: DetectedEdge[];
  groups: Record<string, { label: string; layer: number }>;
  interfaces?: DetectedInterface[];
  moaRegistry?: MoaRegistryEntry[];
}

export interface DetectedInterface {
  type: 'moa' | 'http';
  fromRepoId: string;
  toRepoId: string;
  interfaceUrl: string;
  methodName?: string;
  sourceFile?: string;
  providerFile?: string;
  confidence: number;
}

export interface RegistryInterfaceRecord extends DetectedInterface {
  traffic1dAvg: number;
  traffic1dPeak: number;
}

export interface MoaRegistryEntry {
  serviceUri: string;
  repoId: string;
  providerFile?: string;
  confidence: number;
}

export interface ScanResult {
  registry: RegistryData;
  filePath: string;
  repoCount: number;
  edgeCount: number;
}
