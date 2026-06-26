// Created by dev on 2026/04/07
// Copyright © 2026
// 基础设施依赖检测 — 从配置文件中提取 MySQL/Redis/Kafka 等依赖

import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '@memforgeai/shared';

const logger = getLogger('infra-detection');

export interface InfraEntry {
  type: 'mysql' | 'redis' | 'kafka' | 'momostore';
  cluster?: string;
  host?: string;
  port?: string;
  database?: string;
  env: string;
  source: string;
}

export interface InfraResult {
  items: InfraEntry[];
  serverPort?: string;
}

function inferEnvFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes('alpha') || lower.includes('test')) return 'alpha';
  if (lower.includes('stage')) return 'stage';
  if (lower.includes('prod') || lower.includes('online')) return 'prod';
  if (lower.includes('ue1')) return 'ue1';
  if (lower.includes('sg')) return 'sg';
  return 'default';
}

function detectJavaInfra(repoPath: string): InfraResult {
  const items: InfraEntry[] = [];
  let serverPort: string | undefined;

  const resourceDirs = [
    path.join(repoPath, 'src', 'main', 'resources'),
    ...findModuleResourceDirs(repoPath),
  ];

  const seenMysql = new Set<string>();
  const seenRedis = new Set<string>();
  const seenMomostore = new Set<string>();

  for (const dir of resourceDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = listConfigFiles(dir, ['yml', 'yaml', 'properties']);

    for (const file of files) {
      const env = inferEnvFromFilename(file);
      const relSource = path.relative(repoPath, file);
      let content: string;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      // MySQL: jdbc:mysql://host:port/db
      const jdbcMatches = content.matchAll(/jdbc:mysql:\/\/([^:/]+)(?::(\d+))?\/([^\s?]+)/g);
      for (const m of jdbcMatches) {
        const key = `${m[1]}:${m[3]}:${env}`;
        if (seenMysql.has(key)) continue;
        seenMysql.add(key);
        items.push({ type: 'mysql', host: m[1], port: m[2] ?? '3306', database: m[3], env, source: relSource });
      }

      // Momostore datasource（特定产品线的 Java 存储组件）
      const momostoreMatches = content.matchAll(/datasource-name:\s*(\S+)/g);
      for (const m of momostoreMatches) {
        const dsName = m[1];
        const key = `${dsName}:${env}`;
        if (seenMomostore.has(key)) continue;
        seenMomostore.add(key);
        const infraType = dsName.toLowerCase().includes('redis') ? 'redis' as const : 'momostore' as const;
        items.push({ type: infraType, cluster: dsName, env, source: relSource });
      }

      // Redis: redis.host / spring.redis.host
      const redisHostMatch = content.match(/redis[.\w-]*\.host\s*[:=]\s*(\S+)/);
      const redisPortMatch = content.match(/redis[.\w-]*\.port\s*[:=]\s*(\S+)/);
      if (redisHostMatch) {
        const host = redisHostMatch[1].replace(/['"]/g, '');
        const port = redisPortMatch?.[1]?.replace(/['"]/g, '') ?? '6379';
        const key = `${host}:${port}:${env}`;
        if (!seenRedis.has(key)) {
          seenRedis.add(key);
          items.push({ type: 'redis', host, port, env, source: relSource });
        }
      }

      // Kafka: spring.kafka.bootstrap-servers
      const kafkaMatch = content.match(/kafka[.\w-]*bootstrap[.\w-]*servers?\s*[:=]\s*(\S+)/);
      if (kafkaMatch) {
        items.push({ type: 'kafka', host: kafkaMatch[1].replace(/['"]/g, ''), env, source: relSource });
      }

      // KafkaListener 注解中的 topic
      const listenerMatches = content.matchAll(/@KafkaListener\s*\([^)]*topics?\s*=\s*["{]([^}"]+)[}"]/g);
      for (const m of listenerMatches) {
        items.push({ type: 'kafka', cluster: m[1], env: 'topic', source: relSource });
      }

      // Server port
      if (!serverPort) {
        const portMatch = content.match(/server\.port\s*[:=]\s*(\d+)/);
        if (portMatch) serverPort = portMatch[1];
      }
    }
  }
  return { items, serverPort };
}

function detectPhpInfra(repoPath: string): InfraResult {
  const items: InfraEntry[] = [];
  const configDirs = ['config', 'app/config', 'conf'].map(d => path.join(repoPath, d));

  const seenMysql = new Set<string>();
  const seenRedis = new Set<string>();

  for (const dir of configDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = listConfigFiles(dir, ['php']);

    for (const file of files) {
      const env = inferEnvFromFilename(file);
      const relSource = path.relative(repoPath, file);
      let content: string;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      // PDO DSN: mysql:host=xxx;port=xxx;dbname=xxx
      const pdoMatches = content.matchAll(/mysql:host=([^;]+);(?:port=(\d+);)?dbname=([^\s'"]+)/g);
      for (const m of pdoMatches) {
        const key = `${m[1]}:${m[3]}:${env}`;
        if (seenMysql.has(key)) continue;
        seenMysql.add(key);
        items.push({ type: 'mysql', host: m[1], port: m[2] ?? '3306', database: m[3], env, source: relSource });
      }

      // PHP array config: 'host' => 'xxx', 'database'/'dbname' => 'xxx'
      const hostMatch = content.match(/['"]host['"]\s*=>\s*['"]([^'"]+)['"]/);
      const dbMatch = content.match(/['"](?:database|dbname)['"]\s*=>\s*['"]([^'"]+)['"]/);
      if (hostMatch && dbMatch) {
        const key = `${hostMatch[1]}:${dbMatch[1]}:${env}`;
        if (!seenMysql.has(key)) {
          seenMysql.add(key);
          items.push({ type: 'mysql', host: hostMatch[1], database: dbMatch[1], env, source: relSource });
        }
      }

      // Redis: 'host' => 'redis...'
      const redisMatches = content.matchAll(/['"]host['"]\s*=>\s*['"]([^'"]*redis[^'"]*)['"]/gi);
      for (const m of redisMatches) {
        const key = `${m[1]}:${env}`;
        if (seenRedis.has(key)) continue;
        seenRedis.add(key);
        items.push({ type: 'redis', host: m[1], env, source: relSource });
      }
    }
  }
  return { items };
}

export function detectInfra(repoPath: string, lang: string): InfraResult {
  try {
    if (lang === 'Java' || lang === 'Kotlin') {
      return detectJavaInfra(repoPath);
    }
    if (lang === 'PHP') {
      return detectPhpInfra(repoPath);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, repoPath }, '基础设施检测失败');
  }
  return { items: [] };
}

function findModuleResourceDirs(repoPath: string): string[] {
  const dirs: string[] = [];
  try {
    const entries = fs.readdirSync(repoPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'target') continue;
      const candidate = path.join(repoPath, e.name, 'src', 'main', 'resources');
      if (fs.existsSync(candidate)) dirs.push(candidate);
    }
  } catch { /* 忽略 */ }
  return dirs;
}

function listConfigFiles(dir: string, extensions: string[]): string[] {
  const result: string[] = [];
  const extSet = new Set(extensions);
  try {
    walkDir(dir, result, extSet, 0);
  } catch { /* 忽略 */ }
  return result;
}

function walkDir(dir: string, result: string[], extSet: Set<string>, depth: number): void {
  if (depth > 3) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && !e.name.startsWith('.')) {
      walkDir(full, result, extSet, depth + 1);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (extSet.has(ext)) result.push(full);
    }
  }
}
