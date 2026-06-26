// Created by dev on 2026/06/10
// Copyright © 2026
// 拓扑扫描引擎 — 接口级依赖构建

import { getLogger } from '@memforgeai/shared';
import type { ScannedRepo, DetectedDep, DetectedInterface, DetectedEdge, MoaRegistryEntry } from './types.js';
import type { DepDetectionResult } from './dep-detection.js';

const logger = getLogger('interface-detection');

/**
 * 构建 MOA serviceUri → provider 方法名列表索引
 * 用于将 provider 侧的方法名回填到 consumer → provider 的接口记录中
 */
function buildMoaProviderMethodIndex(
  repoResults: Map<string, { repo: ScannedRepo; result: DepDetectionResult }>,
): Map<string, { methods: string[]; providerFile: string }> {
  const index = new Map<string, { methods: string[]; providerFile: string }>();

  for (const [, { result }] of repoResults) {
    const providerDeps = result.deps.filter(d => d.type === 'moa_provider' && d.serviceUri && !d.httpPath);
    const byUri = new Map<string, { methods: Set<string>; file: string }>();

    for (const dep of providerDeps) {
      if (!dep.serviceUri) continue;
      if (!byUri.has(dep.serviceUri)) {
        byUri.set(dep.serviceUri, { methods: new Set(), file: dep.source });
      }
      if (dep.methodName) {
        byUri.get(dep.serviceUri)!.methods.add(dep.methodName);
      }
    }

    for (const [uri, { methods, file }] of byUri) {
      if (methods.size > 0) {
        index.set(uri, { methods: [...methods], providerFile: file });
      }
    }
  }

  return index;
}

/**
 * 从 MOA consumer/HTTP dep 构建接口级依赖 DetectedInterface[]
 * @param repoResults 各仓库的检测结果
 * @param moaProviderIndex MOA serviceUri → repoId 索引
 * @param httpProviderEndpoints HTTP path → repoId 索引
 * @param matchedEdges 已建立的 from→to 边关系（用于 HTTP 接口级过滤）
 */
export function buildDetectedInterfaces(
  repoResults: Map<string, { repo: ScannedRepo; result: DepDetectionResult }>,
  moaProviderIndex: Map<string, string>,
  httpProviderEndpoints: Map<string, { repoId: string; providerFile: string }>,
  matchedEdges?: DetectedEdge[],
  options?: { allowUnknownProvider?: boolean },
): DetectedInterface[] {
  const interfaces: DetectedInterface[] = [];
  const seen = new Set<string>();

  const moaMethodIndex = buildMoaProviderMethodIndex(repoResults);

  const consumerCalledMethods = new Map<string, { methods: Set<string>; sourceFile: string; confidence: number }>();
  for (const [fromRepoId, { result }] of repoResults) {
    for (const dep of result.deps) {
      if (dep.type === 'moa_consumer' && dep.serviceUri) {
        const mapKey = `${fromRepoId}:${dep.serviceUri}`;
        if (!consumerCalledMethods.has(mapKey)) {
          consumerCalledMethods.set(mapKey, { methods: new Set(), sourceFile: dep.source, confidence: dep.confidence });
        }
        if (dep.methodName) {
          consumerCalledMethods.get(mapKey)!.methods.add(dep.methodName);
        }
      }
    }
  }

  for (const [mapKey, { methods: calledMethods, sourceFile, confidence }] of consumerCalledMethods) {
    const [fromRepoId, serviceUri] = [mapKey.substring(0, mapKey.indexOf(':')), mapKey.substring(mapKey.indexOf(':') + 1)];
    let toRepoId = moaProviderIndex.get(serviceUri);
    if (!toRepoId) {
      if (!options?.allowUnknownProvider) continue;
      toRepoId = `unknown:${serviceUri}`;
    }
    if (toRepoId === fromRepoId) continue;

    const providerInfo = moaMethodIndex.get(serviceUri);

    if (calledMethods.size > 0) {
      // consumer 侧提取到了实际调用的方法，只为这些方法生成接口记录
      for (const methodName of calledMethods) {
        const key = `${fromRepoId}→${toRepoId}:moa:${serviceUri}:${methodName}`;
        if (seen.has(key)) continue;
        seen.add(key);

        interfaces.push({
          type: 'moa',
          fromRepoId,
          toRepoId,
          interfaceUrl: serviceUri,
          methodName,
          sourceFile,
          providerFile: providerInfo?.providerFile,
          confidence,
        });
      }
    } else {
      // consumer 未提取到方法调用，只创建 serviceUri 级别的记录（无方法名）
      const key = `${fromRepoId}→${toRepoId}:moa:${serviceUri}:`;
      if (seen.has(key)) continue;
      seen.add(key);

      interfaces.push({
        type: 'moa',
        fromRepoId,
        toRepoId,
        interfaceUrl: serviceUri,
        sourceFile,
        confidence,
      });
    }
  }

  // 构建已确认的边关系集合（from→to），用于 HTTP 接口级过滤
  const confirmedEdges = new Set<string>();
  if (matchedEdges) {
    for (const edge of matchedEdges) {
      confirmedEdges.add(`${edge.from}→${edge.to}`);
    }
  }

  // 构建 HTTP 接口级依赖：仅为已确认的 from→to 关系创建接口记录
  for (const [urlPath, provider] of httpProviderEndpoints) {
    // 找出所有已确认调用该 provider 的 consumer
    for (const [fromRepoId] of repoResults) {
      if (fromRepoId === provider.repoId) continue;

      // 必须有已确认的边关系
      if (confirmedEdges.size > 0 && !confirmedEdges.has(`${fromRepoId}→${provider.repoId}`)) continue;

      // 如果没有 matchedEdges（兼容旧调用），回退到检查 consumer 是否有 HTTP 类依赖
      if (!matchedEdges) {
        const consumerResult = repoResults.get(fromRepoId);
        const hasHttpDep = consumerResult?.result.deps.some(
          d => (d.type === 'httpApi' || d.type === 'proxy' || d.type === 'env_api') && d.domain,
        );
        if (!hasHttpDep) continue;
      }

      const key = `${fromRepoId}→${provider.repoId}:http:${urlPath}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const consumerDep = repoResults.get(fromRepoId)?.result.deps.find(
        d => (d.type === 'httpApi' || d.type === 'proxy' || d.type === 'env_api') && d.domain,
      );

      interfaces.push({
        type: 'http',
        fromRepoId,
        toRepoId: provider.repoId,
        interfaceUrl: urlPath,
        sourceFile: consumerDep?.source,
        providerFile: provider.providerFile,
        confidence: consumerDep?.confidence ?? 0.7,
      });
    }
  }

  logger.info({ count: interfaces.length }, '接口级依赖构建完成');
  return interfaces;
}

/**
 * 从各仓库的 provider 侧收集 HTTP 端点路径 → repoId 索引
 */
export function collectHttpProviderEndpoints(
  repoResults: Map<string, { repo: ScannedRepo; result: DepDetectionResult }>,
): Map<string, { repoId: string; providerFile: string }> {
  const endpoints = new Map<string, { repoId: string; providerFile: string }>();

  for (const [repoId, { result }] of repoResults) {
    for (const dep of result.deps) {
      if (dep.type === 'moa_provider' && dep.httpPath) {
        endpoints.set(dep.httpPath, { repoId, providerFile: dep.source });
      }
    }
  }

  logger.info({ count: endpoints.size }, 'HTTP Provider 端点索引构建完成');
  return endpoints;
}

/**
 * 从各仓库的 MOA Provider deps 构建 MoaRegistryEntry 列表
 */
export function buildMoaRegistryEntries(
  repoResults: Map<string, { repo: ScannedRepo; result: DepDetectionResult }>,
): MoaRegistryEntry[] {
  const entries: MoaRegistryEntry[] = [];
  const seen = new Set<string>();

  for (const [repoId, { result }] of repoResults) {
    for (const dep of result.deps) {
      if (dep.type === 'moa_provider' && dep.serviceUri && !dep.httpPath) {
        if (seen.has(dep.serviceUri)) continue;
        seen.add(dep.serviceUri);

        entries.push({
          serviceUri: dep.serviceUri,
          repoId,
          providerFile: dep.source,
          confidence: dep.confidence,
        });
      }
    }
  }

  logger.info({ count: entries.length }, 'MOA 注册表条目构建完成');
  return entries;
}
