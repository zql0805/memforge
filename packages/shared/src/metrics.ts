// Created by dev on 2026/04/05
// Copyright © 2026
// 可观测性指标收集 — Prometheus 兼容格式输出
// 轻量自研实现，不引入 prom-client 依赖

import { getLogger } from './logger.js';

const logger = getLogger('metrics');

interface CounterData {
  type: 'counter';
  help: string;
  labels: Map<string, number>;
}

interface HistogramData {
  type: 'histogram';
  help: string;
  buckets: number[];
  labels: Map<string, { count: number; sum: number; bucketCounts: number[] }>;
}

interface GaugeData {
  type: 'gauge';
  help: string;
  labels: Map<string, number>;
}

type MetricData = CounterData | HistogramData | GaugeData;

class MetricsRegistry {
  private readonly metrics = new Map<string, MetricData>();

  counter(name: string, help: string): Counter {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, { type: 'counter', help, labels: new Map() });
    }
    return new Counter(name, this.metrics.get(name) as CounterData);
  }

  histogram(name: string, help: string, buckets?: number[]): Histogram {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, {
        type: 'histogram',
        help,
        buckets: buckets ?? [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
        labels: new Map(),
      });
    }
    return new Histogram(name, this.metrics.get(name) as HistogramData);
  }

  gauge(name: string, help: string): Gauge {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, { type: 'gauge', help, labels: new Map() });
    }
    return new Gauge(name, this.metrics.get(name) as GaugeData);
  }

  /** 输出 Prometheus text exposition 格式 */
  serialize(): string {
    const lines: string[] = [];

    for (const [name, data] of this.metrics) {
      lines.push(`# HELP ${name} ${data.help}`);
      lines.push(`# TYPE ${name} ${data.type}`);

      if (data.type === 'counter' || data.type === 'gauge') {
        for (const [labelKey, value] of data.labels) {
          if (labelKey === '') {
            lines.push(`${name} ${value}`);
          } else {
            lines.push(`${name}{${labelKey}} ${value}`);
          }
        }
      } else if (data.type === 'histogram') {
        for (const [labelKey, hist] of data.labels) {
          const prefix = labelKey ? `${name}{${labelKey},` : `${name}{`;
          let cumulative = 0;
          for (let i = 0; i < data.buckets.length; i++) {
            cumulative += hist.bucketCounts[i];
            lines.push(`${prefix}le="${data.buckets[i]}"} ${cumulative}`);
          }
          lines.push(`${prefix}le="+Inf"} ${hist.count}`);
          const sumLabel = labelKey ? `{${labelKey}}` : '';
          lines.push(`${name}_sum${sumLabel} ${hist.sum}`);
          lines.push(`${name}_count${sumLabel} ${hist.count}`);
        }
      }
    }

    return lines.join('\n') + '\n';
  }
}

class Counter {
  constructor(private readonly name: string, private readonly data: CounterData) {}

  inc(labels: Record<string, string> = {}, value = 1): void {
    const key = labelsToKey(labels);
    const current = this.data.labels.get(key) ?? 0;
    this.data.labels.set(key, current + value);
  }
}

class Histogram {
  constructor(private readonly name: string, private readonly data: HistogramData) {}

  observe(labels: Record<string, string> = {}, value: number): void {
    const key = labelsToKey(labels);
    let hist = this.data.labels.get(key);
    if (!hist) {
      hist = { count: 0, sum: 0, bucketCounts: new Array(this.data.buckets.length).fill(0) };
      this.data.labels.set(key, hist);
    }
    hist.count++;
    hist.sum += value;
    for (let i = 0; i < this.data.buckets.length; i++) {
      if (value <= this.data.buckets[i]) {
        hist.bucketCounts[i]++;
      }
    }
  }
}

class Gauge {
  constructor(private readonly name: string, private readonly data: GaugeData) {}

  set(labels: Record<string, string> = {}, value: number): void {
    const key = labelsToKey(labels);
    this.data.labels.set(key, value);
  }

  inc(labels: Record<string, string> = {}, value = 1): void {
    const key = labelsToKey(labels);
    const current = this.data.labels.get(key) ?? 0;
    this.data.labels.set(key, current + value);
  }

  dec(labels: Record<string, string> = {}, value = 1): void {
    const key = labelsToKey(labels);
    const current = this.data.labels.get(key) ?? 0;
    this.data.labels.set(key, current - value);
  }
}

function labelsToKey(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}="${v}"`).join(',');
}

// ─── 全局单例和预定义指标 ────────────────────────

export const registry = new MetricsRegistry();

export const mcpRequestDuration = registry.histogram(
  'memforge_mcp_request_duration_ms',
  'MCP 请求处理耗时（毫秒）',
  [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
);

export const mcpRequestTotal = registry.counter(
  'memforge_mcp_request_total',
  'MCP 请求总数',
);

export const mcpRequestErrors = registry.counter(
  'memforge_mcp_request_errors_total',
  'MCP 请求错误总数',
);

export const authAttempts = registry.counter(
  'memforge_auth_attempts_total',
  '认证尝试总数',
);

export const rateLimitHits = registry.counter(
  'memforge_rate_limit_hits_total',
  '速率限制触发次数',
);

export const cacheHits = registry.counter(
  'memforge_cache_hits_total',
  '缓存命中次数',
);

export const cacheMisses = registry.counter(
  'memforge_cache_misses_total',
  '缓存未命中次数',
);

export const activeConnections = registry.gauge(
  'memforge_active_connections',
  '当前活跃连接数',
);

export { Counter, Histogram, Gauge, MetricsRegistry };
