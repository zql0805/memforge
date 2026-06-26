import { getLogger } from '@memforgeai/shared';
import pLimit from 'p-limit';
import { collectContext, type ReviewContext } from './context-collector.js';
import { scanDiff } from './static-scanner.js';
import { reviewWithLlm, MAX_DIFF_BYTES, type LLMFinding } from './llm-reviewer.js';
import { processResults, updateNotifiedStatus, type MrMetadata } from './result-processor.js';

const logger = getLogger('review:pipeline');

function inferProductLine(repoId: string): string | undefined {
  const group = repoId.split('/')[0];
  if (!group || group === repoId) return undefined;
  const groupMap: Record<string, string> = JSON.parse(
    process.env.GITLAB_GROUP_MAP || '{"live":"default","lateral":"default","trade":"default"}'
  );
  return groupMap[group] || group;
}

const globalLimit = pLimit(3);
const llmLimit = pLimit(2);
const repoLocks = new Map<string, Promise<void>>();
let queueSize = 0;
const MAX_QUEUE_SIZE = 50;
const REPO_LOCK_TIMEOUT_MS = 300_000;
const MIN_ADDED_LINES_FOR_LLM = 50;

export interface PipelineInput {
  commitHash: string;
  message: string;
  branch: string;
  author: string;
  repoId: string;
  repoPath: string;
  classification: string;
  diff: string;
  files: string[];
  timestamp: number;
  productLine?: string;
  // MR 审查扩展
  reviewType?: 'commit' | 'merge_request';
  mrIid?: number;
  mrUrl?: string;
  gitlabProjectId?: number;
}

export interface PipelineRunMeta {
  startedAt: number;
  stepsCompleted: ('context' | 'static' | 'llm' | 'result')[];
  stepsFailed: Array<{ step: string; error: string }>;
  degraded: boolean;
}

export interface PipelineResult {
  commitHash: string;
  repoId: string;
  classification: string;
  totalFindings: number;
  p0Count: number;
  p1Count: number;
  p2Count: number;
  notified: boolean;
  duration: number;
  meta: PipelineRunMeta;
}

export async function enqueueReview(input: PipelineInput): Promise<PipelineResult> {
  if (queueSize >= MAX_QUEUE_SIZE) {
    throw new Error(`审查队列已满 (${MAX_QUEUE_SIZE})，请稍后重试`);
  }

  const key = input.repoId;
  const prev = repoLocks.get(key) ?? Promise.resolve();
  const timedPrev = Promise.race([
    prev,
    new Promise<void>((resolve) => setTimeout(() => {
      logger.warn({ repo: key }, '同仓库锁等待超时，强制继续');
      resolve();
    }, REPO_LOCK_TIMEOUT_MS)),
  ]);
  const done = timedPrev.then(() => globalLimit(() => runPipeline(input)));
  const guard = done.then(() => {}, () => {});
  repoLocks.set(key, guard);
  guard.then(() => {
    if (repoLocks.get(key) === guard) repoLocks.delete(key);
  });
  queueSize++;
  try {
    return await done;
  } finally {
    queueSize--;
  }
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const meta: PipelineRunMeta = {
    startedAt: Date.now(),
    stepsCompleted: [],
    stepsFailed: [],
    degraded: false,
  };

  const productLine = input.productLine || inferProductLine(input.repoId);

  logger.info({
    commit: input.commitHash.slice(0, 8),
    repo: input.repoId,
    classification: input.classification,
    fileCount: input.files.length,
    productLine,
  }, '管道启动');

  // Step 1: 收集上下文（失败时降级继续）
  let context: ReviewContext | undefined;
  try {
    context = await collectContext(input.repoId, input.files, input.message, productLine);
    meta.stepsCompleted.push('context');
  } catch (err) {
    meta.stepsFailed.push({ step: 'context', error: (err as Error).message });
    meta.degraded = true;
    logger.warn({ err }, '上下文收集失败，降级继续');
  }

  // Step 2: 静态扫描
  let staticFindings: ReturnType<typeof scanDiff> = [];
  try {
    staticFindings = input.diff ? scanDiff(input.diff, input.files) : [];
    meta.stepsCompleted.push('static');
  } catch (err) {
    meta.stepsFailed.push({ step: 'static', error: (err as Error).message });
    meta.degraded = true;
    logger.warn({ err }, '静态扫描异常，降级继续');
  }

  // Step 3: LLM 深度审查（diff 存在且 >50 行新增时触发）
  let llmResult: { findings: LLMFinding[]; skipped: boolean; skipReason?: string } = {
    findings: [], skipped: true, skipReason: 'diff 过短或不可用',
  };
  const addedLines = input.diff ? input.diff.split('\n').filter(l => l.startsWith('+')).length : 0;

  if (input.diff && addedLines > MIN_ADDED_LINES_FOR_LLM) {
    try {
      llmResult = await llmLimit(() =>
        reviewWithLlm(input.diff, context ?? {
          bugPatterns: [],
          codingRules: [],
          pastReviews: [],
          securityDomains: [],
        }, {
          staticFindings,
          commitMessage: input.message,
        }),
      );
      if (!llmResult.skipped) {
        meta.stepsCompleted.push('llm');
      } else {
        meta.stepsFailed.push({ step: 'llm', error: llmResult.skipReason || 'skipped' });
        meta.degraded = true;
      }
    } catch (err) {
      meta.stepsFailed.push({ step: 'llm', error: (err as Error).message });
      meta.degraded = true;
      logger.warn({ err }, 'LLM 审查异常，仅保留静态发现');
    }
  }

  // Step 4: 结果处理与持久化
  let processed;
  try {
    const mrMeta: MrMetadata | undefined = input.reviewType
      ? { reviewType: input.reviewType, mrIid: input.mrIid, mrUrl: input.mrUrl, gitlabProjectId: input.gitlabProjectId }
      : undefined;

    processed = await processResults(
      staticFindings,
      llmResult.findings,
      input.commitHash,
      input.repoId,
      input.classification,
      input.branch,
      input.author,
      input.diff || '',
      llmResult.skipped,
      Buffer.byteLength(input.diff || '', 'utf-8') > MAX_DIFF_BYTES,
      context,
      productLine,
      mrMeta,
    );
    meta.stepsCompleted.push('result');
  } catch (err) {
    meta.stepsFailed.push({ step: 'result', error: (err as Error).message });
    meta.degraded = true;
    logger.error({ err }, '结果处理失败');
    processed = { findings: [], p0Count: 0, p1Count: 0, p2Count: 0, needsNotification: false };
  }

  // Step 5: 通知（异步，不阻塞）
  if (processed.needsNotification) {
    sendNotificationAsync(input, processed.findings, processed.p0Count, processed.p1Count).catch(err => {
      logger.warn({ err }, '通知发送失败（不影响主流程）');
    });
  }

  const duration = Date.now() - meta.startedAt;

  logger.info({
    commit: input.commitHash.slice(0, 8),
    repo: input.repoId,
    totalFindings: processed.findings.length,
    p0: processed.p0Count,
    p1: processed.p1Count,
    p2: processed.p2Count,
    notified: processed.needsNotification,
    duration,
    degraded: meta.degraded,
    stepsCompleted: meta.stepsCompleted,
    stepsFailed: meta.stepsFailed.map(s => s.step),
  }, '管道完成');

  return {
    commitHash: input.commitHash,
    repoId: input.repoId,
    classification: input.classification,
    totalFindings: processed.findings.length,
    p0Count: processed.p0Count,
    p1Count: processed.p1Count,
    p2Count: processed.p2Count,
    notified: processed.needsNotification,
    duration,
    meta,
  };
}

async function sendNotificationAsync(
  input: PipelineInput,
  findings: unknown[],
  p0Count: number,
  p1Count: number,
): Promise<void> {
  try {
    const { sendDingTalkReview } = await import('./dingtalk-notify.js');
    await sendDingTalkReview({
      commitHash: input.commitHash,
      repoId: input.repoId,
      branch: input.branch,
      author: input.author,
      message: input.message,
      findings,
      p0Count,
      p1Count,
    });
    await updateNotifiedStatus(input.repoId, input.commitHash);
  } catch {
    logger.debug('钉钉通知模块不可用，跳过');
  }
}
