#!/usr/bin/env npx tsx
/**
 * 本地测试脚本：验证拓扑扫描的 API 检测 + appKey 提取
 * 扫描 behavior 和 user-service 两个仓库
 *
 * 用法: npx tsx scripts/test-topology-scan.ts
 * 带流量查询: HUBBLE_API_KEY=xxx npx tsx scripts/test-topology-scan.ts
 */

import { scanTopology } from '../packages/memory-service/src/tools/topology/scanner.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

const SCAN_ROOTS = [
  '/Users/jiaxintian/IdeaProjects/behavior',
  '/Users/jiaxintian/IdeaProjects/user-service',
];
const GIT_PATTERNS: string[] = []; // 不过滤，scanRoots 已精确指定

async function main() {
  const outputDir = join(tmpdir(), 'memforge-test-scan');
  mkdirSync(outputDir, { recursive: true });

  console.log('═══════════════════════════════════════════════════');
  console.log('拓扑扫描测试 — behavior + user-service');
  console.log('═══════════════════════════════════════════════════');
  console.log(`扫描目录: ${SCAN_ROOTS.join(', ')}`);
  console.log(`Git 过滤: ${GIT_PATTERNS.join(', ')}`);
  console.log(`输出目录: ${outputDir}`);
  console.log(`HUBBLE_API_KEY: ${process.env.HUBBLE_API_KEY ? '已配置' : '未配置（流量字段将为 0）'}`);
  console.log('');

  const result = await scanTopology({
    productLine: 'test-scan',
    scanRoots: SCAN_ROOTS,
    gitPatterns: GIT_PATTERNS,
    outputPath: outputDir,
    onProgress: (phase, detail, percent) => {
      console.log(`  [${percent}%] ${phase}: ${detail}`);
    },
  });

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('扫描结果概览');
  console.log('═══════════════════════════════════════════════════');
  console.log(`仓库数量: ${result.repoCount}`);
  console.log(`依赖边数: ${result.edgeCount}`);
  console.log(`注册表路径: ${result.filePath}`);

  // 输出仓库详情
  console.log('');
  console.log('── 仓库详情 ──');
  for (const [repoId, repo] of Object.entries(result.registry.repos)) {
    console.log(`\n  📦 ${repoId}`);
    console.log(`     语言: ${repo.lang} | 层: ${repo.layer} | 分组: ${repo.group}`);
    console.log(`     路径: ${repo.localPath}`);
    if (repo.appKey) {
      console.log(`     ✅ appKey: ${repo.appKey}`);
    }
    if (repo.dependencies && repo.dependencies.length > 0) {
      console.log(`     依赖数: ${repo.dependencies.length}`);
      const moaProviders = repo.dependencies.filter(d => d.type === 'moa_provider');
      const moaConsumers = repo.dependencies.filter(d => d.type === 'moa_consumer');
      if (moaProviders.length > 0) {
        console.log(`     MOA Provider: ${moaProviders.length} 条`);
        for (const p of moaProviders.slice(0, 5)) {
          const method = p.methodName ? `.${p.methodName}` : '';
          const httpPath = p.httpPath ? ` [HTTP: ${p.httpPath}]` : '';
          console.log(`       - ${p.serviceUri}${method}${httpPath}`);
        }
        if (moaProviders.length > 5) console.log(`       ... 还有 ${moaProviders.length - 5} 条`);
      }
      if (moaConsumers.length > 0) {
        console.log(`     MOA Consumer: ${moaConsumers.length} 条`);
        for (const c of moaConsumers.slice(0, 5)) {
          const method = c.methodName ? `.${c.methodName}` : '';
          console.log(`       - ${c.serviceUri}${method}`);
        }
        if (moaConsumers.length > 5) console.log(`       ... 还有 ${moaConsumers.length - 5} 条`);
      }
    }
  }

  // 输出接口级依赖
  if (result.registry.interfaces && result.registry.interfaces.length > 0) {
    console.log('');
    console.log('── 接口级依赖 (DetectedInterface) ──');
    console.log(`总计: ${result.registry.interfaces.length} 条`);
    for (const iface of result.registry.interfaces.slice(0, 20)) {
      const traffic = 'traffic1dAvg' in iface ? ` | 日均流量: ${(iface as any).traffic1dAvg}` : '';
      console.log(`  ${iface.type.toUpperCase()} | ${iface.fromRepoId} → ${iface.toRepoId}`);
      console.log(`    URL: ${iface.interfaceUrl}${iface.methodName ? '.' + iface.methodName : ''}${traffic}`);
    }
    if (result.registry.interfaces.length > 20) {
      console.log(`  ... 还有 ${result.registry.interfaces.length - 20} 条`);
    }
  } else {
    console.log('');
    console.log('⚠️ 未检测到接口级依赖 (interfaces 为空)');
  }

  // 输出 MOA 注册表
  if (result.registry.moaRegistry && result.registry.moaRegistry.length > 0) {
    console.log('');
    console.log('── MOA 注册表 (MoaRegistryEntry) ──');
    console.log(`总计: ${result.registry.moaRegistry.length} 条`);
    for (const entry of result.registry.moaRegistry) {
      console.log(`  ${entry.serviceUri} → ${entry.repoId} (confidence: ${entry.confidence})`);
      if (entry.providerFile) console.log(`    文件: ${entry.providerFile}`);
    }
  }

  // 输出边关系
  if (result.registry.edges && result.registry.edges.length > 0) {
    console.log('');
    console.log('── 依赖边 (Edges) ──');
    for (const edge of result.registry.edges) {
      console.log(`  ${edge.from} → ${edge.to} [${edge.label}] (confidence: ${edge.confidence})`);
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('测试完成！');
  console.log(`完整注册表 JSON: ${result.filePath}`);
  console.log('═══════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('扫描失败:', err);
  process.exit(1);
});
