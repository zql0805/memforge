#!/usr/bin/env node
// Created by dev on 2026/04/04
// Copyright © 2026
// Rules Engine E2E 测试（against PostgreSQL）
// 前置条件：docker compose up -d postgres

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const modelsDir = resolve(rootDir, 'models');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://memforge:memforge_dev@localhost:5432/memforge';

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
  console.log('\n🔧 Rules Engine E2E 测试 (PostgreSQL)\n');
  console.log('数据库:', DATABASE_URL.replace(/\/\/.*:.*@/, '//<hidden>@'));
  console.log('模型目录:', modelsDir);
  console.log('');

  transport = new StdioClientTransport({
    command: 'node',
    args: [resolve(rootDir, 'packages/rules-engine/dist/index.js')],
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

  const tools = await client.listTools();
  const toolNames = tools.tools.map(t => t.name);
  console.log('注册的工具:', toolNames.join(', '));
  assert(toolNames.length >= 17, `注册了 ${toolNames.length} 个工具（期望 >= 17）`);

  const expectedM6Tools = [
    'assess_skill', 'get_growth_path', 'record_milestone',
    'get_skill_radar', 'get_team_matrix',
    'add_knowledge_relation', 'get_knowledge_graph',
  ];
  for (const t of expectedM6Tools) {
    assert(toolNames.includes(t), `M6 工具 ${t} 已注册`);
  }
  console.log('');

  // ─── 测试 1: propose_rule ──────────────────────────────────

  console.log('── 测试 1: propose_rule ──');
  const proposeResult = await callTool('propose_rule', {
    title: 'PHP 禁止在循环内执行数据库查询',
    description: '在 foreach/while 循环体内直接调用数据库查询会导致 N+1 问题，应改为批量查询后在内存中关联数据。',
    rationale: '生产环境出现过多次因 N+1 查询导致的性能事故',
    example_bad: 'foreach ($uids as $uid) { $user = $db->query("SELECT * FROM users WHERE id = ?", $uid); }',
    example_good: '$users = $db->query("SELECT * FROM users WHERE id IN (?)", $uids); $map = array_column($users, null, "id");',
    auto_fix: '将循环内的单条查询改为 IN 查询，然后使用 array_column 建立索引映射',
    category: 'performance',
    language: 'php',
    severity: 'error',
    source: 'manual',
    created_by: 'test-user-1',
  });
  assert(proposeResult.success === true, 'propose_rule 成功');
  assert(!!proposeResult.id, `生成规则 ID: ${proposeResult.id?.slice(0, 8)}...`);
  const rule1Id = proposeResult.id;

  const dupResult = await callTool('propose_rule', {
    title: 'PHP 循环中禁止 DB 查询',
    description: '在循环里直接执行数据库查询会造成 N+1 性能问题',
    category: 'performance',
    language: 'php',
    severity: 'error',
  });
  // 重复检测：可能因已有真实规则（如"禁止在循环中执行 SQL 查询"）而被拦截，或作为精确重复被拦截
  assert(dupResult.success === false || dupResult.duplicateRule, '重复规则被检测到（精确重复或语义重复）');
  if (dupResult.duplicateRule) {
    assert(!!dupResult.duplicateRule, `检测到重复: ${dupResult.duplicateRule?.title?.slice(0, 20)}...`);
  } else {
    console.log(`  ✅ 规则被拦截（可能与已有规则语义重复）`);
  }

  const rule2Result = await callTool('propose_rule', {
    title: '禁止 SQL 字符串拼接',
    description: '直接拼接用户输入到 SQL 语句中会导致 SQL 注入漏洞，必须使用参数化查询。',
    example_bad: '$sql = "SELECT * FROM users WHERE name = \'" . $name . "\'";',
    example_good: '$stmt = $db->prepare("SELECT * FROM users WHERE name = ?"); $stmt->execute([$name]);',
    category: 'security',
    language: 'php',
    severity: 'error',
    created_by: 'test-user-1',
  });
  assert(rule2Result.success === true, 'security 规则提议成功');
  const rule2Id = rule2Result.id;
  console.log('');

  // ─── 测试 2: list_rules ────────────────────────────────────

  console.log('── 测试 2: list_rules ──');
  const listResult = await callTool('list_rules', {});
  assert(listResult.success === true, 'list_rules 成功');
  assert(listResult.pagination.total >= 2, `共 ${listResult.pagination.total} 条规则`);
  console.log('');

  // ─── 测试 3: get_rule ──────────────────────────────────────

  console.log('── 测试 3: get_rule ──');
  const getResult = await callTool('get_rule', { rule_id: rule1Id });
  assert(getResult.success === true, 'get_rule 成功');
  assert(getResult.rule.title.includes('禁止在循环内'), '标题正确');
  assert(getResult.rule.status === 'candidate', '状态为 candidate');
  console.log('');

  // ─── 测试 4: update_rule ───────────────────────────────────

  console.log('── 测试 4: update_rule ──');
  const updateResult = await callTool('update_rule', {
    rule_id: rule1Id,
    rationale: '已确认：3 次生产事故均因 N+1 查询导致',
  });
  assert(updateResult.success === true, 'update_rule 成功');
  console.log('');

  // ─── 测试 5: vote_rule ─────────────────────────────────────

  console.log('── 测试 5: vote_rule（加权投票 + 自动激活）──');

  const vote1 = await callTool('vote_rule', {
    rule_id: rule1Id, user_id: 'admin-1', role: 'admin', vote: 1, comment: '必须执行',
  });
  assert(vote1.success === true, 'admin 投赞成（权重3）');
  assert(vote1.evaluation.weightedScore === 3, `加权得分: ${vote1.evaluation.weightedScore}`);
  assert(vote1.evaluation.needsMoreVotes === true, '还需要更多投票');

  const vote2 = await callTool('vote_rule', {
    rule_id: rule1Id, user_id: 'lead-1', role: 'lead', vote: 1,
  });
  assert(vote2.success === true, 'lead 投赞成（权重2）');
  assert(vote2.evaluation.weightedScore === 5, `加权得分: ${vote2.evaluation.weightedScore}`);
  assert(vote2.evaluation.needsMoreVotes === true, '还需要第 3 票（minVoters=3）');

  const vote3 = await callTool('vote_rule', {
    rule_id: rule1Id, user_id: 'dev-2', role: 'developer', vote: 1,
  });
  assert(vote3.success === true, 'developer 投赞成（权重1）');
  assert(vote3.evaluation.weightedScore === 6, `加权得分: ${vote3.evaluation.weightedScore}`);
  assert(vote3.evaluation.status === 'active', '3人投票 + 达到阈值，自动激活');

  const voteS1 = await callTool('vote_rule', {
    rule_id: rule2Id, user_id: 'dev-1', role: 'developer', vote: 1,
  });
  assert(voteS1.evaluation.status === 'voting', 'developer 投票后仍在 voting');

  const voteS2 = await callTool('vote_rule', {
    rule_id: rule2Id, user_id: 'admin-2', role: 'admin', vote: -1, comment: '需要重新审查',
  });
  assert(voteS2.evaluation.vetoed === true, 'admin 一票否决 security 规则');
  assert(voteS2.evaluation.status === 'rejected', '规则已被拒绝');
  console.log('');

  // ─── 测试 6: enforce_rules ─────────────────────────────────

  console.log('── 测试 6: enforce_rules ──');
  const enforceResult = await callTool('enforce_rules', {
    code: 'foreach ($ids as $id) { $row = $db->query("SELECT * FROM items WHERE id = ?", [$id]); }',
    language: 'php',
    file_path: 'app/models/order.php',
  });
  assert(enforceResult.success === true, 'enforce_rules 成功');
  assert(enforceResult.rulesChecked > 0, `检查了 ${enforceResult.rulesChecked} 条规则`);

  const cleanResult = await callTool('enforce_rules', {
    code: 'function add(int $a, int $b): int { return $a + $b; }',
    language: 'php',
  });
  assert(cleanResult.success === true, '干净代码检查成功');
  console.log('');

  // ─── 测试 7: record_rule_event ─────────────────────────────

  console.log('── 测试 7: record_rule_event ──');
  const eventResult = await callTool('record_rule_event', {
    rule_id: rule1Id,
    event_type: 'applied',
    file_path: 'app/models/order.php',
    user_id: 'dev-1',
  });
  assert(eventResult.success === true, '事件记录成功');
  assert(!!eventResult.eventId, `事件 ID: ${eventResult.eventId?.slice(0, 8)}...`);

  await callTool('record_rule_event', { rule_id: rule1Id, event_type: 'accepted', user_id: 'dev-1' });
  await callTool('record_rule_event', { rule_id: rule1Id, event_type: 'violated', file_path: 'app/models/cart.php' });
  console.log('');

  // ─── 测试 8: measure_rules ─────────────────────────────────

  console.log('── 测试 8: measure_rules ──');
  const measureOverview = await callTool('measure_rules', { time_range: '30d' });
  assert(measureOverview.success === true, '全局度量概览成功');
  assert(measureOverview.overview.totalActiveRules >= 1, `活跃规则: ${measureOverview.overview.totalActiveRules}`);

  const measureDetail = await callTool('measure_rules', { rule_id: rule1Id, time_range: '30d' });
  assert(measureDetail.success === true, '单条规则度量成功');
  assert(measureDetail.metrics.appliedCount >= 1, `应用次数: ${measureDetail.metrics.appliedCount}`);
  console.log('');

  // ─── 测试 9: discover_rules ────────────────────────────────

  console.log('── 测试 9: discover_rules ──');
  const discoverScan = await callTool('discover_rules', {
    source_type: 'codebase_scan',
    content: 'foreach ($users as $user) { $profile = $db->query("SELECT * FROM profiles WHERE user_id = ?", [$user["id"]]); $result[] = $profile; }',
    language: 'php',
    file_path: 'app/models/user_list.php',
  });
  assert(discoverScan.success === true, 'codebase_scan 发现成功');
  assert(discoverScan.total > 0, `发现 ${discoverScan.total} 个候选`);

  const discoverReview = await callTool('discover_rules', {
    source_type: 'code_review',
    content: '应该使用参数化查询替换字符串拼接，避免 SQL 注入风险',
    language: 'php',
  });
  assert(discoverReview.success === true, 'code_review 发现成功');
  console.log('');

  // ─── 测试 10: deprecate_rule ───────────────────────────────

  console.log('── 测试 10: deprecate_rule ──');
  const deprecateResult = await callTool('deprecate_rule', {
    rule_id: rule1Id,
    reason: '已被更精确的 AST 分析规则替代',
  });
  assert(deprecateResult.success === true, 'deprecate_rule 成功');
  assert(deprecateResult.newStatus === 'deprecated', '状态已变更为 deprecated');

  const enforceAfterDep = await callTool('enforce_rules', {
    code: 'foreach ($ids as $id) { $row = $db->query("SELECT * FROM items WHERE id = ?", [$id]); }',
    language: 'php',
  });
  // 废弃的测试规则不应在检查列表中，但真实 active 规则仍会被检查
  const deprecatedInResults = enforceAfterDep.violations?.some(v => v.ruleId === rule1Id) ?? false;
  assert(!deprecatedInResults, '废弃后该规则不出现在违规结果中');
  console.log('');

  // ─── 测试 11: MCP Resource ─────────────────────────────────

  console.log('── 测试 11: MCP Resource (memory://rules/active) ──');
  const resources = await client.listResources();
  const rulesResource = resources.resources.find(r => r.uri === 'memory://rules/active');
  assert(!!rulesResource, 'memory://rules/active 资源已注册');

  if (rulesResource) {
    const content = await client.readResource({ uri: 'memory://rules/active' });
    const data = JSON.parse(content.contents[0].text);
    // 测试规则已废弃，但系统中可能有真实 active 规则
    const testRuleInActive = data.rules?.some(r => r.id === rule1Id) ?? false;
    assert(!testRuleInActive, '废弃的测试规则不在活跃列表中');
    console.log(`  ✅ 活跃规则总数: ${data.total}（不含已废弃的测试规则）`);
  }
  console.log('');

  // ─── 测试 12: assess_skill ──────────────────────────────────

  const testUserId = '00000000-0000-0000-0000-000000000099';
  {
    // 预置测试用户（M6 技能树工具依赖 users 表外键）
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: DATABASE_URL });
    await pool.query(`
      INSERT INTO memory.users (id, org_id, external_id, display_name, role)
      VALUES ($1, '00000000-0000-0000-0000-000000000001', 'test-dev', 'Test Developer', 'developer')
      ON CONFLICT (id) DO NOTHING
    `, [testUserId]);
    await pool.end();
  }

  console.log('── 测试 12: assess_skill ──');
  const assessResult = await callTool('assess_skill', {
    user_id: testUserId,
    skill_name: '数据库',
  });
  assert(assessResult.success === true, 'assess_skill 成功');
  assert(assessResult.skill === '数据库', `评估技能: ${assessResult.skill}`);
  assert(typeof assessResult.currentLevel === 'number', `当前等级: ${assessResult.currentLevel}`);
  console.log('');

  // ─── 测试 13: record_milestone ─────────────────────────────

  console.log('── 测试 13: record_milestone ──');
  const milestoneResult = await callTool('record_milestone', {
    user_id: testUserId,
    skill_name: '数据库',
    description: '在 fproject-api 中发现并修复了 3 处 N+1 查询问题',
  });
  assert(milestoneResult.success === true, 'record_milestone 成功');
  assert(milestoneResult.skill === '数据库', `里程碑技能: ${milestoneResult.skill}`);
  console.log('');

  // ─── 测试 14: get_growth_path ──────────────────────────────

  console.log('── 测试 14: get_growth_path ──');
  const growthResult = await callTool('get_growth_path', {
    user_id: testUserId,
    target_role: 'senior_developer',
  });
  assert(growthResult.success === true, 'get_growth_path 成功');
  assert(!!growthResult.currentProfile, `当前画像: ${growthResult.currentProfile?.averageLevel ?? 'N/A'}`);
  console.log('');

  // ─── 测试 15: get_skill_radar ──────────────────────────────

  console.log('── 测试 15: get_skill_radar ──');
  const radarResult = await callTool('get_skill_radar', {
    user_id: testUserId,
  });
  assert(radarResult.success === true, 'get_skill_radar 成功');
  assert(typeof radarResult.skillCount === 'number', `技能数: ${radarResult.skillCount}`);
  console.log('');

  // ─── 测试 16: get_team_matrix ──────────────────────────────

  console.log('── 测试 16: get_team_matrix ──');
  const matrixResult = await callTool('get_team_matrix', {});
  assert(matrixResult.success === true, 'get_team_matrix 成功');
  assert(Array.isArray(matrixResult.members), `成员数: ${matrixResult.members?.length ?? 0}`);
  console.log('');

  // ─── 测试 17: add_knowledge_relation ──────────────────────

  console.log('── 测试 17: add_knowledge_relation ──');
  const addRelResult = await callTool('add_knowledge_relation', {
    source_id: rule1Id,
    source_type: 'rule',
    target_id: rule2Id,
    target_type: 'rule',
    relation_type: 'related_to',
    confidence: 0.85,
  });
  assert(addRelResult.success === true, 'add_knowledge_relation 成功');
  assert(!!addRelResult.relationId, `关系 ID: ${addRelResult.relationId?.slice(0, 8)}...`);
  console.log('');

  // ─── 测试 18: get_knowledge_graph ─────────────────────────

  console.log('── 测试 18: get_knowledge_graph ──');
  const graphResult = await callTool('get_knowledge_graph', {
    center_id: rule1Id,
    center_type: 'rule',
    depth: 1,
  });
  assert(graphResult.success === true, 'get_knowledge_graph 成功');
  assert(graphResult.nodes?.length >= 1, `图谱节点: ${graphResult.nodes?.length}`);
  assert(graphResult.edges?.length >= 1, `图谱边: ${graphResult.edges?.length}`);
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
