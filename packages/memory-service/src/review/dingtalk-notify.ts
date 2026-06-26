import { getLogger, getPool, getRedis } from '@memforgeai/shared';
import crypto from 'node:crypto';

const logger = getLogger('notify:dingtalk');

/** 钉钉 Webhook 请求超时（毫秒） */
const DINGTALK_REQUEST_TIMEOUT_MS = 10_000;

export interface DingTalkReviewPayload {
  commitHash: string;
  repoId: string;
  branch: string;
  author: string;
  message: string;
  findings: unknown[];
  p0Count: number;
  p1Count: number;
}

interface DingTalkConfig {
  webhookUrl: string;
  secret?: string;
  enabled: boolean;
  minSeverity: 'P0' | 'P1';
  quietHourStart: number;
  quietHourEnd: number;
  webUrl: string;
}

function loadDingTalkConfig(): DingTalkConfig | null {
  const webhookUrl = process.env.DINGTALK_WEBHOOK_URL;
  if (!webhookUrl) return null;

  const enabled = process.env.DINGTALK_NOTIFY_ENABLED !== 'false';
  const minSeverity = process.env.DINGTALK_NOTIFY_MIN_SEVERITY === 'P0' ? 'P0' : 'P1';

  let quietStart = 23;
  let quietEnd = 8;
  const quietHours = process.env.DINGTALK_QUIET_HOURS;
  if (quietHours) {
    const parts = quietHours.split('-').map(s => parseInt(s.trim(), 10));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      quietStart = parts[0];
      quietEnd = parts[1];
    }
  }

  return {
    webhookUrl,
    secret: process.env.DINGTALK_WEBHOOK_SECRET || undefined,
    enabled,
    minSeverity,
    quietHourStart: quietStart,
    quietHourEnd: quietEnd,
    webUrl: process.env.MEMFORGE_WEB_URL || 'https://memforge.example.com',
  };
}

function buildSignedUrl(config: DingTalkConfig): string {
  if (!config.secret) return config.webhookUrl;

  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${config.secret}`;
  const hmac = crypto.createHmac('sha256', config.secret);
  hmac.update(stringToSign);
  const sign = encodeURIComponent(hmac.digest('base64'));

  return `${config.webhookUrl}&timestamp=${timestamp}&sign=${sign}`;
}

function buildActionCard(payload: DingTalkReviewPayload, webUrl: string): object {
  const shortHash = payload.commitHash.slice(0, 8);
  const severityEmoji = payload.p0Count > 0 ? '🔴' : '🟡';
  const lines: string[] = [];

  lines.push(`### ${severityEmoji} 自动代码审查报告`);
  lines.push('');
  lines.push(`**仓库**: ${payload.repoId}`);
  lines.push(`**分支**: ${payload.branch}`);
  lines.push(`**提交**: ${shortHash} ${payload.message.slice(0, 80)}`);
  lines.push(`**作者**: ${payload.author}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`**发现**: P0=${payload.p0Count} P1=${payload.p1Count}`);
  lines.push('');

  const topFindings = (payload.findings as Array<{
    severity: string;
    category: string;
    file: string;
    line?: number;
    description: string;
    suggestion: string;
  }>).filter(f => f.severity !== 'P2').slice(0, 5);

  const severityEmojis: Record<string, string> = { P0: '🔴', P1: '🟡', P2: '🔵' };
  for (const f of topFindings) {
    lines.push(`${severityEmojis[f.severity] || ''} **[${f.severity}]** ${f.category}: ${f.description}`);
    lines.push(`  📄 \`${f.file}${f.line ? ':' + f.line : ''}\``);
    lines.push(`  💡 ${f.suggestion}`);
    lines.push('');
  }

  if (payload.findings.length > 5) {
    lines.push(`... 还有 ${payload.findings.length - 5} 个发现`);
  }

  return {
    msgtype: 'actionCard',
    actionCard: {
      title: `[Code Review] ${payload.repoId} 发现 ${payload.findings.length} 个问题`,
      text: lines.join('\n'),
      singleTitle: '查看详情',
      singleURL: `${webUrl}/reviews?commit=${encodeURIComponent(payload.commitHash)}`,
    },
  };
}

export async function sendDingTalkReview(payload: DingTalkReviewPayload): Promise<boolean> {
  const config = loadDingTalkConfig();
  if (!config || !config.enabled) {
    logger.debug('钉钉通知未启用，跳过');
    return false;
  }

  const policyResult = await checkNotifyPolicy(config, payload);
  if (!policyResult.allowed) {
    await logNotification('dingtalk', 'code_review', payload.commitHash,
      { repoId: payload.repoId, reason: policyResult.reason }, 'suppressed');
    return false;
  }

  const message = buildActionCard(payload, config.webUrl);
  const url = buildSignedUrl(config);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(DINGTALK_REQUEST_TIMEOUT_MS),
    });

    const result = await resp.json() as { errcode: number; errmsg: string };

    if (result.errcode !== 0) {
      logger.error({ errcode: result.errcode, errmsg: result.errmsg }, '钉钉发送失败');
      await logNotification('dingtalk', 'code_review', payload.commitHash,
        { repoId: payload.repoId, errcode: result.errcode }, 'failed', result.errmsg);
      return false;
    }

    logger.info({ commit: payload.commitHash.slice(0, 8), repo: payload.repoId }, '钉钉通知已发送');
    await logNotification('dingtalk', 'code_review', payload.commitHash,
      { repoId: payload.repoId, p0: payload.p0Count, p1: payload.p1Count }, 'sent');
    return true;
  } catch (err) {
    logger.error({ err }, '钉钉请求异常');
    await logNotification('dingtalk', 'code_review', payload.commitHash,
      { error: (err as Error).message }, 'failed', (err as Error).message);
    return false;
  }
}

async function logNotification(
  channel: string,
  eventType: string,
  eventRef: string,
  payload: unknown,
  status: 'sent' | 'failed' | 'suppressed',
  errorMessage?: string,
): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO memory.notification_log (channel, event_type, event_ref, payload, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [channel, eventType, eventRef, JSON.stringify(payload), status, errorMessage ?? null],
    );
  } catch (err) {
    logger.debug({ err }, '写入 notification_log 失败（不影响主流程）');
  }
}

// ─── 通知策略（Redis 优先，降级内存） ───

const localDedup = new Map<string, number>();
const localRateCounter = new Map<string, number[]>();
const DEDUP_WINDOW_S = 600;
const RATE_LIMIT_PER_REPO = 5;
const RATE_WINDOW_S = 60;

interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

async function isDuplicate(key: string): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    const rk = `mf:notify:dedup:${key}`;
    const existed = await redis.set(rk, '1', 'EX', DEDUP_WINDOW_S, 'NX');
    return existed === null;
  }
  const ts = localDedup.get(key);
  if (ts && Date.now() - ts < DEDUP_WINDOW_S * 1000) return true;
  localDedup.set(key, Date.now());
  if (localDedup.size > 1000) {
    const cutoff = Date.now() - DEDUP_WINDOW_S * 1000;
    for (const [k, v] of localDedup) { if (v < cutoff) localDedup.delete(k); }
  }
  return false;
}

async function checkRepoRate(repoId: string): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    const rk = `mf:notify:rate:${repoId}`;
    const count = await redis.incr(rk);
    if (count === 1) await redis.expire(rk, RATE_WINDOW_S);
    return count > RATE_LIMIT_PER_REPO;
  }
  const nowMs = Date.now();
  let timestamps = localRateCounter.get(repoId) || [];
  timestamps = timestamps.filter(t => nowMs - t < RATE_WINDOW_S * 1000);
  if (timestamps.length >= RATE_LIMIT_PER_REPO) return true;
  timestamps.push(nowMs);
  localRateCounter.set(repoId, timestamps);
  return false;
}

async function checkNotifyPolicy(config: DingTalkConfig, payload: DingTalkReviewPayload): Promise<PolicyResult> {
  if (config.minSeverity === 'P0' && payload.p0Count === 0) {
    return { allowed: false, reason: 'min_severity_p0_only' };
  }
  if (config.minSeverity === 'P1' && payload.p0Count === 0 && payload.p1Count < 3) {
    return { allowed: false, reason: 'below_threshold' };
  }

  const now = new Date();
  const hour = now.getHours();
  const inQuietHours = config.quietHourStart > config.quietHourEnd
    ? (hour >= config.quietHourStart || hour < config.quietHourEnd)
    : (hour >= config.quietHourStart && hour < config.quietHourEnd);

  if (inQuietHours && payload.p0Count === 0) {
    logger.info({ quietStart: config.quietHourStart, quietEnd: config.quietHourEnd }, '静默时段，非 P0 通知跳过');
    return { allowed: false, reason: 'quiet_hours' };
  }

  const dedupKey = `${payload.repoId}:${payload.commitHash}`;
  if (await isDuplicate(dedupKey)) {
    return { allowed: false, reason: 'duplicate_commit' };
  }

  if (await checkRepoRate(payload.repoId)) {
    logger.info({ repoId: payload.repoId }, '同仓库通知速率限制');
    return { allowed: false, reason: 'repo_rate_limited' };
  }

  return { allowed: true };
}
