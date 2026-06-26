// Created by dev on 2026/04/06
// Copyright © 2026
// 拓扑扫描引擎 — 主编排器
// 编排仓库发现 → 依赖检测 → 自动分类 → 边匹配 → 注册表生成

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
import { discoverRepos } from './repo-discovery.js';
import { detectDeps, DepDetectionResult } from './dep-detection.js';
import { detectInfra } from './infra-detection.js';
import { getIdeConfig, getLogger } from '@memforgeai/shared';
import {
  DEFAULT_GROUPS,
  type ScannedRepo, type DetectedEdge, type RepoSignals,
  type RegistryData, type RegistryRepo, type ScanResult,
  type DetectedInterface, type MoaRegistryEntry,
} from './types.js';
import { buildDetectedInterfaces, collectHttpProviderEndpoints, buildMoaRegistryEntries } from './interface-detection.js';
import { queryTrafficBatch } from './traffic-query.js';

const logger = getLogger('topology:scanner');

export interface ScanOptions {
  productLine: string;
  scanRoots: string[];
  gitPatterns?: string[];
  outputPath?: string;
  /** 域名→repoId 别名映射，用于域名无法自动反查仓库的场景 */
  domainAliases?: Record<string, string>;
  /** 扫描进度回调，用于 proxy WebSocket 实时上报 */
  onProgress?: (phase: string, detail: string, percent: number) => void;
  /** 单仓库模式：只扫描一个仓库，从已有注册表加载 provider 信息 */
  singleRepo?: boolean;
  /** 已有注册表数据（单仓库模式下用于 provider 信息查找） */
  existingRegistry?: RegistryData;
}

// scanTopology 的主实现见文件末尾的 scanTopologyEnhanced

// ─── 自动分类逻辑 ──────────────────────────────────────────

interface Classification {
  group: string;
  layer: number;
}

function classifyRepo(
  repo: ScannedRepo,
  signals: RepoSignals,
  deps: import('./types.js').DetectedDep[],
): Classification {
  const lang = repo.lang;
  const repoName = repo.repoId.toLowerCase();

  // 客户端
  if (lang === 'Flutter' || lang === 'iOS' || lang === 'Android') {
    return { group: 'client', layer: 0 };
  }

  // 前端
  if (lang === 'Vue' || lang === 'React' || lang === 'Angular' || lang === 'Svelte') {
    if (repoName.includes('admin')) return { group: 'admin-fe', layer: 0 };
    return { group: 'frontend', layer: 0 };
  }

  // PHP 项目分类
  if (lang === 'PHP') {
    if (signals.has_api_controllers) return { group: 'api-gateway', layer: 1 };
    if (repoName.includes('admin')) return { group: 'admin-web', layer: 2 };
    if (repoName.includes('activity') || repoName.includes('numerical')) {
      return { group: 'microservice', layer: 4 };
    }
    if (repoName.includes('payment')) return { group: 'payment', layer: 5 };
    return { group: 'web-interface', layer: 1 };
  }

  // Java/Kotlin 项目分类
  if (lang === 'Java' || lang === 'Kotlin') {
    // 支付/充值
    if (repoName.includes('pay') || repoName.includes('recharge') || repoName.includes('wallet')) {
      return { group: 'payment', layer: 5 };
    }
    // 管理后台 RPC
    if (repoName.includes('admin') && signals.provides_moa) {
      return { group: 'admin-rpc', layer: 3 };
    }
    // Web 接口层（有 Spring Web 控制器 + MOA consumer）
    if (signals.has_spring_web && signals.has_moa_consumers) {
      if (repoName.includes('web') || repoName.includes('api')) {
        return { group: 'web-interface', layer: 1 };
      }
    }
    // 公共库（被 Maven 引用但本身无 Spring Web / MOA Provider）
    if (repoName.includes('common') || repoName.includes('sdk') || repoName.includes('pb')) {
      return { group: 'common', layer: 6 };
    }
    // 有 MOA Provider → 微服务
    if (signals.provides_moa) return { group: 'microservice', layer: 4 };
    // 有 Spring Web → 接口层
    if (signals.has_spring_web) return { group: 'web-interface', layer: 1 };
    // 默认归为微服务
    return { group: 'microservice', layer: 4 };
  }

  // Go 项目
  if (lang === 'Go') {
    if (signals.has_grpc) return { group: 'microservice', layer: 4 };
    if (signals.has_http_framework) return { group: 'web-interface', layer: 1 };
    return { group: 'microservice', layer: 4 };
  }

  // Python 项目
  if (lang === 'Python') {
    if (signals.has_ml) return { group: 'microservice', layer: 4 };
    if (signals.has_http_framework) return { group: 'web-interface', layer: 1 };
    if (signals.has_celery) return { group: 'microservice', layer: 4 };
    return { group: 'tool', layer: 7 };
  }

  // Rust
  if (lang === 'Rust') {
    if (signals.has_grpc || signals.has_http_framework) return { group: 'microservice', layer: 4 };
    return { group: 'tool', layer: 7 };
  }

  // Node/TypeScript
  if (lang === 'Node' || lang === 'TypeScript') {
    // 前端应用：有微前端信号或 proxy/env_api 依赖（Vite devServer proxy 等）
    const hasFrontendDeps = deps.some(d => d.type === 'proxy' || d.type === 'env_api');
    if (signals.has_micro_frontend || hasFrontendDeps) {
      if (repoName.includes('admin')) return { group: 'admin-fe', layer: 0 };
      return { group: 'frontend', layer: 0 };
    }
    if (signals.has_http_framework) return { group: 'web-interface', layer: 1 };
    return { group: 'tool', layer: 7 };
  }

  return { group: 'uncategorized', layer: 8 };
}

// ─── 边匹配逻辑 ──────────────────────────────────────────

function matchEdges(
  repoResults: Map<string, { repo: ScannedRepo; result: DepDetectionResult }>,
  repos: ScannedRepo[],
  domainAliases?: Record<string, string>,
): DetectedEdge[] {
  const edges: DetectedEdge[] = [];
  const seen = new Set<string>();

  // 构建 MOA Provider serviceUri → repoId 索引
  const moaProviderIndex = buildMoaProviderIndex(repoResults);

  // 构建 Maven artifactId → repoId 索引
  const mavenIndex = buildMavenIndex(repos);

  // 构建 PHP inner endpoint provider 索引: module → Set<repoId>
  const innerProviderIndex = buildInnerProviderIndex(repos);

  // 构建 nginx server_name → repoId 索引
  const nginxDomainIndex = buildNginxDomainIndex(repos);

  for (const [fromRepoId, { result }] of repoResults) {
    for (const dep of result.deps) {
      let toRepoId: string | undefined;
      let label = '';
      let confidence = dep.confidence;

      switch (dep.type) {
        case 'moa_consumer': {
          if (dep.serviceUri) {
            toRepoId = moaProviderIndex.get(dep.serviceUri);
            label = 'MOA RPC';
            confidence = 0.95;
          }
          break;
        }
        case 'maven': {
          // Maven 依赖仅记录在 repo.dependencies 中，不生成运行时调用边
          // 实际调用关系由 MOA RPC / HTTP API 等协议边覆盖
          break;
        }
        case 'go_module': {
          if (dep.module) {
            toRepoId = findRepoByGoModule(dep.module, repos);
            if (toRepoId) {
              label = 'Go Module';
              confidence = 0.8;
            }
          }
          break;
        }
        case 'proxy':
        case 'env_api':
        case 'httpApi': {
          if (dep.domain) {
            // 优先级: 手动别名 > nginx server_name > 模糊域名匹配
            const aliasTarget = domainAliases?.[dep.domain];
            if (aliasTarget && repos.some(r => r.repoId === aliasTarget)) {
              toRepoId = aliasTarget;
              label = 'HTTP API';
              confidence = 0.9;
            } else {
              toRepoId = nginxDomainIndex.get(dep.domain);
              if (toRepoId) {
                label = 'HTTP API';
                confidence = 0.85;
              } else {
                toRepoId = findRepoByDomain(dep.domain, repos, fromRepoId);
                if (toRepoId) {
                  label = 'HTTP API';
                  confidence = 0.7;
                }
              }
            }
          }
          break;
        }
        case 'composer': {
          if (dep.artifactId) {
            toRepoId = findRepoByComposer(dep.artifactId, repos);
            if (toRepoId) {
              label = 'Composer';
              confidence = 0.7;
            }
          }
          break;
        }
        case 'php_service': {
          if (dep.servicePath) {
            toRepoId = findRepoByServicePath(dep.servicePath, repos);
            if (toRepoId) {
              label = 'RPC';
              confidence = 0.85;
            }
          }
          break;
        }
        case 'inner_http':
        case 'http_callback': {
          if (dep.servicePath) {
            const firstSeg = dep.servicePath.toLowerCase().split('/')[0];
            const fromRepo = repos.find(r => r.repoId === fromRepoId);
            toRepoId = findBestInnerProvider(innerProviderIndex, firstSeg, fromRepo, repos);
            if (toRepoId) {
              label = dep.type === 'http_callback' ? 'HTTP Callback' : 'HTTP API';
              confidence = 0.8;
            }
          }
          break;
        }
        case 'micro_frontend': {
          if (dep.domain) {
            toRepoId = findRepoByDomain(dep.domain, repos, fromRepoId);
            if (toRepoId) {
              label = 'Micro Frontend';
              confidence = 0.7;
            }
          }
          break;
        }
        case 'redis_mq': {
          if (dep.topic) {
            const topicNorm = dep.topic.toLowerCase().replace(/[-_:]/g, '');
            for (const repo of repos) {
              if (repo.repoId === fromRepoId) continue;
              const repoLast = (repo.repoId.split('/').pop() || '').toLowerCase().replace(/-/g, '');
              if (repoLast.length > 3 && topicNorm.includes(repoLast)) {
                toRepoId = repo.repoId;
                label = 'Redis MQ';
                confidence = 0.6;
                break;
              }
            }
          }
          break;
        }
        // kafka_producer / kafka_consumer 在下方统一做跨仓库 topic 匹配
      }

      if (toRepoId && toRepoId !== fromRepoId) {
        const edgeKey = `${fromRepoId}→${toRepoId}:${label}`;
        if (!seen.has(edgeKey)) {
          seen.add(edgeKey);
          edges.push({
            from: fromRepoId,
            to: toRepoId,
            label,
            confidence,
            evidence: dep.source,
            autoDetected: true,
          });
        }
      }
    }
  }

  // Kafka topic 跨仓库匹配：同一 topic 的 producer → consumer
  const kafkaProducers = new Map<string, string[]>(); // topic → [repoId]
  const kafkaConsumers = new Map<string, string[]>();
  for (const [repoId, { result }] of repoResults) {
    for (const dep of result.deps) {
      if (dep.type === 'kafka_producer' && dep.topic) {
        if (!kafkaProducers.has(dep.topic)) kafkaProducers.set(dep.topic, []);
        kafkaProducers.get(dep.topic)!.push(repoId);
      }
      if (dep.type === 'kafka_consumer' && dep.topic) {
        if (!kafkaConsumers.has(dep.topic)) kafkaConsumers.set(dep.topic, []);
        kafkaConsumers.get(dep.topic)!.push(repoId);
      }
    }
  }
  for (const [topic, producers] of kafkaProducers) {
    const consumers = kafkaConsumers.get(topic);
    if (!consumers) continue;
    for (const p of producers) {
      for (const c of consumers) {
        if (p === c) continue;
        const edgeKey = `${p}→${c}:Kafka`;
        if (!seen.has(edgeKey)) {
          seen.add(edgeKey);
          edges.push({
            from: p,
            to: c,
            label: 'Kafka',
            confidence: 0.8,
            evidence: `topic: ${topic}`,
            autoDetected: true,
          });
        }
      }
    }
  }

  return edges;
}

// ─── 索引构建 ─────────────────────────────────────────────

/**
 * 构建 MOA serviceUri → repoId 索引
 * serviceUri 格式：com.xxx.service.XxxService:1.0
 * 匹配条件：该仓库有 @MoaProvider 注解
 */
function buildMoaProviderIndex(
  repoResults: Map<string, { repo: ScannedRepo; result: DepDetectionResult }>,
): Map<string, string> {
  const index = new Map<string, string>();

  for (const [repoId, { result }] of repoResults) {
    if (!result.signals.provides_moa) continue;

    // 从该仓库的代码中查找 @MoaProvider 的 serviceUri
    for (const dep of result.deps) {
      if (dep.type === 'moa_provider' && dep.serviceUri) {
        index.set(dep.serviceUri, repoId);
      }
    }

    // 退而求其次：根据 pom.xml groupId + artifactId 猜测 serviceUri 前缀
    // MOA Provider 的 serviceUri 通常包含 artifactId 的变体
    for (const dep of result.deps) {
      if (dep.type === 'maven' && dep.groupId && dep.artifactId?.endsWith('-api')) {
        const prefix = `${dep.groupId}.${dep.artifactId.replace(/-api$/, '')}`;
        index.set(prefix, repoId);
      }
    }
  }

  return index;
}

function buildMoaProviderIndexFromJava(
  repoResults: Map<string, { repo: ScannedRepo; result: DepDetectionResult }>,
): void {
  // 额外从 Java 文件中提取 @MoaProvider(uri=...) 的 serviceUri 并放入 provider index
  // 注意：MOA 框架中 @MoaProvider 的属性名是 uri（非 serviceUri）
  for (const [repoId, { repo, result }] of repoResults) {
    if (!result.signals.provides_moa) continue;

    const existingUris = new Set(
      result.deps.filter(d => d.type === 'moa_provider' && d.serviceUri).map(d => d.serviceUri),
    );

    try {
      const javaFiles = findMoaProviderFiles(repo.localPath);
      for (const f of javaFiles) {
        const content = fs.readFileSync(f, 'utf-8');
        const uriMatch = content.match(/@MoaProvider\s*\(\s*uri\s*=\s*"([^"]+)"/);
        if (uriMatch && !existingUris.has(uriMatch[1])) {
          result.deps.push({
            type: 'moa_provider',
            serviceUri: uriMatch[1],
            source: path.relative(repo.localPath, f),
            confidence: 0.95,
          });
          existingUris.add(uriMatch[1]);
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, repoId: repo.repoId }, '扫描 MOA Provider 文件失败');
    }
  }
}

function findMoaProviderFiles(repoPath: string): string[] {
  const execOpts = { encoding: 'utf-8' as const, timeout: 300000, stdio: ['ignore' as const, 'pipe' as const, 'pipe' as const] };
  try {
    const output = execFileSync('rg', ['-l', '--glob', '*.java', '@MoaProvider', repoPath], execOpts);
    return output.trim().split('\n').filter(Boolean).slice(0, 20);
  } catch (err) {
    logger.warn({ err: (err as Error).message, repoPath }, 'rg 查找 @MoaProvider 失败');
  }
  try {
    const output = execFileSync('grep', ['-rl', '--include=*.java', '@MoaProvider', repoPath], execOpts);
    return output.trim().split('\n').filter(Boolean).slice(0, 20);
  } catch (err) {
    logger.warn({ err: (err as Error).message, repoPath }, 'grep 查找 @MoaProvider 失败');
    return [];
  }
}

/**
 * 构建 Maven groupId:artifactId → repoId 索引
 * 从各仓库的 pom.xml 根 <groupId>+<artifactId> 获取
 */
function buildMavenIndex(repos: ScannedRepo[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const repo of repos) {
    if (repo.lang !== 'Java' && repo.lang !== 'Kotlin') continue;
    const pomPath = path.join(repo.localPath, 'pom.xml');
    if (!fs.existsSync(pomPath)) continue;

    try {
      const content = fs.readFileSync(pomPath, 'utf-8');
      // 提取根 pom 的 groupId 和 artifactId（排除 parent 中的）
      const parentEnd = content.indexOf('</parent>');
      const searchContent = parentEnd > 0 ? content.substring(parentEnd) : content;

      const gMatch = searchContent.match(/<groupId>([^<]+)<\/groupId>/);
      const aMatch = searchContent.match(/<artifactId>([^<]+)<\/artifactId>/);

      if (gMatch && aMatch) {
        index.set(`${gMatch[1]}:${aMatch[1]}`, repo.repoId);
        index.set(aMatch[1], repo.repoId);
      }

      // 多模块项目：扫描子模块
      const modulePattern = /<module>([^<]+)<\/module>/g;
      let mMatch: RegExpExecArray | null;
      while ((mMatch = modulePattern.exec(content)) !== null) {
        const subPom = path.join(repo.localPath, mMatch[1], 'pom.xml');
        if (fs.existsSync(subPom)) {
          const subContent = fs.readFileSync(subPom, 'utf-8');
          const subA = subContent.match(/<artifactId>([^<]+)<\/artifactId>/);
          if (subA) {
            const subG = subContent.match(/<groupId>([^<]+)<\/groupId>/);
            const groupId = subG ? subG[1] : gMatch?.[1] || '';
            index.set(`${groupId}:${subA[1]}`, repo.repoId);
            index.set(subA[1], repo.repoId);
          }
        }
      }
    } catch { /* 忽略 */ }
  }

  return index;
}

/**
 * 扫描仓库中的 nginx/conf 配置，提取 server_name 建立 domain → repoId 索引
 */
function buildNginxDomainIndex(repos: ScannedRepo[]): Map<string, string> {
  const index = new Map<string, string>();
  const confPaths = ['conf', 'nginx', 'deploy/nginx', 'docker/nginx', '.deploy'];

  for (const repo of repos) {
    for (const cp of confPaths) {
      const confDir = path.join(repo.localPath, cp);
      if (!fs.existsSync(confDir)) continue;
      try {
        const files = fs.readdirSync(confDir).filter(f => /\.(conf|nginx)$/i.test(f));
        for (const f of files) {
          const content = fs.readFileSync(path.join(confDir, f), 'utf-8');
          const matches = content.match(/server_name\s+([^;]+)/g);
          if (!matches) continue;
          for (const m of matches) {
            const domains = m.replace(/^server_name\s+/, '').trim().split(/\s+/);
            for (const d of domains) {
              const clean = d.replace(/[;'"]/g, '').trim();
              if (clean && clean !== '_' && !clean.startsWith('$')) {
                index.set(clean, repo.repoId);
              }
            }
          }
        }
      } catch { /* ignore */ }
    }
  }
  return index;
}

/**
 * 构建 PHP inner endpoint provider 索引
 * 扫描所有 PHP 仓库的 controllers/inner/ 目录，提取子目录名作为 module
 * 返回 Map<module, Set<repoId>>
 */
function buildInnerProviderIndex(repos: ScannedRepo[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const repo of repos) {
    if (repo.lang !== 'PHP') continue;
    for (const base of ['application/controllers/inner', 'app/controllers/inner']) {
      const innerDir = path.join(repo.localPath, base);
      if (!fs.existsSync(innerDir)) continue;
      try {
        const entries = fs.readdirSync(innerDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const mod = entry.name.toLowerCase();
            if (!index.has(mod)) index.set(mod, new Set());
            index.get(mod)!.add(repo.repoId);
          } else if (entry.isFile() && entry.name.endsWith('_controller.php')) {
            const mod = entry.name.replace(/_controller\.php$/, '').toLowerCase();
            if (!index.has(mod)) index.set(mod, new Set());
            index.get(mod)!.add(repo.repoId);
          }
        }
      } catch { /* ignore */ }
    }
  }
  return index;
}

/**
 * 从 inner provider 索引中找到最佳匹配的 provider
 * 多个匹配时使用路径前缀长度作为亲和度（同产品线优先）
 */
function findBestInnerProvider(
  index: Map<string, Set<string>>,
  module: string,
  fromRepo: ScannedRepo | undefined,
  repos: ScannedRepo[],
): string | undefined {
  const providers = index.get(module);
  if (!providers || providers.size === 0) return undefined;

  let bestId: string | undefined;
  let bestScore = -1;

  for (const pid of providers) {
    const pRepo = repos.find(r => r.repoId === pid);
    if (!pRepo || !fromRepo) {
      if (!bestId) bestId = pid;
      continue;
    }
    const sa = fromRepo.localPath.split('/');
    const sb = pRepo.localPath.split('/');
    let score = 0;
    while (score < sa.length && score < sb.length && sa[score] === sb[score]) score++;
    if (score > bestScore) {
      bestScore = score;
      bestId = pid;
    }
  }
  return bestId;
}

function findRepoByGoModule(module: string, repos: ScannedRepo[]): string | undefined {
  for (const repo of repos) {
    if (repo.lang !== 'Go') continue;
    const goModPath = path.join(repo.localPath, 'go.mod');
    if (!fs.existsSync(goModPath)) continue;
    try {
      const content = fs.readFileSync(goModPath, 'utf-8');
      const modLine = content.match(/^module\s+(.+)/m);
      if (modLine && module.startsWith(modLine[1].trim())) {
        return repo.repoId;
      }
    } catch { /* 忽略 */ }
  }
  return undefined;
}

function findRepoByDomain(domain: string, repos: ScannedRepo[], excludeRepoId?: string): string | undefined {
  const candidates = excludeRepoId ? repos.filter(r => r.repoId !== excludeRepoId) : repos;
  const segments = domain.toLowerCase().split(/[.\-_]/).filter(s => s.length > 0);
  const dname = segments[0]?.replace(/-/g, '') || '';
  const FRONTEND_LANGS = new Set(['Vue', 'React', 'Angular']);

  // 域名（proxy target / env API）通常指向后端，多个匹配时优先返回非前端仓库
  function preferBackend(matches: ScannedRepo[]): string | undefined {
    if (matches.length === 0) return undefined;
    const backend = matches.find(r => !FRONTEND_LANGS.has(r.lang));
    return (backend ?? matches[0]).repoId;
  }

  // Pass 1: 仓库名包含于域名第一段
  {
    const hits = candidates.filter(repo => {
      const rname = (repo.repoId.split('/').pop() || '').toLowerCase().replace(/-/g, '');
      return rname.length > 3 && dname.includes(rname);
    });
    const r = preferBackend(hits);
    if (r) return r;
  }

  // Pass 2: 域名的任意段精确等于仓库名（支持短名称如 "api"）
  {
    const hits = candidates.filter(repo => {
      const lastPart = repo.repoId.split('/').pop()?.toLowerCase() || '';
      return segments.some(seg => seg === lastPart && seg.length >= 2);
    });
    const r = preferBackend(hits);
    if (r) return r;
  }

  // Pass 3: 域名所有段拼接后包含仓库名
  const fullNormalized = segments.join('');
  {
    const hits = candidates.filter(repo => {
      const rname = (repo.repoId.split('/').pop() || '').toLowerCase().replace(/-/g, '');
      return rname.length > 3 && fullNormalized.includes(rname);
    });
    const r = preferBackend(hits);
    if (r) return r;
  }

  // Pass 4（双向子串）: 按 "." 提取子域名，去环境后缀后做双向包含
  const subdomain = domain.toLowerCase().split('.')[0] || '';
  const domainPrefix = stripEnvSuffix(subdomain);
  const dpNorm = domainPrefix.replace(/-/g, '');
  {
    const hits = candidates.filter(repo => {
      const rname = (repo.repoId.split('/').pop() || '').toLowerCase().replace(/-/g, '');
      return rname.length > 3 && dpNorm.length > 3 && (rname.includes(dpNorm) || dpNorm.includes(rname));
    });
    const r = preferBackend(hits);
    if (r) return r;
  }

  // Pass 5: 子域名去环境后缀后与仓库名做 Jaccard token 相似度
  {
    const hits: ScannedRepo[] = [];
    for (const repo of candidates) {
      const lastPart = repo.repoId.split('/').pop() || '';
      const rTokens = new Set(lastPart.toLowerCase().split('-').filter(s => s.length > 1));
      const dTokens = new Set(domainPrefix.split('-').filter(s => s.length > 1));
      if (rTokens.size < 2 || dTokens.size < 2) continue;
      const intersection = [...rTokens].filter(t => dTokens.has(t)).length;
      const union = new Set([...rTokens, ...dTokens]).size;
      if (union > 0 && intersection / union >= 0.5) hits.push(repo);
    }
    const r = preferBackend(hits);
    if (r) return r;
  }

  return undefined;
}

/** 去除域名前缀中的环境标识后缀（alpha/stage/lab/test/dev/pre/prod） */
function stripEnvSuffix(prefix: string): string {
  return prefix.replace(/[-_]?(alpha|stage|staging|lab|test|dev|pre|prod|online|gray|canary)$/i, '');
}

function findRepoByComposer(pkg: string, repos: ScannedRepo[]): string | undefined {
  for (const repo of repos) {
    if (repo.lang !== 'PHP') continue;
    const composerPath = path.join(repo.localPath, 'composer.json');
    if (!fs.existsSync(composerPath)) continue;
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8'));
      if (composer.name === pkg) return repo.repoId;
    } catch { /* 忽略 */ }
  }
  return undefined;
}

/**
 * 将 PHP /service/... 路径映射到已扫描仓库
 * 匹配规则：servicePath 以仓库 repoId 结尾（路径分隔符对齐）
 * 示例：servicePath="org/team/service" → repoId="org/team/service"
 */
function findRepoByServicePath(servicePath: string, repos: ScannedRepo[]): string | undefined {
  const normalized = servicePath.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');

  // Pass 1: 精确匹配 repoId 结尾
  for (const repo of repos) {
    const repoNorm = repo.repoId.toLowerCase().replace(/\\/g, '/');
    if (repoNorm.endsWith(normalized) || normalized.endsWith(repoNorm)) {
      return repo.repoId;
    }
  }

  // Pass 2: 服务路径的最后一段与仓库名匹配
  const lastSegment = normalized.split('/').pop() || '';
  if (lastSegment.length > 3) {
    for (const repo of repos) {
      const repoLastPart = repo.repoId.split('/').pop()?.toLowerCase() || '';
      if (repoLastPart === lastSegment) {
        return repo.repoId;
      }
    }
  }

  return undefined;
}

// ─── URL 脱敏 ─────────────────────────────────────────────

/**
 * 从 Git remote URL 中移除凭证信息
 * https://token@github.com/org/repo → https://github.com/org/repo
 * ssh://user@host/repo 保留（SSH 无密码风险）
 */
function sanitizeRemoteUrl(remote: string): string {
  if (!remote) return '';
  try {
    if (remote.startsWith('https://') || remote.startsWith('http://')) {
      const url = new URL(remote);
      url.username = '';
      url.password = '';
      return url.toString().replace(/\/$/, '');
    }
  } catch { /* 非标准 URL，原样返回 */ }
  return remote;
}

// ─── 辅助 ─────────────────────────────────────────────────

function buildGroupsSummary(
  classifications: Map<string, Classification>,
): Record<string, { label: string; layer: number }> {
  const usedGroups = new Set<string>();
  for (const cls of classifications.values()) {
    usedGroups.add(cls.group);
  }

  const result: Record<string, { label: string; layer: number }> = {};
  for (const g of usedGroups) {
    const def = DEFAULT_GROUPS[g];
    if (def) {
      result[g] = { label: def.label, layer: def.layer };
    } else {
      result[g] = { label: g, layer: 8 };
    }
  }
  return result;
}

/**
 * 执行完整拓扑扫描流程
 * 包含 MOA Provider serviceUri 二次提取增强
 * 支持单仓库模式（singleRepo=true）：只扫描一个仓库，从已有注册表查 provider 信息
 */
export async function scanTopology(options: ScanOptions): Promise<ScanResult> {
  const { productLine, scanRoots, gitPatterns = [] } = options;
  const progress = options.onProgress || (() => {});
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;
  const isSingleRepo = !!options.singleRepo;
  const existingReg = options.existingRegistry;

  // Phase 1: 仓库发现
  progress('发现仓库', `扫描 ${scanRoots.length} 个根目录`, 10);
  const repos = discoverRepos(scanRoots, gitPatterns);
  if (repos.length === 0) {
    throw new Error(`在 ${scanRoots.join(', ')} 下未发现任何 Git 仓库`);
  }
  progress('发现仓库', `发现 ${repos.length} 个 Git 仓库`, 20);
  console.log(`[TIMING] Phase1 仓库发现: ${elapsed()}`);

  // Phase 2: 依赖检测
  progress('检测依赖', `分析 ${repos.length} 个仓库的依赖`, 30);
  const repoResults = new Map<string, { repo: ScannedRepo; result: DepDetectionResult }>();
  for (const repo of repos) {
    const tRepo = Date.now();
    const result = detectDeps(repo);
    repoResults.set(repo.repoId, { repo, result });
    console.log(`[TIMING] detectDeps(${repo.repoId}): ${Date.now() - tRepo}ms`);
  }
  console.log(`[TIMING] Phase2 依赖检测: ${elapsed()}`);

  // Phase 2.5: 增强 — 提取 MOA Provider serviceUri（二次扫描）
  progress('检测依赖', 'MOA Provider serviceUri 增强提取', 40);
  buildMoaProviderIndexFromJava(repoResults);
  console.log(`[TIMING] Phase2.5 MOA增强: ${elapsed()}`);

  // Phase 3: 自动分类
  progress('自动分类', '根据语言和信号自动分类', 50);
  const classifications = new Map<string, { group: string; layer: number }>();
  for (const [repoId, { repo, result }] of repoResults) {
    const cls = classifyRepo(repo, result.signals, result.deps);
    classifications.set(repoId, cls);
  }
  console.log(`[TIMING] Phase3 自动分类: ${elapsed()}`);

  // Phase 4: 边匹配（单仓库模式跳过，后续从接口推导）
  let edges: DetectedEdge[];
  if (isSingleRepo) {
    edges = [];
    console.log(`[TIMING] Phase4 边匹配: 跳过（单仓库模式） ${elapsed()}`);
  } else {
    progress('匹配边', '匹配仓库间依赖关系', 60);
    edges = matchEdges(repoResults, repos, options.domainAliases);
    progress('匹配边', `发现 ${edges.length} 条依赖边`, 65);
    console.log(`[TIMING] Phase4 边匹配: ${elapsed()}`);
  }

  // Phase 4.5: 接口级依赖 + 流量查询
  progress('接口检测', '构建接口级依赖', 70);
  const moaProviderIdx = buildMoaProviderIndex(repoResults);

  // 单仓库模式：从已有注册表补充 provider 索引
  if (isSingleRepo && existingReg?.moaRegistry) {
    for (const entry of existingReg.moaRegistry) {
      if (!moaProviderIdx.has(entry.serviceUri)) {
        moaProviderIdx.set(entry.serviceUri, entry.repoId);
      }
    }
    console.log(`[单仓库] 从已有注册表补充 Provider 索引: ${moaProviderIdx.size} 条`);
  }

  const httpEndpoints = collectHttpProviderEndpoints(repoResults);

  let consumerCount = 0;
  let providerCount = 0;
  for (const [, { result }] of repoResults) {
    for (const dep of result.deps) {
      if (dep.type === 'moa_consumer') consumerCount++;
      if (dep.type === 'moa_provider') providerCount++;
    }
  }
  const sampleProviders = Array.from(moaProviderIdx.entries()).slice(0, 10);
  logger.debug(
    { providerIndexSize: moaProviderIdx.size, httpEndpointSize: httpEndpoints.size, consumerCount, providerCount },
    '[接口检测] Provider/HTTP/Consumer/Provider 统计',
  );
  logger.debug(
    { sampleProviders: Object.fromEntries(sampleProviders) },
    '[接口检测] 示例 Provider',
  );

  const detectedInterfaces = buildDetectedInterfaces(
    repoResults, moaProviderIdx, httpEndpoints, edges,
    isSingleRepo ? { allowUnknownProvider: true } : undefined,
  );
  const moaRegistryEntries = buildMoaRegistryEntries(repoResults);

  logger.debug(
    { interfaceCount: detectedInterfaces.length, moaRegistryCount: moaRegistryEntries.length },
    '[接口检测] 接口与 MOA 注册统计',
  );
  if (detectedInterfaces.length > 0) {
    const samples = detectedInterfaces.slice(0, 5).map(i => `${i.fromRepoId}→${i.toRepoId}:${i.interfaceUrl}`);
    logger.debug({ samples }, '[接口检测] 示例接口');
  }

  // 构建 repoId → appKey / appKeys / lang 映射
  const appKeyMap = new Map<string, string>();
  const appKeysMap = new Map<string, string[]>();
  const repoLangMap = new Map<string, string>();
  for (const [repoId, { repo, result }] of repoResults) {
    if (result.appKey) appKeyMap.set(repoId, result.appKey);
    if (result.appKeys && result.appKeys.length > 0) appKeysMap.set(repoId, result.appKeys);
    repoLangMap.set(repoId, repo.lang);
  }

  // 单仓库模式：从已有注册表补充 provider 的 appKey/lang（流量查询时需要）
  if (isSingleRepo && existingReg?.repos) {
    for (const [repoId, repoInfo] of Object.entries(existingReg.repos)) {
      if (!appKeyMap.has(repoId) && repoInfo.appKey) appKeyMap.set(repoId, repoInfo.appKey);
      if (!appKeysMap.has(repoId) && repoInfo.appKeys?.length) appKeysMap.set(repoId, repoInfo.appKeys);
      if (!repoLangMap.has(repoId)) repoLangMap.set(repoId, repoInfo.lang);
    }
    console.log(`[单仓库] 从已有注册表补充 appKey 映射: appKey=${appKeyMap.size}, lang=${repoLangMap.size}`);
  }

  // 批量查询 Hubble 流量（未配置 HUBBLE_API_KEY 时流量为 0，不阻塞）
  progress('流量查询', '查询 Hubble 接口流量', 75);
  const tTraffic = Date.now();
  const interfacesWithTraffic = await queryTrafficBatch(detectedInterfaces, appKeyMap, appKeysMap, repoLangMap);
  console.log(`[TIMING] Phase4.5 流量查询: ${Date.now() - tTraffic}ms (总 ${elapsed()})`);

  // 单仓库模式：从接口推导边
  if (isSingleRepo && edges.length === 0) {
    const edgeSet = new Set<string>();
    for (const iface of interfacesWithTraffic) {
      if (iface.toRepoId.startsWith('unknown:')) continue;
      const edgeKey = `${iface.fromRepoId}→${iface.toRepoId}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edges.push({
          from: iface.fromRepoId,
          to: iface.toRepoId,
          label: 'MOA',
          confidence: iface.confidence,
          evidence: `consumer 调用 ${iface.interfaceUrl}`,
          autoDetected: true,
        });
      }
    }
    console.log(`[单仓库] 从接口推导 ${edges.length} 条边`);
  }

  // Phase 5: 基础设施检测
  progress('基础设施', '检测 MySQL/Redis/Kafka 等基础设施', 80);
  const infraResults = new Map<string, ReturnType<typeof detectInfra>>();
  for (const [repoId, { repo }] of repoResults) {
    infraResults.set(repoId, detectInfra(repo.localPath, repo.lang));
  }

  // Phase 6: 注册表
  progress('生成注册表', '组装拓扑数据', 90);
  const reposRecord: Record<string, RegistryRepo> = {};
  for (const [repoId, { repo, result }] of repoResults) {
    const cls = classifications.get(repoId)!;
    const infra = infraResults.get(repoId);
    reposRecord[repoId] = {
      desc: result.description || path.basename(repo.localPath),
      lang: repo.lang,
      layer: cls.layer,
      group: cls.group,
      localPath: repo.localPath,
      remote: sanitizeRemoteUrl(repo.remote),
      gitHost: repo.gitHost,
      gitGroup: repo.gitGroup,
      dependencies: result.deps.length > 0 ? result.deps : undefined,
      signals: Object.keys(result.signals).length > 0 ? result.signals : undefined,
      infra: infra?.items.length ? infra.items : undefined,
      serverPort: infra?.serverPort,
      appKey: result.appKey,
      appKeys: result.appKeys,
    };
  }

  const primaryHost = repos.length > 0 ? repos[0].gitHost : '';
  const primaryRoot = scanRoots[0]?.replace(/^~/, process.env.HOME || '') || '';

  const registry: RegistryData = {
    productLine,
    rootDir: primaryRoot,
    gitHost: primaryHost,
    generatedAt: new Date().toISOString(),
    generatedBy: 'memforge-topology-scanner',
    repos: reposRecord,
    edges,
    groups: buildGroupsSummary(classifications),
    interfaces: interfacesWithTraffic.length > 0 ? interfacesWithTraffic : undefined,
    moaRegistry: moaRegistryEntries.length > 0 ? moaRegistryEntries : undefined,
  };

  console.log(`[TIMING] Phase5+6 基础设施+注册表: ${elapsed()}`);

  progress('写入文件', '保存注册表到本地', 95);
  const outputDir = options.outputPath || getIdeConfig().configDir;
  const outputFile = path.join(outputDir, `${productLine}-registry.json`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputFile, JSON.stringify(registry, null, 2), 'utf-8');
  console.log(`[TIMING] 全部完成: ${elapsed()}`);

  return {
    registry,
    filePath: outputFile,
    repoCount: repos.length,
    edgeCount: edges.length,
  };
}
