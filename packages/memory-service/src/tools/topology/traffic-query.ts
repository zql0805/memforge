// Created by dev on 2026/06/10
// Copyright © 2026
// 拓扑扫描引擎 — Hubble 流量查询

import { getLogger } from '@memforgeai/shared';
import type { DetectedInterface, RegistryInterfaceRecord } from './types.js';

const logger = getLogger('traffic-query');

const HUBBLE_MCP_URL = process.env.HUBBLE_MCP_URL || 'https://hubble-mcp.example.com/mcp';
const HUBBLE_API_KEY = process.env.HUBBLE_API_KEY || '';
const HUBBLE_MOA_SOURCE = process.env.HUBBLE_MOA_SOURCE || 'moa_client_aws';
const HUBBLE_NGINX_SOURCE = process.env.HUBBLE_NGINX_SOURCE || 'nginx_aws';

interface HubbleTimeseriesPoint {
  timestamp: number;
  value: number;
}

interface HubbleQueryParams {
  appKey: string;
  source: string;
  action: string;
  indicator: string;
  aggregator: string;
  downsampler: string;
  tags: Array<{ tagk: string; tagv: string; groupBy: boolean; type: string }>;
  startTime: number;
  endTime: number;
}

interface TrafficResult {
  avg: number;
  peak: number;
}

interface HubbleSeries {
  tags?: Record<string, string>;
  datapoints?: HubbleTimeseriesPoint[];
}

const HUBBLE_MIN_INTERVAL_MS = 500;
let hubbleGate: Promise<void> = Promise.resolve();

/**
 * 全局请求令牌：每次调用排队等前一个完成后延迟 100ms 再放行
 * Request 1: 立即放行；Request 2: 100ms 后放行；Request 3: 200ms 后放行...
 */
function acquireHubbleSlot(): Promise<void> {
  const myTurn = hubbleGate;
  hubbleGate = hubbleGate.then(() =>
    new Promise<void>(r => setTimeout(r, HUBBLE_MIN_INTERVAL_MS)),
  );
  return myTurn;
}

/**
 * 执行 Hubble MCP 请求，返回原始系列数组
 * 通过 promise chain 保证全局最小 500ms 请求间隔，限流时内部重试（最多 3 次）
 */
async function queryHubbleRaw(params: HubbleQueryParams): Promise<HubbleSeries[]> {
  if (!HUBBLE_API_KEY) return [];

  await acquireHubbleSlot();

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(HUBBLE_MCP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'HUBBLE-API-KEY': HUBBLE_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: 'hubble_tool_query_indicator_timeseries',
            arguments: params,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        logger.warn({ status: resp.status, appKey: params.appKey }, 'Hubble MCP 调用失败');
        return [];
      }

      const rpcResult = await resp.json() as {
        result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
        error?: { message: string };
      };
      if (rpcResult.error) {
        logger.warn({ error: rpcResult.error.message, appKey: params.appKey }, 'Hubble MCP 返回错误');
        return [];
      }

      if (rpcResult.result?.isError) {
        const errText = rpcResult.result.content?.find(c => c.type === 'text')?.text ?? '';
        if (errText.includes('frequency limit') && attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        logger.warn({ error: errText, appKey: params.appKey }, 'Hubble 业务错误');
        return [];
      }

      const textContent = rpcResult.result?.content?.find(c => c.type === 'text')?.text;
      if (!textContent) return [];

      try {
        return JSON.parse(textContent) as HubbleSeries[];
      } catch {
        logger.warn({ text: textContent.substring(0, 100), appKey: params.appKey }, 'Hubble 响应非 JSON');
        return [];
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, appKey: params.appKey }, 'Hubble 请求异常');
      return [];
    }
  }
  return [];
}

/**
 * 查询 Hubble 时序数据（单系列，向后兼容）
 */
async function queryHubble(params: HubbleQueryParams): Promise<HubbleTimeseriesPoint[]> {
  const series = await queryHubbleRaw(params);
  return series[0]?.datapoints ?? [];
}

/**
 * 从时序数据计算日均和峰值
 */
function computeTraffic(points: HubbleTimeseriesPoint[]): TrafficResult {
  if (points.length === 0) return { avg: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (const p of points) {
    sum += p.value;
    if (p.value > peak) peak = p.value;
  }
  return { avg: Math.round(sum / points.length), peak };
}

/**
 * 查询单个 MOA 接口的流量（consumer 视角）
 * 使用 consumer 的 appKey + moa_client_aws，精确到两个服务间的调用量
 * avg: 1d-sum 日总调用量的平均值
 * peak: 1m-max 每分钟最大调用数（真实峰值 QPS）
 */
async function queryMoaTraffic(
  appKey: string,
  serviceUri: string,
  methodName: string | undefined,
): Promise<TrafficResult> {
  const now = Date.now();
  const startTime = now - 2 * 24 * 60 * 60 * 1000;

  const tags: HubbleQueryParams['tags'] = [];
  if (methodName) {
    tags.push({ tagk: 'm-name', tagv: methodName, groupBy: false, type: 'literal_or' });
  }

  // avg: 日总调用量（最近 2 天）
  const avgPoints = await queryHubble({
    appKey,
    source: HUBBLE_MOA_SOURCE,
    action: serviceUri,
    indicator: 'm_condition_count',
    aggregator: 'sum',
    downsampler: '1d-sum',
    tags,
    startTime,
    endTime: now,
  });

  // peak: 每分钟最大调用数（最近 2 天）
  const peakPoints = await queryHubble({
    appKey,
    source: HUBBLE_MOA_SOURCE,
    action: serviceUri,
    indicator: 'm_condition_count',
    aggregator: 'max',
    downsampler: '1m-max',
    tags,
    startTime,
    endTime: now,
  });

  const avgResult = computeTraffic(avgPoints);
  const peakResult = computeTraffic(peakPoints);
  return { avg: avgResult.avg, peak: peakResult.peak };
}

/**
 * MOA 批量流量查询（moa_client_aws / moa_aws）
 *
 * 使用 action="全部action" + tag groupBy action/m-name，一次查出整个 appKey
 * 调用的所有 serviceUri 下所有方法的流量，只需 2 次 Hubble 调用。
 *
 * @returns Map 的 key 是 "serviceUri\0methodName"（与 PHP bulk 保持一致）
 */
async function queryMoaTrafficBulk(
  appKey: string,
  source: string,
): Promise<Map<string, TrafficResult>> {
  const now = Date.now();
  const startTime = now - 2 * 24 * 60 * 60 * 1000;
  const tags = [
    { tagk: 'm-name', tagv: '*', groupBy: true, type: 'wildcard' },
    { tagk: 'action', tagv: '*', groupBy: true, type: 'wildcard' },
  ];

  logger.info({ appKey, source }, 'MOA 批量查询（全部action + groupBy action/m-name）');

  const [avgSeries, peakSeries] = await Promise.all([
    queryHubbleRaw({
      appKey,
      source,
      action: '全部action',
      indicator: 'm_condition_count',
      aggregator: 'sum',
      downsampler: '1d-sum',
      tags,
      startTime,
      endTime: now,
    }),
    queryHubbleRaw({
      appKey,
      source,
      action: '全部action',
      indicator: 'm_condition_count',
      aggregator: 'max',
      downsampler: '1m-max',
      tags,
      startTime,
      endTime: now,
    }),
  ]);

  const avgMap = new Map<string, number>();
  for (const s of avgSeries) {
    const serviceUri = s.tags?.['action'] ?? '';
    const method = s.tags?.['m-name'] ?? '';
    if (serviceUri && method) {
      avgMap.set(`${serviceUri}\0${method}`, computeTraffic(s.datapoints ?? []).avg);
    }
  }

  const resultMap = new Map<string, TrafficResult>();
  for (const s of peakSeries) {
    const serviceUri = s.tags?.['action'] ?? '';
    const method = s.tags?.['m-name'] ?? '';
    if (serviceUri && method) {
      const key = `${serviceUri}\0${method}`;
      resultMap.set(key, {
        avg: avgMap.get(key) ?? 0,
        peak: computeTraffic(s.datapoints ?? []).peak,
      });
    }
  }
  for (const [key, avg] of Array.from(avgMap)) {
    if (!resultMap.has(key)) resultMap.set(key, { avg, peak: 0 });
  }

  logger.info({ appKey, source, totalMethods: resultMap.size }, 'MOA 批量查询完成');
  return resultMap;
}

/**
 * PHP MOA provider 批量流量查询（php_aws + api_monitor）
 *
 * 一次查出整个 appKey 下所有 serviceUri 的所有方法流量，只需 2 次 Hubble 调用。
 *
 * PHP MOA 在 Hubble 的 URI 格式：serviceUri 去掉开头 / 并将 / 替换为 . 再拼 :methodName
 *   例如 /service/group/product/activity/module/submodule:getRank
 *   → uri=service.group.product.activity.module.submodule:getRank
 *
 * 使用通配符 prefix.* 一次查出所有 serviceUri+method
 * @returns Map 的 key 是 "serviceUri\0methodName"（用 \0 分隔）
 */
async function queryPhpMoaTrafficBulk(
  appKey: string,
  uriPrefix: string,
): Promise<Map<string, TrafficResult>> {
  const now = Date.now();
  const startTime = now - 2 * 24 * 60 * 60 * 1000;
  // /service/group/product/activity → service.group.product.activity
  const hubblePrefix = uriPrefix.replace(/^\//, '').replace(/\//g, '.');
  const uriPattern = `${hubblePrefix}*`;

  logger.info({ appKey, uriPrefix, hubbleUri: uriPattern, source: 'php_aws' }, 'PHP MOA 批量查询（全 appKey）');

  const [avgSeries, peakSeries] = await Promise.all([
    queryHubbleRaw({
      appKey,
      source: 'php_aws',
      action: 'api_monitor',
      indicator: 'frequency',
      aggregator: 'sum',
      downsampler: '1d-sum',
      tags: [{ tagk: 'uri', tagv: uriPattern, groupBy: true, type: 'wildcard' }],
      startTime,
      endTime: now,
    }),
    queryHubbleRaw({
      appKey,
      source: 'php_aws',
      action: 'api_monitor',
      indicator: 'frequency',
      aggregator: 'max',
      downsampler: '1m-max',
      tags: [{ tagk: 'uri', tagv: uriPattern, groupBy: true, type: 'wildcard' }],
      startTime,
      endTime: now,
    }),
  ]);

  /**
   * 从 uri tag 提取 serviceUri 和 methodName
   * service.group.product.activity.module.submodule:getRank
   * → serviceUri=/service/group/product/activity/module/submodule, method=getRank
   */
  function parseUri(uriTag: string): { serviceUri: string; method: string } | null {
    const colonIdx = uriTag.lastIndexOf(':');
    if (colonIdx < 0) return null;
    const dotPath = uriTag.substring(0, colonIdx);
    const method = uriTag.substring(colonIdx + 1);
    const serviceUri = '/' + dotPath.replace(/\./g, '/');
    return { serviceUri, method };
  }

  const avgMap = new Map<string, number>();
  for (const s of avgSeries) {
    const parsed = parseUri(s.tags?.['uri'] ?? '');
    if (parsed) avgMap.set(`${parsed.serviceUri}\0${parsed.method}`, computeTraffic(s.datapoints ?? []).avg);
  }

  const resultMap = new Map<string, TrafficResult>();
  for (const s of peakSeries) {
    const parsed = parseUri(s.tags?.['uri'] ?? '');
    if (parsed) {
      const key = `${parsed.serviceUri}\0${parsed.method}`;
      resultMap.set(key, {
        avg: avgMap.get(key) ?? 0,
        peak: computeTraffic(s.datapoints ?? []).peak,
      });
    }
  }
  for (const [key, avg] of Array.from(avgMap)) {
    if (!resultMap.has(key)) resultMap.set(key, { avg, peak: 0 });
  }

  logger.info({ appKey, totalMethods: resultMap.size }, 'PHP MOA 批量查询完成');
  return resultMap;
}

/**
 * 查询单个 HTTP 接口的流量（通过 Nginx 集群）
 * avg: 日总请求量
 * peak: 每分钟最大请求数
 */
async function queryHttpTraffic(uri: string): Promise<TrafficResult> {
  const now = Date.now();
  const startTime = now - 2 * 24 * 60 * 60 * 1000;

  const isInner = uri.startsWith('/inner');
  const nginxAppKey = process.env.HUBBLE_NGINX_APPKEY_INNER && isInner
    ? process.env.HUBBLE_NGINX_APPKEY_INNER
    : (process.env.HUBBLE_NGINX_APPKEY_OUTER || 'nginx.monitor.api/product/live');
  const nginxAction = process.env.HUBBLE_NGINX_ACTION_INNER && isInner
    ? process.env.HUBBLE_NGINX_ACTION_INNER
    : (process.env.HUBBLE_NGINX_ACTION_OUTER || 'api/product/live');
  const tags: HubbleQueryParams['tags'] = [{ tagk: 'uri', tagv: uri, groupBy: false, type: 'literal_or' }];

  // avg: 日总请求量（最近 2 天）
  const avgPoints = await queryHubble({
    appKey: nginxAppKey,
    source: HUBBLE_NGINX_SOURCE,
    action: nginxAction,
    indicator: 'uriCount',
    aggregator: 'sum',
    downsampler: '1d-sum',
    tags,
    startTime,
    endTime: now,
  });

  // peak: 每分钟最大请求数（最近 2 天）
  const peakPoints = await queryHubble({
    appKey: nginxAppKey,
    source: HUBBLE_NGINX_SOURCE,
    action: nginxAction,
    indicator: 'uriCount',
    aggregator: 'max',
    downsampler: '1m-max',
    tags,
    startTime,
    endTime: now,
  });

  const avgResult = computeTraffic(avgPoints);
  const peakResult = computeTraffic(peakPoints);
  return { avg: avgResult.avg, peak: peakResult.peak };
}

/**
 * 查询单个接口的流量（最近 2 天均值 + 峰值）
 */
export async function queryInterfaceTraffic(
  iface: DetectedInterface,
  appKey?: string,
): Promise<Pick<RegistryInterfaceRecord, 'traffic1dAvg' | 'traffic1dPeak'>> {
  if (!HUBBLE_API_KEY) {
    return { traffic1dAvg: 0, traffic1dPeak: 0 };
  }

  try {
    if (iface.type === 'moa' && appKey) {
      const result = await queryMoaTraffic(appKey, iface.interfaceUrl, iface.methodName);
      return { traffic1dAvg: result.avg, traffic1dPeak: result.peak };
    }

    if (iface.type === 'http') {
      const result = await queryHttpTraffic(iface.interfaceUrl);
      return { traffic1dAvg: result.avg, traffic1dPeak: result.peak };
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, url: iface.interfaceUrl }, '流量查询失败');
  }

  return { traffic1dAvg: 0, traffic1dPeak: 0 };
}

function findCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return '';
  let prefix = strs[0];
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i].startsWith(prefix)) {
      const lastSlash = prefix.lastIndexOf('/');
      if (lastSlash <= 0) return '/';
      prefix = prefix.substring(0, lastSlash);
    }
  }
  // 截断到最后一个 / 确保完整路径段
  const lastSlash = prefix.lastIndexOf('/');
  return lastSlash > 0 ? prefix.substring(0, lastSlash + 1) : prefix;
}

/** MOA 流量查询模式 */
type MoaQueryMode = 'consumer' | 'java_provider' | 'php_provider';

/**
 * 批量查询接口流量（MOA 全部走 bulk，每个 appKey 仅 2 次 Hubble 调用）
 *
 * MOA 查询策略（按优先级选择 appKey 和 source）：
 * 1. consumer 有单 appKey → consumer 侧 moa_client_aws（action="全部action"）
 * 2. provider 有 appKey 且为 Java/Kotlin → provider 侧 moa_aws（action="全部action"）
 * 3. provider 有 appKey 且为 PHP → provider 侧 php_aws + api_monitor（uri 通配符）
 * 4. 都没有 → traffic = 0
 */
export async function queryTrafficBatch(
  interfaces: DetectedInterface[],
  appKeyMap: Map<string, string>,
  appKeysMap?: Map<string, string[]>,
  repoLangMap?: Map<string, string>,
  concurrency = 5,
): Promise<RegistryInterfaceRecord[]> {
  if (!HUBBLE_API_KEY) {
    logger.info('未配置 HUBBLE_API_KEY，跳过流量查询，流量字段设为 0');
    return interfaces.map(iface => ({
      ...iface,
      traffic1dAvg: 0,
      traffic1dPeak: 0,
    }));
  }

  const results: RegistryInterfaceRecord[] = [];
  const httpInterfaces: DetectedInterface[] = [];

  // 按 "mode\0appKey" 聚合所有 MOA 接口（不再按 serviceUri 分组）
  const bulkGroups = new Map<string, { ifaces: DetectedInterface[]; appKey: string; mode: MoaQueryMode }>();

  for (const iface of interfaces) {
    if (iface.type !== 'moa') {
      httpInterfaces.push(iface);
      continue;
    }

    const consumerKey = appKeyMap.get(iface.fromRepoId);
    const consumerKeys = appKeysMap?.get(iface.fromRepoId);
    const providerKey = appKeyMap.get(iface.toRepoId);
    const providerLang = repoLangMap?.get(iface.toRepoId) ?? '';
    const isMultiKeyConsumer = consumerKeys && consumerKeys.length > 1;

    let appKey: string;
    let mode: MoaQueryMode;

    if (consumerKey && !isMultiKeyConsumer) {
      appKey = consumerKey;
      mode = 'consumer';
    } else if (providerKey && (providerLang === 'Java' || providerLang === 'Kotlin')) {
      appKey = providerKey;
      mode = 'java_provider';
    } else if (providerKey && providerLang === 'PHP') {
      appKey = providerKey;
      mode = 'php_provider';
    } else {
      if (isMultiKeyConsumer) {
        logger.warn(
          { fromRepo: iface.fromRepoId, toRepo: iface.toRepoId, serviceUri: iface.interfaceUrl },
          '多 appKey consumer 无法查找 provider appKey，流量设为 0（请确保已有全量注册表）',
        );
      }
      results.push({ ...iface, traffic1dAvg: 0, traffic1dPeak: 0 });
      continue;
    }

    const bulkKey = `${mode}\0${appKey}`;
    const existing = bulkGroups.get(bulkKey);
    if (existing) {
      existing.ifaces.push(iface);
    } else {
      bulkGroups.set(bulkKey, { ifaces: [iface], appKey, mode });
    }
  }

  // 统计查询分布
  const stats = { consumer: 0, java_provider: 0, php_provider: 0 };
  for (const group of Array.from(bulkGroups.values())) stats[group.mode]++;
  logger.info(
    {
      consumerBulks: stats.consumer,
      javaProviderBulks: stats.java_provider,
      phpProviderBulks: stats.php_provider,
      httpInterfaces: httpInterfaces.length,
      totalMoaMethods: interfaces.length - httpInterfaces.length,
      totalHubbleCalls: (stats.consumer + stats.java_provider + stats.php_provider) * 2,
    },
    'MOA 流量查询策略分配（bulk 模式，每 appKey 2 次调用）',
  );

  // 所有 MOA bulk 查询（每组只需 2 次 Hubble 调用）
  const bulkEntries = Array.from(bulkGroups.entries());
  for (const [, group] of bulkEntries) {
    try {
      let trafficMap: Map<string, TrafficResult>;

      if (group.mode === 'php_provider') {
        const serviceUris = Array.from(new Set(group.ifaces.map(i => i.interfaceUrl)));
        const commonPrefix = serviceUris.length > 0 ? findCommonPrefix(serviceUris) : '';
        trafficMap = await queryPhpMoaTrafficBulk(group.appKey, commonPrefix);
      } else {
        const source = group.mode === 'java_provider' ? 'moa_aws' : HUBBLE_MOA_SOURCE;
        trafficMap = await queryMoaTrafficBulk(group.appKey, source);
      }

      for (const iface of group.ifaces) {
        const key = `${iface.interfaceUrl}\0${iface.methodName ?? ''}`;
        const traffic = trafficMap.get(key);
        results.push({ ...iface, traffic1dAvg: traffic?.avg ?? 0, traffic1dPeak: traffic?.peak ?? 0 });
      }
    } catch {
      for (const iface of group.ifaces) {
        results.push({ ...iface, traffic1dAvg: 0, traffic1dPeak: 0 });
      }
    }
  }

  // HTTP 接口逐个查询
  const httpQueue = [...httpInterfaces];
  let running = 0;

  await new Promise<void>((resolve) => {
    function nextHttp(): void {
      if (httpQueue.length === 0 && running === 0) {
        resolve();
        return;
      }
      while (running < concurrency && httpQueue.length > 0) {
        const iface = httpQueue.shift()!;
        running++;
        const appKey = appKeyMap.get(iface.toRepoId);

        queryInterfaceTraffic(iface, appKey)
          .then((traffic) => {
            results.push({ ...iface, ...traffic });
          })
          .catch(() => {
            results.push({ ...iface, traffic1dAvg: 0, traffic1dPeak: 0 });
          })
          .finally(() => {
            running--;
            nextHttp();
          });
      }
    }
    nextHttp();
  });

  logger.info({ total: interfaces.length, queried: results.length }, '批量流量查询完成');
  return results;
}
