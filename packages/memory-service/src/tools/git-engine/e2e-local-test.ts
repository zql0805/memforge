// Created by dev on 2026/05/09
// Git 历史知识引擎 — 本地端到端测试
// 用法: npx tsx packages/memory-service/src/tools/git-engine/e2e-local-test.ts [repoPath]

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitChangeEngine } from './git-change-engine.js';
import { getGitStats } from './stats-store.js';
import type { RepoTarget } from './types.js';

const execFileAsync = promisify(execFile);

interface MockStorage {
  memories: Array<{ title: string; content: string; tags: string[]; metadata: Record<string, unknown> }>;
  store(data: Record<string, unknown>): Promise<void>;
  checkDuplicate(embedding: number[], threshold: number): Promise<boolean>;
}

interface MockEmbedding {
  embedPassage(text: string): Promise<number[]>;
}

async function main() {
  const repoPath = process.argv[2] ?? process.cwd();
  const resolved = resolve(repoPath);

  if (!existsSync(resolved)) {
    console.error(`❌ 路径不存在: ${resolved}`);
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════');
  console.log(' Git 历史知识引擎 — 本地 E2E 测试');
  console.log('═══════════════════════════════════════════');
  console.log(`📁 仓库路径: ${resolved}`);
  console.log('');

  // 获取仓库基本信息
  const repoId = await inferRepoId(resolved);
  const branch = await execGit(resolved, ['symbolic-ref', '--short', 'HEAD']);
  const latestCommit = await execGit(resolved, ['log', '-1', '--format=%H %s']);

  console.log(`🔗 Repo ID: ${repoId ?? 'unknown'}`);
  console.log(`🌿 分支: ${branch ?? 'unknown'}`);
  console.log(`📝 最新提交: ${latestCommit?.substring(0, 80) ?? 'unknown'}`);
  console.log('');

  // 构建 mock 上下文
  const storedMemories: MockStorage['memories'] = [];
  const mockStorage: MockStorage = {
    memories: storedMemories,
    async store(data: Record<string, unknown>) {
      storedMemories.push({
        title: data.title as string,
        content: (data.content as string).substring(0, 200),
        tags: data.tags as string[],
        metadata: data.metadata as Record<string, unknown>,
      });
    },
    async checkDuplicate() { return false; },
  };

  const mockEmbedding: MockEmbedding = {
    async embedPassage() {
      return new Array(1024).fill(0).map(() => Math.random());
    },
  };

  const mockScanner = {
    scan(content: string) { return { blocked: false, sanitizedContent: content }; },
  };

  const mockCtx = {
    userId: 'e2e-test',
    userRole: 'admin',
    deviceId: 'local',
    storage: mockStorage,
    embedding: mockEmbedding,
    scanner: mockScanner,
    gitContext: { projectName: 'e2e-test', branchName: branch ?? 'main' },
  };

  // 构建引擎（不启动定时器）
  const engine = new GitChangeEngine(mockCtx as never, {
    maxCommitsPerCycle: 10,
    enableRemoteFetch: false,
    llmDailyBudget: 5,
  });

  const testRepo: RepoTarget = {
    localPath: resolved,
    repoId: repoId ?? 'test/repo',
    productLine: 'e2e-test',
    techStack: 'typescript',
  };

  console.log('─── 阶段 1: 处理最近 10 条提交 ───');
  console.log('');

  try {
    const result = await engine.processRepo(testRepo);
    console.log(`✅ 分析完成:`);
    console.log(`   - 提交数: ${result.analyzed}`);
    console.log(`   - 存入记忆: ${result.stored}`);
    console.log('');

    if (storedMemories.length > 0) {
      console.log('─── 阶段 2: 存储的记忆样本 ───');
      console.log('');
      for (const mem of storedMemories.slice(0, 5)) {
        const llmFlag = mem.metadata.llm_analyzed ? ' 🤖LLM' : '';
        console.log(`  📌 ${mem.title}${llmFlag}`);
        console.log(`     标签: ${mem.tags.join(', ')}`);
        if (mem.metadata.shouldDeepAnalyze) {
          console.log(`     深度分析: ${mem.metadata.deepAnalyzeReason}`);
        }
        console.log('');
      }
    }

    // 验证 LLM 相关
    console.log('─── 阶段 3: LLM 分析器状态 ───');
    console.log('');
    const llmModel = process.env.MEMFORGE_LLM_MODEL ?? process.env.OPENAI_MODEL ?? '未配置';
    const llmBase = process.env.OPENAI_BASE_URL ?? '未配置';
    const hasApiKey = !!process.env.OPENAI_API_KEY;
    console.log(`   模型: ${llmModel}`);
    console.log(`   API Base: ${llmBase}`);
    console.log(`   API Key: ${hasApiKey ? '已设置' : '❌ 未设置'}`);
    const llmUsed = storedMemories.filter(m => m.metadata.llm_analyzed).length;
    console.log(`   LLM 分析数: ${llmUsed}/${storedMemories.length}`);
    console.log('');

    console.log('─── 阶段 4: 统计聚合验证 ───');
    console.log('');
    console.log('   (统计聚合需要数据库连接，跳过 mock 模式)');
    console.log('');

    // 总结
    console.log('═══════════════════════════════════════════');
    console.log(' 测试结果汇总');
    console.log('═══════════════════════════════════════════');
    const passed = result.analyzed > 0;
    console.log(`  提交发现: ${passed ? '✅' : '❌'} (${result.analyzed} 条)`);
    console.log(`  分类存储: ${result.stored > 0 ? '✅' : '⚠️ 0 条（可能全部被去重）'}`);
    console.log(`  LLM 集成: ${hasApiKey ? (llmUsed > 0 ? '✅' : '⚠️ 无触发') : '⏭️ 跳过（无 API Key）'}`);
    console.log('');

    if (passed) {
      console.log('🎉 E2E 测试通过！');
    } else {
      console.log('⚠️ 未发现新提交（可能 lastHash 已是最新）');
    }
  } catch (err) {
    console.error('❌ 测试失败:', (err as Error).message);
    console.error((err as Error).stack);
    process.exit(1);
  }
}

async function inferRepoId(cwd: string): Promise<string | null> {
  const remote = await execGit(cwd, ['remote', 'get-url', 'origin']);
  if (!remote) return null;
  const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

async function execGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd, timeout: 15_000, encoding: 'utf-8',
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
