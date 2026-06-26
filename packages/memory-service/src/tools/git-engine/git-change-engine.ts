// Created by dev on 2026/05/09
// Git 历史知识引擎 — 统一 Git 变更引擎
// 替代旧的 commit-learner，增加文件级统计和指标聚合

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getLogger, getPool, getIdeConfig } from '@memforgeai/shared';
import type { ToolContext } from '../types.js';
import type { CommitInfo, RepoTarget, GitEngineConfig } from './types.js';
import { DEFAULT_ENGINE_CONFIG } from './types.js';
import { classifyCommit, parseNameStatus, buildMemoryContent } from './commit-classifier.js';
import { indexApiDocsForRepo, type IndexApiDocsOptions } from '../index-api-docs.js';
import { updateActivityMetrics, updateFetchStatus } from './stats-store.js';
import { storeWithRouting } from '../../storage/storage-router.js';
import { clampVisibilityByRole } from '../../services/visibility-guard.js';
import { LlmAnalyzer, enrichContentWithAnalysis } from './llm-analyzer.js';
import { execGit, getCommitStats, getTotalStats, getHotFiles, buildContributorStats, checkRemoteStatus } from './git-helpers.js';
import { mapToKnowledgeExtracts } from './knowledge-mapper.js';

const execFileAsync = promisify(execFile);
const logger = getLogger('git-change-engine');

interface RegistryRepo {
  localPath: string;
  repoId: string;
  techStack: string;
  description: string;
}

export class GitChangeEngine {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private config: GitEngineConfig;
  private ctx: ToolContext;
  private llm: LlmAnalyzer;

  private basePollMs = 0;
  private consecutiveFailures = 0;
  private static readonly MAX_BACKOFF_MULTIPLIER = 8;
  private static readonly BACKOFF_BASE = 2;

  constructor(ctx: ToolContext, config?: Partial<GitEngineConfig>) {
    this.ctx = ctx;
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.llm = new LlmAnalyzer();
    if (this.config.llmDailyBudget) {
      this.llm.setDailyBudget(this.config.llmDailyBudget);
    }
  }

  private getEffectiveInterval(): number {
    if (this.consecutiveFailures === 0) return this.basePollMs;
    const multiplier = Math.min(
      GitChangeEngine.BACKOFF_BASE ** this.consecutiveFailures,
      GitChangeEngine.MAX_BACKOFF_MULTIPLIER,
    );
    return this.basePollMs * multiplier;
  }

  private scheduleNext(): void {
    if (!this.basePollMs) return;
    const interval = this.getEffectiveInterval();
    this.timer = setTimeout(() => {
      this.runCycle()
        .then(() => this.scheduleNext())
        .catch(err => {
          logger.warn({ err: (err as Error).message }, 'Git 变更引擎周期失败');
          this.scheduleNext();
        });
    }, interval);

    if (this.consecutiveFailures > 0) {
      logger.info({
        failures: this.consecutiveFailures,
        nextIntervalMin: Math.round(interval / 60_000),
      }, '自适应退避：延长轮询间隔');
    }
  }

  start(): void {
    if (this.timer) return;

    const intervalEnv = process.env.MEMFORGE_GIT_ENGINE_INTERVAL;
    if (intervalEnv) {
      const parsed = parseInt(intervalEnv, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        this.config.pollIntervalMs = parsed * 60 * 1000;
      } else {
        logger.warn({ value: intervalEnv }, 'MEMFORGE_GIT_ENGINE_INTERVAL 非法，使用默认值');
      }
    }

    if (process.env.MEMFORGE_COMMIT_LEARN === 'off' && process.env.MEMFORGE_GIT_ENGINE !== 'on') {
      logger.info('Git 变更引擎已禁用');
      return;
    }

    this.basePollMs = this.config.pollIntervalMs;
    this.consecutiveFailures = 0;

    setTimeout(() => {
      this.runCycle()
        .then(() => this.scheduleNext())
        .catch(err => {
          logger.warn({ err: (err as Error).message }, '首次 Git 变更引擎周期失败');
          this.scheduleNext();
        });
    }, 30_000);

    logger.info(
      { intervalMin: Math.round(this.config.pollIntervalMs / 60000) },
      'Git 变更引擎已启动（自适应退避）',
    );
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async runCycle(): Promise<{ totalAnalyzed: number; totalStored: number }> {
    if (this.running) {
      logger.debug('上一个周期仍在运行，跳过');
      return { totalAnalyzed: 0, totalStored: 0 };
    }
    this.running = true;

    let cycleSuccess = false;
    try {
      const repos = await this.discoverReposWithFallback();
      if (repos.length === 0) {
        logger.debug('未发现已注册仓库');
        cycleSuccess = true;
        return { totalAnalyzed: 0, totalStored: 0 };
      }

      logger.info({ repoCount: repos.length }, '开始 Git 变更引擎周期');

      let totalAnalyzed = 0;
      let totalStored = 0;
      let repoFailures = 0;

      for (const repo of repos) {
        try {
          const result = await this.processRepo(repo);
          totalAnalyzed += result.analyzed;
          totalStored += result.stored;
        } catch (err) {
          repoFailures++;
          logger.warn({ repo: repo.repoId, err: (err as Error).message }, '仓库处理失败');
        }
      }

      cycleSuccess = repoFailures < repos.length;

      logger.info({ totalAnalyzed, totalStored, repos: repos.length, repoFailures }, 'Git 变更引擎周期完成');
      return { totalAnalyzed, totalStored };
    } finally {
      this.running = false;

      if (cycleSuccess) {
        if (this.consecutiveFailures > 0) {
          logger.info({ previousFailures: this.consecutiveFailures }, '自适应退避：恢复正常轮询间隔');
        }
        this.consecutiveFailures = 0;
      } else {
        this.consecutiveFailures++;
        logger.warn({ consecutiveFailures: this.consecutiveFailures }, '周期失败，增加退避计数');
      }
    }
  }

  /**
   * 处理单个仓库：远程拉取 → 获取新提交 → 分类 → 存储记忆 → 更新统计
   */
  async processRepo(repo: RepoTarget): Promise<{ analyzed: number; stored: number }> {
    if (this.config.enableRemoteFetch) {
      await this.tryRemoteFetch(repo);
    }

    const lastHash = await this.getLastHash(repo.repoId);
    const commits = await this.fetchNewCommits(repo.localPath, lastHash);
    if (commits.length === 0) return { analyzed: 0, stored: 0 };

    let stored = 0;
    const inferredProject = repo.localPath.split('/').pop() ?? repo.repoId;

    for (const commit of commits) {
      const classification = classifyCommit(commit);
      if (!classification) continue;

      let content = buildMemoryContent(commit, classification);
      const scanResult = this.ctx.scanner.scan(content);
      if (scanResult.blocked) continue;

      let llmAnalyzed = false;
      const extraTags: string[] = [];
      let llmResult: { summary: string; impact: string; patterns: string[]; risks: string[]; tags: string[] } | null = null;

      if (classification.shouldDeepAnalyze && this.llm.isAvailable) {
        const diff = await this.getCommitDiff(repo.localPath, commit.hash);
        const analysis = await this.llm.analyze(commit, classification, repo.repoId, diff ?? undefined);
        if (analysis) {
          llmResult = analysis;
          content = enrichContentWithAnalysis(content, analysis);
          llmAnalyzed = true;
          extraTags.push('llm-analyzed');
          if (analysis.tags.length > 0) {
            extraTags.push(...analysis.tags.slice(0, 5));
          }
        }
      }

      try {
        const embedding = await this.ctx.embedding.embedPassage(
          `${commit.subject} ${scanResult.sanitizedContent ?? content}`,
        );
        const duplicate = await this.ctx.storage.checkDuplicate(embedding, 0.90);
        if (duplicate) continue;

        let resolvedProjectId: string;
        if (classification.visibility === 'global') {
          resolvedProjectId = '_global_';
        } else if (classification.visibility === 'product_line') {
          resolvedProjectId = repo.productLine;
        } else {
          resolvedProjectId = repo.productLine || inferredProject;
        }

        await storeWithRouting({
          ctx: this.ctx,
          scope: classification.scope,
          projectId: resolvedProjectId,
          productLine: repo.productLine,
          branchId: null,
          title: `[${classification.category}] ${commit.subject}`,
          content: llmAnalyzed ? content : (scanResult.sanitizedContent ?? content),
          source: classification.source,
          tags: [
            'from-commit', 'auto-learned', classification.category,
            `commit:${commit.hash.substring(0, 8)}`,
            `repo:${repo.repoId}`,
            ...extraTags,
          ],
          embedding,
          metadata: {
            commitHash: commit.hash,
            author: commit.author,
            commitDate: commit.date,
            filesChanged: commit.filesChanged,
            insertions: commit.insertions,
            deletions: commit.deletions,
            source_project: inferredProject,
            source_repo_id: repo.repoId,
            source_product_line: repo.productLine,
            visibility: classification.visibility,
            category: classification.category,
            shouldDeepAnalyze: classification.shouldDeepAnalyze,
            deepAnalyzeReason: classification.deepAnalyzeReason,
            llm_analyzed: llmAnalyzed,
            autoLearned: true,
          },
          sourceRef: `commit:${repo.repoId}:${commit.hash}`,
          visibility: classification.visibility === 'global' ? 'global' : 'personal',
        });
        stored++;
        if (llmAnalyzed) this.llm.confirmUsed();

        // 8 维度知识提取：从同一个 commit + LLM 分析结果中拆分出多维度知识条目
        const extracts = mapToKnowledgeExtracts(commit, classification, repo,
          llmResult ? { summary: llmResult.summary, impact: llmResult.impact, patterns: llmResult.patterns, risks: llmResult.risks } : undefined,
        );
        for (const extract of extracts) {
          try {
            const dimEmbedding = await this.ctx.embedding.embedPassage(
              `${extract.title} ${extract.content.slice(0, 500)}`,
            );
            const dimDup = await this.ctx.storage.checkDuplicate(dimEmbedding, 0.92);
            if (dimDup) continue;

            await storeWithRouting({
              ctx: this.ctx,
              scope: extract.scope,
              projectId: resolvedProjectId,
              productLine: repo.productLine,
              branchId: null,
              title: extract.title,
              content: extract.content,
              source: classification.source,
              tags: [...extract.tags, 'from-commit', 'knowledge-extract'],
              embedding: dimEmbedding,
              metadata: {
                commitHash: commit.hash,
                dimension: extract.dimension,
                source_repo_id: repo.repoId,
                source_product_line: repo.productLine,
                autoLearned: true,
              },
              sourceRef: `dim:${extract.dimension}:${repo.repoId}:${commit.hash}`,
              visibility: clampVisibilityByRole(extract.visibility, this.ctx.userRole ?? 'developer'),
            });
          } catch (dimErr) {
            logger.debug({ dim: extract.dimension, err: (dimErr as Error).message }, '维度知识提取存储失败');
          }
        }
      } catch (err) {
        logger.debug({ commit: commit.hash, err: (err as Error).message }, '存储提交记忆失败');
      }
    }

    if (commits.length > 0) {
      await this.saveLastHash(repo.repoId, commits[commits.length - 1].hash);
    }

    await this.aggregateRepoStats(repo);

    if (stored > 0) {
      logger.info({ repo: repo.repoId, analyzed: commits.length, stored }, '仓库变更处理完成');
      await this.checkCrossRepoImpact(repo, commits);
    }

    return { analyzed: commits.length, stored };
  }

  /**
   * 跨仓库变更关联：当公共库/基础层仓库检测到 API 签名变更时，
   * 查询拓扑中依赖该仓库的上游服务并生成告警记忆。
   */
  private async checkCrossRepoImpact(repo: RepoTarget, commits: CommitInfo[]): Promise<void> {
    const apiChangePatterns = [
      /\.(java|kt)$/,  // Java/Kotlin 接口/服务类
      /\.(proto|thrift|avsc)$/, // IDL 文件
      /src\/main\/.*Service\./,
      /src\/main\/.*Api\./,
      /src\/main\/.*Interface\./,
    ];

    const hasApiChange = commits.some(c =>
      c.files.some(f =>
        (f.status === 'M' || f.status === 'D') &&
        apiChangePatterns.some(p => p.test(f.file)),
      ),
    );

    if (!hasApiChange) return;

    try {
      const pool = getPool();
      const { rows: dependents } = await pool.query<{ from_repo_id: string; protocol: string }>(
        `SELECT from_repo_id, protocol FROM memory.topology_edges
         WHERE product_line = $1 AND to_repo_id = $2`,
        [repo.productLine, repo.repoId],
      );

      if (dependents.length === 0) return;

      const changedApiFiles = commits
        .flatMap(c => c.files)
        .filter(f => apiChangePatterns.some(p => p.test(f.file)))
        .map(f => f.file);

      const uniqueFiles = [...new Set(changedApiFiles)].slice(0, 10);
      const depList = dependents.map(d => d.from_repo_id).join(', ');

      const content = [
        `## 跨仓库 API 变更通知`,
        '',
        `**仓库**: ${repo.repoId}`,
        `**影响的上游**: ${depList}`,
        `**变更的 API 文件**:`,
        ...uniqueFiles.map(f => `- \`${f}\``),
        '',
        `> ${dependents.length} 个上游服务依赖此仓库，请确认 API 变更的兼容性。`,
      ].join('\n');

      const embedding = await this.ctx.embedding.embedPassage(
        `API 变更通知 ${repo.repoId} 影响 ${depList}`,
      );

      await this.ctx.storage.store({
        projectId: repo.productLine,
        branchId: null,
        title: `[API变更] ${repo.repoId} 接口变更影响 ${dependents.length} 个上游服务`,
        content,
        scope: 'architecture',
        source: 'git_monitor',
        tags: [
          'cross-repo-impact', 'api-change', 'auto-learned',
          `repo:${repo.repoId}`,
          ...dependents.map(d => `impacted:${d.from_repo_id}`),
        ],
        embedding,
        metadata: {
          changedRepoId: repo.repoId,
          impactedRepos: dependents.map(d => ({ repoId: d.from_repo_id, protocol: d.protocol })),
          changedFiles: uniqueFiles,
          autoLearned: true,
        },
        isArchived: false,
        archivedReason: null,
        createdBy: this.ctx.userId,
        expiresAt: null,
      });

      logger.info({
        repo: repo.repoId,
        impactedCount: dependents.length,
        changedFiles: uniqueFiles.length,
      }, '跨仓库 API 变更通知已生成');

      // API 签名变更后自动重新索引该仓库的 API 文档
      this.triggerApiReindex(repo).catch(err => {
        logger.debug({ repo: repo.repoId, err: (err as Error).message }, 'API 重新索引失败');
      });
    } catch (err) {
      logger.debug({ repo: repo.repoId, err: (err as Error).message }, '跨仓库关联检测失败');
    }
  }

  private async triggerApiReindex(repo: RepoTarget): Promise<void> {
    const techStack = (repo.techStack ?? 'unknown') as IndexApiDocsOptions['techStack'];
    if (techStack === 'unknown') return;

    const result = await indexApiDocsForRepo(this.ctx, {
      repoPath: repo.localPath,
      repoId: repo.repoId,
      techStack,
      productLine: repo.productLine,
      tags: ['auto-reindex', 'api-change'],
    });

    logger.info({
      repo: repo.repoId,
      stored: result.stored,
      duplicates: result.duplicates,
    }, 'API 变更触发的自动重新索引完成');
  }

  /**
   * 聚合仓库级的 Git 统计并写入 project_git_stats
   */
  private async aggregateRepoStats(repo: RepoTarget): Promise<void> {
    try {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600_000).toISOString();

      const [stats7d, stats30d, total, hotFiles] = await Promise.all([
        getCommitStats(repo.localPath, sevenDaysAgo),
        getCommitStats(repo.localPath, thirtyDaysAgo),
        getTotalStats(repo.localPath),
        getHotFiles(repo.localPath, thirtyDaysAgo),
      ]);
      const contributors = buildContributorStats(stats30d.authors);

      await updateActivityMetrics(repo.productLine, repo.repoId, {
        commitsLast7d: stats7d.count,
        commitsLast30d: stats30d.count,
        activeContributors7d: stats7d.authors.size,
        activeContributors30d: stats30d.authors.size,
        hotFiles30d: hotFiles,
        topContributors: contributors,
        totalCommits: total.count,
        firstCommitAt: total.firstCommitAt,
        lastCommitAt: total.lastCommitAt,
      });

      const head = await execGit(repo.localPath, ['rev-parse', 'HEAD']);
      if (head) {
        const branch = await this.getDefaultBranch(repo.localPath);
        const remote = await checkRemoteStatus(repo.localPath, branch);
        await updateFetchStatus(
          repo.productLine, repo.repoId,
          head.trim(), remote.remoteHash, remote.behindCount, branch,
        );
      }
    } catch (err) {
      logger.debug({ repo: repo.repoId, err: (err as Error).message }, '统计聚合失败');
    }
  }

  // ── Git 操作封装 ─────────────────────────────────

  private async fetchNewCommits(localPath: string, sinceHash: string | null): Promise<CommitInfo[]> {
    const args = [
      'log', `--max-count=${this.config.maxCommitsPerCycle}`,
      '--format=%H|||%s|||%an|||%aI|||%b',
      '--no-merges',
      '--reverse',
    ];
    if (sinceHash) args.push(`${sinceHash}..HEAD`);

    const logOutput = await execGit(localPath, args);
    if (!logOutput) return [];

    const rawCommits = logOutput
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const parts = line.split('|||');
        return {
          hash: parts[0] ?? '',
          subject: parts[1] ?? '',
          author: parts[2] ?? '',
          date: parts[3] ?? '',
          body: parts[4] ?? '',
        };
      })
      .filter(c => c.hash && c.subject);

    const commits: CommitInfo[] = [];
    for (const raw of rawCommits) {
      // 首提交无父节点，用 --root；其他用 hash~1..hash
      const hasParent = await execGit(localPath, ['rev-parse', '--verify', `${raw.hash}~1`]);
      const diffArgs = hasParent
        ? ['diff', '--name-status', `${raw.hash}~1`, raw.hash]
        : ['diff', '--name-status', '--root', raw.hash];
      const nameStatusOutput = await execGit(localPath, diffArgs);
      const files = nameStatusOutput ? parseNameStatus(nameStatusOutput) : [];

      const numstatArgs = hasParent
        ? ['diff', '--numstat', `${raw.hash}~1`, raw.hash]
        : ['diff', '--numstat', '--root', raw.hash];
      const numstatOutput = await execGit(localPath, numstatArgs);
      let insertions = 0;
      let deletions = 0;
      if (numstatOutput) {
        for (const line of numstatOutput.split('\n').filter(Boolean)) {
          const [ins, del] = line.split('\t');
          const parsedIns = parseInt(ins, 10);
          const parsedDel = parseInt(del, 10);
          insertions += (ins === '-' || Number.isNaN(parsedIns)) ? 0 : parsedIns;
          deletions += (del === '-' || Number.isNaN(parsedDel)) ? 0 : parsedDel;
        }
      }

      commits.push({
        ...raw,
        filesChanged: files.length,
        insertions,
        deletions,
        files,
      });
    }

    return commits;
  }

  private async getDefaultBranch(localPath: string): Promise<string> {
    const output = await execGit(localPath, ['symbolic-ref', '--short', 'HEAD']);
    return output?.trim() || 'main';
  }

  /**
   * 尝试 git fetch 拉取远程变更（静默失败，不阻塞主流程）
   */
  private async tryRemoteFetch(repo: RepoTarget): Promise<void> {
    try {
      const env: Record<string, string> = { ...process.env as Record<string, string> };

      const token = await this.getGitTokenForRepo(repo);
      if (token) {
        env.GIT_ASKPASS = 'echo';
        env.GIT_TERMINAL_PROMPT = '0';
        const remoteUrl = await execGit(repo.localPath, ['remote', 'get-url', 'origin']);
        if (remoteUrl && remoteUrl.startsWith('https://')) {
          const url = new URL(remoteUrl.trim());
          url.username = 'oauth2';
          url.password = token;
          await execFileAsync('git', ['fetch', '--quiet', url.href], {
            cwd: repo.localPath, timeout: 30_000, encoding: 'utf-8', env,
            // token 在 URL 中，stderr/stdout 不含凭证（--quiet 模式）
          });
          return;
        }
      }

      await execFileAsync('git', ['fetch', '--quiet'], {
        cwd: repo.localPath, timeout: 30_000, encoding: 'utf-8', env,
      });
    } catch (err) {
      const errMsg = (err instanceof Error ? err.message : String(err)).replace(/oauth2:[^@]+@/g, 'oauth2:***@');
      logger.debug({ repo: repo.repoId, err: errMsg }, 'git fetch 失败（可能缺少认证）');
    }
  }

  private async getGitTokenForRepo(repo: RepoTarget): Promise<string | null> {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ settings: { git_token?: string } }>(
        `SELECT pl.settings FROM memory.topology_nodes tn
         JOIN memory.product_lines pl ON (pl.name = tn.product_line OR pl.slug = tn.product_line)
         WHERE tn.repo_id = $1 AND pl.settings->>'git_token' IS NOT NULL
         LIMIT 1`,
        [repo.repoId],
      );
      return rows[0]?.settings?.git_token ?? null;
    } catch {
      return null;
    }
  }

  private async getCommitDiff(localPath: string, hash: string): Promise<string | null> {
    try {
      const hasParent = await execGit(localPath, ['rev-parse', '--verify', `${hash}~1`]);
      const diffRef = hasParent ? `${hash}^..${hash}` : hash;
      const args = hasParent
        ? ['diff', diffRef, '--stat=120', '-p', '--no-color']
        : ['diff', '--root', diffRef, '--stat=120', '-p', '--no-color'];
      const { stdout } = await execFileAsync('git', args, {
        cwd: localPath,
        timeout: 15_000,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      return stdout.length > 0 ? stdout.substring(0, 8000) : null;
    } catch {
      return null;
    }
  }

  // ── 进度追踪 ─────────────────────────────────────

  private async getLastHash(repoId: string): Promise<string | null> {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ last_result: { lastHash?: string } }>(
        `SELECT last_result FROM memory.auto_init_state
         WHERE project_id = $1 AND init_type IN ('commit_learn', 'git_watch')
         ORDER BY updated_at DESC LIMIT 1`,
        [repoId],
      );
      return rows[0]?.last_result?.lastHash ?? null;
    } catch {
      return null;
    }
  }

  private async saveLastHash(repoId: string, hash: string): Promise<void> {
    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO memory.auto_init_state (project_id, init_type, last_run_at, last_status, last_result, run_count)
         VALUES ($1, 'git_watch', NOW(), 'success', $2, 1)
         ON CONFLICT (project_id, init_type)
         DO UPDATE SET last_run_at = NOW(), last_status = 'success', last_result = $2,
                       run_count = memory.auto_init_state.run_count + 1, updated_at = NOW()`,
        [repoId, JSON.stringify({ lastHash: hash, updatedAt: new Date().toISOString() })],
      );
    } catch (err) {
      logger.debug({ repoId, err: (err as Error).message }, '保存进度失败');
    }
  }

  // ── 仓库发现 ─────────────────────────────────────

  /**
   * 双源仓库发现：优先本地 registry 文件 → 回退到 DB topology_nodes
   */
  private async discoverReposWithFallback(): Promise<RepoTarget[]> {
    const localRepos = this.discoverFromLocalRegistry();
    if (localRepos.length > 0) return localRepos;

    return this.discoverFromDatabase();
  }

  private discoverFromLocalRegistry(): RepoTarget[] {
    const configDir = getIdeConfig().configDir;
    if (!existsSync(configDir)) return [];

    const repos: RepoTarget[] = [];
    const registryFiles = readdirSync(configDir).filter(f => f.endsWith('-registry.json'));

    for (const file of registryFiles) {
      const productLine = file.replace('-registry.json', '');
      try {
        const content = JSON.parse(readFileSync(join(configDir, file), 'utf-8'));
        const repoMap = content.repos as Record<string, RegistryRepo> | undefined;
        if (!repoMap) continue;

        for (const [repoId, repo] of Object.entries(repoMap)) {
          const localPath = repo.localPath?.replace(/^~/, process.env.HOME ?? '');
          if (localPath && existsSync(localPath)) {
            repos.push({
              localPath,
              repoId,
              productLine,
              techStack: repo.techStack,
            });
          }
        }
      } catch {
        logger.debug({ file }, '注册表文件解析失败');
      }
    }

    return repos;
  }

  /**
   * 从 DB 的 topology_nodes 表发现仓库（服务器模式回退）
   * 优先使用 topology_user_paths（per-user），否则用节点默认 local_path
   */
  private async discoverFromDatabase(): Promise<RepoTarget[]> {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{
        repo_id: string;
        product_line: string;
        tech_stack: string | null;
        local_path: string | null;
        user_path: string | null;
      }>(
        `SELECT tn.repo_id, tn.product_line, tn.tech_stack, tn.local_path,
                tup.local_path AS user_path
         FROM memory.topology_nodes tn
         LEFT JOIN memory.topology_user_paths tup
           ON tup.product_line = tn.product_line
           AND tup.repo_id = tn.repo_id
           AND tup.user_id = $1
         WHERE tn.is_hidden = false
         ORDER BY tn.product_line, tn.repo_id`,
        [this.ctx.userId],
      );

      const repos: RepoTarget[] = [];
      for (const row of rows) {
        const rawPath = row.user_path ?? row.local_path;
        if (!rawPath) continue;
        const localPath = rawPath.replace(/^~/, process.env.HOME ?? '');
        if (!existsSync(localPath)) continue;

        repos.push({
          localPath,
          repoId: row.repo_id,
          productLine: row.product_line,
          techStack: row.tech_stack ?? undefined,
        });
      }

      if (repos.length > 0) {
        logger.info({ count: repos.length }, '从数据库发现已注册仓库（本地 registry 为空）');
      }
      return repos;
    } catch (err) {
      logger.debug({ err: (err as Error).message }, '数据库仓库发现失败');
      return [];
    }
  }

}
