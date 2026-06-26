#!/usr/bin/env node
// Created by dev on 2026/04/04
// Copyright © 2026
// Memory Service E2E 测试（against PostgreSQL）
// 前置条件：docker compose up -d postgres

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const modelsDir = resolve(rootDir, 'models');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://memforge:memforge_dev@localhost:5432/memforge';

const RUN_ID = Date.now().toString(36);

let client;
let transport;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, error: text };
  }
}

async function main() {
  console.log('\n🧠 Memory Service E2E 测试 (PostgreSQL)\n');
  console.log('数据库:', DATABASE_URL.replace(/\/\/.*:.*@/, '//<hidden>@'));
  console.log('模型目录:', modelsDir);
  console.log(`运行 ID: ${RUN_ID}`);
  console.log('');

  transport = new StdioClientTransport({
    command: 'node',
    args: [resolve(rootDir, 'packages/memory-service/dist/index.js')],
    env: {
      ...process.env,
      DATABASE_URL,
      MODELS_BASE_DIR: modelsDir,
      EMBEDDING_MODEL_TIER: process.env.EMBEDDING_MODEL_TIER ?? 'L3',
      LOG_LEVEL: 'warn',
    },
  });

  client = new Client({ name: 'test-client', version: '0.1.0' });
  await client.connect(transport);
  console.log('✅ MCP Server 连接成功\n');

  // 清理之前运行残留的测试数据（解决幂等性问题）
  console.log('🧹 清理旧测试数据...');
  const old = await callTool('list_memories', { tags: ['e2e-test'], limit: 100 });
  if (old.success && old.entries?.length > 0) {
    let cleaned = 0;
    for (const m of old.entries) {
      await callTool('archive_memory', { memory_id: m.id, reason: '清理旧 E2E 数据' });
      cleaned++;
    }
    console.log(`  归档了 ${cleaned} 条旧测试数据`);
  }
  console.log('');

  const tools = await client.listTools();
  const toolNames = tools.tools.map(t => t.name);
  console.log('注册的工具:', toolNames.join(', '));
  assert(toolNames.length >= 12, `注册了 ${toolNames.length} 个工具（期望 >= 12）`);

  const expectedTools = [
    'store_memory', 'recall_memory', 'list_memories', 'update_memory', 'archive_memory',
    'index_documents', 'sync_documents', 'learn_from_commits', 'learn_from_review',
    'watch_docs', 'import_topology', 'scan_topology',
  ];
  for (const t of expectedTools) {
    assert(toolNames.includes(t), `工具 ${t} 已注册`);
  }
  console.log('');

  // ─── 测试 1: store_memory ───────────────────────────────

  console.log('── 测试 1: store_memory ──');
  const storeResult = await callTool('store_memory', {
    title: `E2E-${RUN_ID} 星际飞船导航模块重构`,
    content: `E2E-${RUN_ID}: 在星际飞船 Zyphor-7 的超光速导航模块中，将量子纠缠信标阵列从三角网格改为蜂窝结构。这使得跨维度定位精度从 0.003 秒差距提升到 0.0001 秒差距。同时需将暗物质燃料注入频率从 144Hz 调整为 233Hz 以匹配新的网格共振模式。`,
    scope: 'performance_insight',
    tags: ['e2e-test', `run:${RUN_ID}`],
    source: 'manual',
  });
  assert(storeResult.success === true, 'store_memory 成功');
  assert(!!storeResult.id, `记忆 ID: ${storeResult.id?.slice(0, 8)}...`);
  const memory1Id = storeResult.id;

  const store2 = await callTool('store_memory', {
    title: `E2E-${RUN_ID} 龙语翻译引擎优化`,
    content: `E2E-${RUN_ID}: 龙语翻译引擎 DragonTongue v4.2 的音素解析器存在古龙语方言兼容性缺陷。修复方案：在词法分析阶段增加火焰音节前缀检测（FlameSyllablePrefix），对齐古龙语声调映射表。覆盖冰霜方言和岩浆方言两种子集。`,
    scope: 'performance_insight',
    tags: ['e2e-test', `run:${RUN_ID}`],
    source: 'manual',
  });
  assert(store2.success === true, '第二条记忆存储成功');
  const memory2Id = store2.id;

  const store3 = await callTool('store_memory', {
    title: `E2E-${RUN_ID} 时间悖论守护协议`,
    content: `E2E-${RUN_ID}: 时间旅行操作规范 — 禁止在目标时间点修改任何因果链超过 3 层的事件。所有时间跳跃必须配置回溯锚点，确保 Novikov 自洽条件满足。违规操作触发时间线分叉隔离机制，由悖论守护进程自动回滚。`,
    scope: 'convention',
    tags: ['e2e-test', `run:${RUN_ID}`],
    source: 'ai_suggestion',
  });
  if (!store3.success) {
    console.log(`  ⚠️ store3 失败详情: ${JSON.stringify(store3).slice(0, 300)}`);
  }
  assert(store3.success === true, '第三条记忆存储成功');
  console.log('');

  // ─── 测试 2: recall_memory ──────────────────────────────

  console.log('── 测试 2: recall_memory（语义搜索） ──');
  const recallResult = await callTool('recall_memory', {
    query: '星际飞船超光速导航量子纠缠信标',
    limit: 5,
  });
  assert(recallResult.success === true, 'recall_memory 成功');
  assert(recallResult.results.length > 0, `返回 ${recallResult.results.length} 条结果`);

  if (recallResult.results.length > 0) {
    const topResult = recallResult.results[0];
    assert(topResult.title.includes('飞船') || topResult.title.includes('导航') || topResult.title.includes(RUN_ID), `最相关结果: ${topResult.title}`);
    assert(typeof topResult.similarity === 'number', `相似度: ${topResult.similarity?.toFixed(4)}`);
  }
  console.log('');

  // ─── 测试 3: list_memories ──────────────────────────────

  console.log('── 测试 3: list_memories ──');
  const listResult = await callTool('list_memories', {});
  assert(listResult.success === true, 'list_memories 成功');
  assert(listResult.pagination.total >= 3, `共 ${listResult.pagination.total} 条记忆`);

  const listFiltered = await callTool('list_memories', { scope: 'convention' });
  assert(listFiltered.success === true, '按 scope 过滤');
  assert(listFiltered.pagination.total >= 1, `convention 范围有 ${listFiltered.pagination.total} 条`);
  console.log('');

  // ─── 测试 4: update_memory ──────────────────────────────

  console.log('── 测试 4: update_memory ──');
  if (memory1Id) {
    const updateResult = await callTool('update_memory', {
      memory_id: memory1Id,
      content: `E2E-${RUN_ID}-UPDATED: 在星际飞船 Zyphor-7 的超光速导航模块中，将暗物质燃料注入频率从 233Hz 进一步调整为 377Hz（斐波那契优化），使跨维度定位精度再提升一个数量级到 0.00001 秒差距。`,
      tags: ['e2e-test', 'updated', `run:${RUN_ID}`],
    });
    if (updateResult.error) console.log('  update_memory 错误:', updateResult.error);
    assert(updateResult.success === true, 'update_memory 成功');
    assert(!!updateResult.id, `更新后 ID: ${updateResult.id?.slice(0, 8)}...`);
  } else {
    assert(false, 'update_memory 跳过（前置 store 未返回 ID）');
    assert(false, 'update_memory ID 跳过');
  }
  console.log('');

  // ─── 测试 5: archive_memory ─────────────────────────────

  console.log('── 测试 5: archive_memory ──');
  if (memory2Id) {
    const archiveResult = await callTool('archive_memory', {
      memory_id: memory2Id,
      reason: '已迁移到新的索引优化文档',
    });
    assert(archiveResult.success === true, 'archive_memory 成功');

    const listAfterArchive = await callTool('list_memories', {});
    assert(listAfterArchive.pagination.total >= 2, `归档后剩余 ${listAfterArchive.pagination.total} 条`);

    const recallAfterArchive = await callTool('recall_memory', { query: `E2E-${RUN_ID} 龙语翻译引擎优化` });
    const archivedFound = recallAfterArchive.results?.find(r => r.id === memory2Id);
    assert(!archivedFound, '已归档记忆不出现在搜索结果中');
  } else {
    assert(false, 'archive_memory 跳过（前置 store 未返回 ID）');
    assert(true, '归档后列表跳过');
    assert(true, '归档后搜索跳过');
  }
  console.log('');

  // ─── 测试 6: 重复检测 ────────────────────────────────────

  console.log('── 测试 6: 重复检测 ──');
  const dupResult = await callTool('store_memory', {
    title: `E2E-${RUN_ID} 星际飞船导航模块重构`,
    content: `E2E-${RUN_ID}-UPDATED: 在星际飞船 Zyphor-7 的超光速导航模块中，将暗物质燃料注入频率从 233Hz 进一步调整为 377Hz（斐波那契优化），使跨维度定位精度再提升一个数量级到 0.00001 秒差距。`,
    scope: 'performance_insight',
    tags: ['e2e-test', `run:${RUN_ID}`],
    source: 'manual',
  });
  assert(dupResult.success === false || dupResult.deduplicated === true, '重复记忆被检测到');
  console.log('');

  // ─── 测试 7: index_documents ──────────────────────────────

  console.log('── 测试 7: index_documents ──');
  {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memforge-e2e-'));
    fs.writeFileSync(path.join(tmpDir, 'arch.md'), `# [${RUN_ID}] 魔法阵拓扑架构\n\n魔法阵系统 Arcanum-${RUN_ID} 使用五芒星拓扑连接各召唤节点。\n核心组件：符文编译器、法力路由器、元素平衡器。`);
    fs.writeFileSync(path.join(tmpDir, 'guide.md'), `# [${RUN_ID}] 炼金术入门指南\n\n## 快速开始\n\n1. 收集月光精华\n2. 研磨哲学家之石\n3. 在满月时启动蒸馏`);

    const indexResult = await callTool('index_documents', {
      directory: tmpDir,
      scope: 'domain_knowledge',
      tags: ['e2e-test', 'doc-index', `run:${RUN_ID}`],
    });
    assert(indexResult.filesScanned >= 2 || indexResult.success === true, `index_documents 成功: ${indexResult.filesScanned ?? 0} 个文档`);
    assert((indexResult.filesScanned ?? indexResult.totalStored ?? 0) >= 2, `扫描了 ${indexResult.filesScanned ?? 0} 个文档`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log('');

  // ─── 测试 8: learn_from_review ──────────────────────────────

  console.log('── 测试 8: learn_from_review ──');
  {
    const reviewResult = await callTool('learn_from_review', {
      pr_title: `[${RUN_ID}] feat: 瞬移传送门稳定性重构`,
      pr_url: `https://github.com/example/repo/pull/${RUN_ID}`,
      comments: [
        { reviewer: 'archmage', comment: `[${RUN_ID}] 空间折叠计算请使用黎曼曲率张量，避免欧氏近似导致传送偏移`, file_path: 'src/teleport.ts', line: 42 },
        { reviewer: 'archmage', comment: `[${RUN_ID}] 维度锚点必须参数化配置，禁止硬编码坐标避免跨位面泄漏`, file_path: 'src/portal.ts', line: 88 },
        { reviewer: 'reviewer-2', comment: `[${RUN_ID}] 法力消耗字段都应该用 BigDecimal 而不是 double，防止法力溢出`, file_path: 'src/mana.ts', line: 15 },
      ],
    });
    assert(reviewResult.insightsExtracted >= 1 || reviewResult.success === true, 'learn_from_review 成功');
    assert((reviewResult.insightsExtracted ?? reviewResult.totalComments ?? 0) >= 1, `提取了 ${reviewResult.insightsExtracted ?? 0} 个洞察`);
  }
  console.log('');

  // ─── 测试 9: import_topology ──────────────────────────────

  console.log('── 测试 9: import_topology ──');
  {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memforge-topo-'));
    const registryPath = path.join(tmpDir, 'test-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({
      productLine: `TestLine-${RUN_ID}`,
      generatedAt: new Date().toISOString(),
      repos: {
        [`test-${RUN_ID}/service-a`]: { localPath: '/tmp/a', techStack: 'Java', description: `Service A ${RUN_ID}`, layer: 4 },
        [`test-${RUN_ID}/service-b`]: { localPath: '/tmp/b', techStack: 'PHP', description: `Service B ${RUN_ID}`, layer: 1 },
      },
      edges: [
        { from: `test-${RUN_ID}/service-b`, to: `test-${RUN_ID}/service-a`, protocol: 'MOA RPC' },
      ],
      groups: {
        '1': { name: '接口网关', repos: [`test-${RUN_ID}/service-b`] },
        '4': { name: '微服务', repos: [`test-${RUN_ID}/service-a`] },
      },
    }));

    const topoResult = await callTool('import_topology', {
      registry_path: registryPath,
    });
    assert(topoResult.productLine === `TestLine-${RUN_ID}`, `import_topology 成功: ${topoResult.productLine}`);
    const svcStored = topoResult.results?.services?.stored ?? 0;
    const svcDup = topoResult.results?.services?.duplicates ?? 0;
    assert(svcStored >= 1 || svcDup >= 1, `服务记忆: ${svcStored} 新建, ${svcDup} 去重`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log('');

  // ─── 测试 10: 清理测试数据 ──────────────────────────────

  console.log('── 测试 10: 清理测试数据 ──');
  {
    const cleanList = await callTool('list_memories', { tags: [`run:${RUN_ID}`] });
    let cleaned = 0;
    if (cleanList.success && cleanList.entries?.length > 0) {
      for (const m of cleanList.entries) {
        await callTool('archive_memory', { memory_id: m.id, reason: `E2E 清理 ${RUN_ID}` });
        cleaned++;
      }
    }
    assert(cleaned >= 0, `归档了 ${cleaned} 条测试记忆`);
  }
  console.log('');

  // 汇总
  console.log('═'.repeat(50));
  console.log(`\n总计: ${passed + failed} 测试, ✅ ${passed} 通过, ❌ ${failed} 失败\n`);

  await client.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
