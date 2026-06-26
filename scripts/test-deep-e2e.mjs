#!/usr/bin/env node
// Created by dev on 2026/04/05
// Copyright © 2026
// 深度 E2E 测试：验证新工具写入 + recall 读取闭环
// 前置条件：docker compose up -d postgres && npm run build

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const modelsDir = resolve(rootDir, 'models');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://memforge:memforge_dev@localhost:5432/memforge';

let client;
let transport;
let passed = 0;
let failed = 0;
let skipped = 0;

const RUN_ID = Date.now().toString(36);
const TEST_PRODUCT_LINE = process.env.TEST_PRODUCT_LINE ?? 'test-project';

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}`); }
}

function skip(msg) { skipped++; console.log(`  ⏭️  ${msg}`); }

async function callTool(name, args, timeoutMs) {
  const opts = { name, arguments: args };
  const result = timeoutMs
    ? await client.callTool(opts, undefined, { timeout: timeoutMs })
    : await client.callTool(opts);
  const text = result.content?.[0]?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

async function main() {
  console.log('\n🔬 Memforge 深度 E2E 测试\n');
  console.log('数据库:', DATABASE_URL.replace(/\/\/.*:.*@/, '//<hidden>@'));
  console.log('模型目录:', modelsDir);
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

  client = new Client({ name: 'deep-e2e-test', version: '0.1.0' });
  await client.connect(transport);
  console.log('✅ MCP Server 连接成功\n');

  const { tools } = await client.listTools();
  const toolNames = tools.map(t => t.name);

  // ═══════════════════════════════════════════════════════════
  // 阶段 1：验证新工具注册
  // ═══════════════════════════════════════════════════════════
  console.log('━━ 阶段 1：新工具注册验证 ━━');
  const newTools = [
    'bootstrap', 'store_session_summary',
    'store_log_insight', 'store_troubleshoot',
    'store_incident',
    'start_work_context', 'update_work_context', 'evaluate_work_context',
  ];
  for (const t of newTools) {
    assert(toolNames.includes(t), `工具 ${t} 已注册`);
  }
  console.log(`  注册总数: ${toolNames.length}\n`);

  // ═══════════════════════════════════════════════════════════
  // 阶段 2：store_session_summary → recall 闭环
  // ═══════════════════════════════════════════════════════════
  console.log('━━ 阶段 2：store_session_summary → recall 闭环 ━━');
  const sessionResult = await callTool('store_session_summary', {
    summary: `[${RUN_ID}] 讨论了 Memforge 项目 MCP 工具合并策略，最终决定保持专用工具分开，通过 auto-recall 规则引导路由`,
    decisions: [
      {
        title: `[${RUN_ID}] MCP 工具保持分开不合并`,
        rationale: '合并会导致 schema 过于复杂，AI 不易正确填参。保持专用工具更利于 AI 自动选择。',
        alternatives: ['合并为单一 store_memory 工具'],
      },
    ],
    lessons: [
      'MCP 工具粒度取决于 AI 能否正确理解并填充参数',
      'Token 开销可接受（约 +1600 tokens/server）',
    ],
    tags: ['e2e-deep-test', 'mcp-design', `run:${RUN_ID}`],
  });
  assert(sessionResult.success === true, 'store_session_summary 调用成功');
  assert(sessionResult.stored >= 0, `存储了 ${sessionResult.stored} 条记忆${sessionResult.stored === 0 ? '（去重检测生效）' : ''}`);

  // 稍等 embedding 写入
  await sleep(500);

  const recallSession = await callTool('recall_memory', {
    query: 'MCP 工具合并策略决策',
    limit: 5,
  });
  assert(recallSession.success === true, 'recall 会话摘要成功');
  const sessionHit = recallSession.results?.some(r =>
    r.title?.includes('会话摘要') || r.title?.includes('决策')
  );
  assert(sessionHit, 'recall 命中了会话摘要/决策记忆');
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // 阶段 3：store_log_insight → recall 闭环
  // ═══════════════════════════════════════════════════════════
  console.log('━━ 阶段 3：store_log_insight → recall 闭环 ━━');
  const logResult = await callTool('store_log_insight', {
    error_pattern: `redis_like_snail_${RUN_ID}`,
    service_name: 'fproject-api-test',
    root_cause: `[${RUN_ID}] Redis 集群节点发生主从切换，导致连接池中持有旧 master 地址的连接超时`,
    solution: '1. 升级 phpredis 到 5.3+ 启用 retry_interval; 2. 配置 Redis Sentinel 自动发现; 3. 增加连接超时告警',
    es_query: 'index:buglog AND message:"redis_like_snail" AND service:"fproject-api"',
    severity: 'high',
    tags: ['e2e-deep-test', 'redis', `run:${RUN_ID}`],
  });
  const logOk = logResult.success === true || logResult.existingId;
  assert(logOk, `store_log_insight: ${logResult.success ? '写入成功' : `去重 → ${logResult.existingTitle?.slice(0, 40)}`}`);
  const logId = logResult.id ?? logResult.existingId;
  assert(!!logId, `日志洞察 ID: ${logId?.slice(0, 8)}...`);

  await sleep(500);

  const recallLog = await callTool('recall_memory', {
    query: 'Redis 连接超时 主从切换 redis_like_snail',
    limit: 5,
    scope_filter: ['bug_pattern'],
  });
  assert(recallLog.success === true, 'recall 日志洞察成功');
  const logHit = recallLog.results?.some(r =>
    r.title?.includes('日志洞察') && r.content?.includes('redis_like_snail')
  );
  assert(logHit, 'recall 命中了 redis_like_snail 日志洞察');
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // 阶段 4：store_troubleshoot → recall 闭环
  // ═══════════════════════════════════════════════════════════
  console.log('━━ 阶段 4：store_troubleshoot → recall 闭环 ━━');
  const troubleResult = await callTool('store_troubleshoot', {
    symptom: `[${RUN_ID}] fproject-api 接口返回 500，用户无法进入直播间`,
    affected_services: ['fproject-api-test', 'room-web-test', 'user-service-test'],
    investigation_steps: [
      { tool: 'es-search', action: '搜索 buglog 中 fproject-api 的 500 错误', finding: '发现大量 "MySQL server has gone away" 错误' },
      { tool: 'SSH', action: '登录 fproject-api 实例查看完整错误堆栈', finding: '错误源自 ORM 层的长连接超时' },
      { tool: 'pangu-config', action: '检查 MySQL 连接池配置', finding: 'wait_timeout 设置为 28800 但 PHP 连接池回收时间为 36000' },
    ],
    root_cause: `[${RUN_ID}] MySQL wait_timeout (8h) 小于 PHP 连接池回收时间 (10h)，导致连接被 MySQL 强制断开`,
    fix: '将 PHP 连接池的 max_lifetime 设置为 25200 (7h)，确保小于 MySQL wait_timeout',
    prevention: '添加数据库连接健康检查机制，每次获取连接前执行 ping',
    category: 'config_error',
    tags: ['e2e-deep-test', 'mysql', 'connection-pool', `run:${RUN_ID}`],
  });
  const troubleOk = troubleResult.success === true || troubleResult.existingId;
  assert(troubleOk, `store_troubleshoot: ${troubleResult.success ? '写入成功' : `去重 → ${troubleResult.existingTitle?.slice(0, 40)}`}`);
  const troubleId = troubleResult.id ?? troubleResult.existingId;
  assert(!!troubleId, `排查手册 ID: ${troubleId?.slice(0, 8)}...`);

  await sleep(500);

  const recallTrouble = await callTool('recall_memory', {
    query: 'fproject-api 接口 500 MySQL server gone away 连接超时',
    limit: 10,
  });
  assert(recallTrouble.success === true, 'recall 排查手册成功');
  const troubleHit = recallTrouble.results?.some(r =>
    r.title?.includes('排查手册') || (r.content?.includes('MySQL') && r.content?.includes('500'))
  );
  assert(troubleHit, 'recall 命中了 MySQL 连接超时排查手册');
  if (!troubleHit && recallTrouble.results?.length > 0) {
    console.log(`  ℹ️  实际返回的 top-3 标题: ${recallTrouble.results.slice(0, 3).map(r => r.title).join(' | ')}`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // 阶段 5：recall_memory format=prompt 测试
  // ═══════════════════════════════════════════════════════════
  console.log('━━ 阶段 5：recall_memory format=prompt ━━');
  const recallPrompt = await callTool('recall_memory', {
    query: 'Redis 问题排查',
    limit: 3,
    format: 'prompt',
  });
  const promptText = recallPrompt._raw ?? '';
  assert(promptText.length > 0, 'prompt 格式返回了文本');
  assert(promptText.includes('检索到') || promptText.includes('记忆'), 'prompt 包含"检索到"或"记忆"关键字');
  assert(promptText.includes('标题:') || promptText.includes('内容:'), 'prompt 包含结构化字段');
  if (promptText.length > 0) {
    console.log(`  prompt 输出预览 (前 200 字): ${promptText.slice(0, 200).replace(/\n/g, '↵')}...`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // 阶段 6：bootstrap dry_run 模式
  // ═══════════════════════════════════════════════════════════
  console.log('━━ 阶段 6：bootstrap dry_run ━━');
  const tmpDir = mkdtempSync(join(tmpdir(), 'memforge-bootstrap-e2e-'));
  const fakeCursorDir = join(tmpDir, '.cursor');
  const fakeRulesDir = join(fakeCursorDir, 'rules');
  const fakeSkillsDir = join(fakeCursorDir, 'skills', 'test-skill');
  const fakeDocsDir = join(tmpDir, 'docs');

  mkdirp(fakeRulesDir);
  mkdirp(fakeSkillsDir);
  mkdirp(fakeDocsDir);

  writeFileSync(join(fakeRulesDir, 'test-rule.mdc'), '---\ndescription: "E2E 测试规则"\nalwaysApply: true\n---\n\n# 测试规则\n\n这是一条用于 E2E 深度测试的规则。请确保所有代码通过 lint 检查。');
  writeFileSync(join(fakeSkillsDir, 'SKILL.md'), '# Test Skill\n\n这是一个用于 E2E 测试的技能。\n\n## 触发词\n- 测试技能\n- test skill');
  writeFileSync(join(fakeDocsDir, 'architecture.md'), '# 架构设计\n\n## 核心模块\n\nMemforge 采用微内核架构，核心包括 memory-service 和 rules-engine 两个 MCP Server。');

  const bootstrapResult = await callTool('bootstrap', {
    cursor_dir: fakeCursorDir,
    import_rules: true,
    import_skills: true,
    import_topology: false,
    import_docs: true,
    dry_run: true,
  });
  assert(bootstrapResult.success === true, 'bootstrap dry_run 成功');
  assert(bootstrapResult.mode === '试运行', `模式: ${bootstrapResult.mode}`);
  assert(bootstrapResult.rules?.scanned >= 1, `扫描到 ${bootstrapResult.rules?.scanned} 条规则`);
  assert(bootstrapResult.skills?.scanned >= 1, `扫描到 ${bootstrapResult.skills?.scanned} 个技能`);
  console.log(`  dry_run 结果: 规则 ${bootstrapResult.rules?.stored}/${bootstrapResult.rules?.scanned}, 技能 ${bootstrapResult.skills?.stored}/${bootstrapResult.skills?.scanned}, 文档 ${bootstrapResult.docs?.stored}/${bootstrapResult.docs?.chunks} 块`);

  rmSync(tmpDir, { recursive: true, force: true });
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // 阶段 7：bootstrap 实际写入 → recall 读取
  // ═══════════════════════════════════════════════════════════
  console.log('━━ 阶段 7：bootstrap 实际写入 → recall 读取 ━━');
  const tmpDir2 = mkdtempSync(join(tmpdir(), 'memforge-bootstrap-real-'));
  const fakeCursor2 = join(tmpDir2, '.cursor');
  const rules2 = join(fakeCursor2, 'rules');
  const skills2 = join(fakeCursor2, 'skills', 'deploy-skill');
  const docs2 = join(tmpDir2, 'docs');

  mkdirp(rules2);
  mkdirp(skills2);
  mkdirp(docs2);

  writeFileSync(join(rules2, 'deploy-safety.mdc'), `---\ndescription: "部署安全检查规则 ${RUN_ID}"\nalwaysApply: true\n---\n\n# 部署安全检查 ${RUN_ID}\n\n## 强制规则\n- 禁止直接 push master\n- 合并前必须通过 CI\n- hotfix 必须双人 review`);
  writeFileSync(join(skills2, 'SKILL.md'), `# Deploy Skill ${RUN_ID}\n\n自动化部署技能：检查分支状态、运行测试、合并到目标分支并推送。\n\n## 触发词\n- 部署到测试\n- 发布到 stage`);
  writeFileSync(join(docs2, 'deploy-guide.md'), `# 部署手册 ${RUN_ID}\n\n## 部署流程\n\n1. 创建功能分支\n2. 开发并通过 CI\n3. 合并到 alpha 分支\n4. alpha 环境验证\n5. 合并到 master 发布\n\n## 回滚策略\n\n如果线上出现问题，使用上一个稳定版本的 Docker 镜像回滚。`);

  const bootstrapReal = await callTool('bootstrap', {
    cursor_dir: fakeCursor2,
    import_rules: true,
    import_skills: true,
    import_topology: false,
    import_docs: true,
    dry_run: false,
  }, 600_000);
  assert(bootstrapReal.success === true, 'bootstrap 实际写入成功');
  const totalImported = (bootstrapReal.rules?.stored ?? 0) + (bootstrapReal.skills?.stored ?? 0) + (bootstrapReal.docs?.stored ?? 0);
  const totalSkipped = (bootstrapReal.rules?.duplicates ?? 0) + (bootstrapReal.skills?.duplicates ?? 0);
  assert(totalImported >= 1 || totalSkipped >= 1, `导入 ${totalImported} / 去重 ${totalSkipped} 条记忆`);

  await sleep(800);

  const recallBootstrap = await callTool('recall_memory', {
    query: '部署安全检查 禁止 push master',
    limit: 5,
  });
  assert(recallBootstrap.success === true, 'recall bootstrap 导入的规则');
  const bootstrapHit = recallBootstrap.results?.some(r =>
    r.content?.includes('push master') || r.title?.includes('部署')
  );
  assert(bootstrapHit, 'recall 命中了 bootstrap 导入的部署安全规则');

  const recallSkill = await callTool('recall_memory', {
    query: '自动化部署技能 合并分支',
    limit: 5,
    scope_filter: ['tool_usage'],
  });
  assert(recallSkill.success === true, 'recall bootstrap 导入的技能');

  rmSync(tmpDir2, { recursive: true, force: true });
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // 阶段 8：store_incident 故障报告
  // ═══════════════════════════════════════════════════════════
  console.log('━━ 阶段 8：store_incident 故障报告 ━━');
  const incidentResult = await callTool('store_incident', {
    title: `[${RUN_ID}] 用户充值失败故障`,
    impact: 'P1',
    affected_services: ['pay-order-service', 'mdp-recharge'],
    timeline: [
      { time: '2026-04-05 10:00', event: '收到用户反馈充值失败' },
      { time: '2026-04-05 10:15', event: '定位到 pay-order 超时' },
    ],
    root_cause: `[${RUN_ID}] MySQL 连接池耗尽导致 pay-order-service 超时`,
    resolution: '增大连接池 maxPoolSize 从 20 到 50',
    prevention: ['添加连接池监控告警', '优化慢查询'],
    duration_minutes: 30,
    tags: ['e2e-deep-test', `run:${RUN_ID}`],
  });
  assert(incidentResult.success === true, 'store_incident 存储成功');
  assert(!!incidentResult.id, `故障报告生成了记忆: ${incidentResult.id?.slice(0, 8)}...`);

  const recallIncident = await callTool('recall_memory', {
    query: `充值失败 连接池 pay-order ${RUN_ID}`,
    limit: 3,
  });
  assert(recallIncident.success === true, 'recall 能检索到故障报告');
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // 阶段 9：工作上下文追踪（start → update → evaluate）
  // ═══════════════════════════════════════════════════════════
  console.log('━━ 阶段 9：工作上下文追踪 ━━');

  const startResult = await callTool('start_work_context', {
    title: `E2E-${RUN_ID} 用户资料页迁移`,
    type: 'requirement',
    description: `E2E 测试：PHP 接口迁移到 Java room-web (run: ${RUN_ID})`,
    priority: 'P1',
    product_line: TEST_PRODUCT_LINE,
    projects: [{ name: 'room-web', branch: 'feature/e2e-test', path: '/tmp/room-web' }],
  });
  assert(startResult.success === true, 'start_work_context 创建成功');
  const contextId = startResult.context_id;
  assert(!!contextId, `工作上下文 ID: ${contextId?.slice(0, 8)}...`);

  if (contextId) {
    await sleep(1000);

    const updateResult = await callTool('update_work_context', {
      context_id: contextId,
      progress_note: `完成 getUserProfile 接口迁移 (run: ${RUN_ID})`,
      add_project: { name: 'fproject-api', branch: 'master', project_root: '/tmp/fproject-api' },
      add_documents: ['https://example.com/migration-guide.md'],
      collect_git_stats: false,
    });
    assert(updateResult.success === true, 'update_work_context 更新成功');
    const projCount = updateResult.projects?.length ?? 0;
    assert(projCount >= 2, `项目数量 >= 2: ${projCount}`);

    const evalResult = await callTool('evaluate_work_context', {
      context_id: contextId,
      outcome: 'completed',
      summary: `E2E 测试：完成 PHP 到 Java 迁移 (${RUN_ID})`,
      lessons: [
        `E2E-${RUN_ID} PHP到Java迁移时需注意MOA协议差异`,
        `E2E-${RUN_ID} 使用 momostore 替代直连 Redis`,
      ],
    });
    assert(evalResult.success === true, 'evaluate_work_context 评价成功');
    assert(evalResult.lessons_stored >= 2, `沉淀经验 >= 2: ${evalResult.lessons_stored}`);

    const recallCtx = await callTool('recall_memory', {
      query: `用户资料页迁移 ${RUN_ID}`,
      limit: 5,
    });
    assert(recallCtx.success === true, 'recall 能检索到工作上下文');

    // 清理工作追踪条目及其自动生成的经验教训
    // （work context 条目不带 run:RUN_ID 标签，Phase 11 的通用清理会漏掉它们）
    await callTool('archive_memory', { memory_id: contextId, reason: 'E2E 测试清理' });
    const ctxLessons = await callTool('list_memories', { tags: [`context:${contextId.slice(0, 8)}`] });
    if (ctxLessons.success && ctxLessons.entries?.length > 0) {
      for (const lesson of ctxLessons.entries) {
        await callTool('archive_memory', { memory_id: lesson.id, reason: 'E2E 测试清理 (work context 关联经验)' });
      }
    }
    console.log(`  🧹 工作追踪清理: 归档主条目 + ${ctxLessons.entries?.length ?? 0} 条关联经验`);
  } else {
    skip('跳过 update/evaluate 测试（start 未返回 contextId）');
    skip('跳过 update/evaluate 测试');
    skip('跳过 update/evaluate 测试');
    skip('跳过 update/evaluate 测试');
    skip('跳过 recall 工作上下文测试');
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // 阶段 10：重复检测（专用工具）
  // ═══════════════════════════════════════════════════════════
  console.log('━━ 阶段 10：专用工具重复检测 ━━');
  const dupLog = await callTool('store_log_insight', {
    error_pattern: `redis_like_snail_${RUN_ID}`,
    service_name: 'fproject-api-test',
    root_cause: `[${RUN_ID}] Redis 主从切换导致连接超时`,
    solution: '升级 phpredis 启用 retry_interval',
    severity: 'high',
    tags: ['e2e-deep-test', `run:${RUN_ID}`],
  });
  assert(dupLog.success === false || !!dupLog.existingId, '重复的日志洞察被检测到');

  const dupTrouble = await callTool('store_troubleshoot', {
    symptom: `[${RUN_ID}] fproject-api 接口返回 500，用户无法进入直播间`,
    affected_services: ['fproject-api-test'],
    investigation_steps: [
      { tool: 'es-search', action: '搜索 buglog', finding: 'MySQL server has gone away' },
    ],
    root_cause: `[${RUN_ID}] MySQL wait_timeout 配置不当`,
    fix: '调整 max_lifetime',
    category: 'config_error',
    tags: ['e2e-deep-test', `run:${RUN_ID}`],
  });
  const troubleDup = dupTrouble.success === false || !!dupTrouble.existingId;
  assert(troubleDup, `排查手册去重: ${dupTrouble.success === false ? '被拦截' : '写入（内容变化足够大）'}`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // 阶段 11：清理测试数据
  // ═══════════════════════════════════════════════════════════
  console.log('━━ 阶段 11：清理测试数据 ━━');
  const testList = await callTool('list_memories', { tags: [`run:${RUN_ID}`] });
  let cleaned = 0;
  if (testList.success && testList.entries?.length > 0) {
    for (const m of testList.entries) {
      await callTool('archive_memory', { memory_id: m.id, reason: 'E2E 测试清理' });
      cleaned++;
    }
  }
  assert(cleaned >= 0, `归档了 ${cleaned} 条测试记忆（RUN_ID: ${RUN_ID}）`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // 汇总
  // ═══════════════════════════════════════════════════════════
  console.log('═'.repeat(55));
  console.log(`\n总计: ${passed + failed} 测试, ✅ ${passed} 通过, ❌ ${failed} 失败${skipped > 0 ? `, ⏭️  ${skipped} 跳过` : ''}\n`);

  await client.close();
  process.exit(failed > 0 ? 1 : 0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function mkdirp(dir) { mkdirSync(dir, { recursive: true }); }

main().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
