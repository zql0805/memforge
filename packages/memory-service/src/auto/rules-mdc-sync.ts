// Created by dev on 2026/04/05
// Copyright © 2026
// Rules ↔ IDE 规则文件双向同步（格式由 ideConfig.ruleFormat 决定）

import { watch, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { getLogger, getPool, getIdeConfig, createRulesAdapter } from '@memforgeai/shared';
import type { RuleFile, RuleFormat } from '@memforgeai/shared';

const logger = getLogger('auto:rules-mdc-sync');
const DEBOUNCE_MS = 3000;

interface SyncState {
  active: boolean;
  controller: AbortController;
  lastSyncHashes: Map<string, string>;
  exportCount: number;
  importCount: number;
  ruleExtension: string;
}

let syncState: SyncState | null = null;

export async function startRulesMdcSync(): Promise<void> {
  const autoSync = process.env.MEMFORGE_RULES_MDC_SYNC;
  if (autoSync !== 'true') {
    logger.info('Rules ↔ IDE 规则双向同步已禁用（设置 MEMFORGE_RULES_MDC_SYNC=true 启用）');
    return;
  }

  const ideConfig = getIdeConfig();
  const rulesDir = resolveRulesDir();
  if (!rulesDir) {
    logger.info('无法确定 IDE rules 目录，跳过双向同步');
    return;
  }

  if (!existsSync(rulesDir)) {
    try { await mkdir(rulesDir, { recursive: true }); } catch {
      logger.debug({ rulesDir }, '创建 IDE rules 目录失败，跳过同步');
      return;
    }
  }

  const controller = new AbortController();
  syncState = {
    active: true,
    controller,
    lastSyncHashes: new Map(),
    exportCount: 0,
    importCount: 0,
    ruleExtension: ideConfig.ruleExtension,
  };

  await exportActiveRulesToIde(rulesDir, ideConfig.ruleFormat, ideConfig.ruleExtension);

  startRuleWatcher(rulesDir, ideConfig.ruleFormat, ideConfig.ruleExtension).catch((err: Error) => {
    logger.error({ err: err.message }, '规则文件监控异常退出');
  });

  logger.info({ rulesDir, ruleFormat: ideConfig.ruleFormat, ruleExtension: ideConfig.ruleExtension }, 'Rules ↔ IDE 规则双向同步已启动');
}

export function stopRulesMdcSync(): void {
  if (syncState?.active) {
    syncState.controller.abort();
    syncState.active = false;
    logger.info('Rules ↔ IDE 规则双向同步已停止');
  }
}

export function getRulesMdcSyncStatus(): {
  active: boolean;
  exportCount: number;
  importCount: number;
} {
  return {
    active: syncState?.active ?? false,
    exportCount: syncState?.exportCount ?? 0,
    importCount: syncState?.importCount ?? 0,
  };
}

function resolveRulesDir(): string | null {
  const ideConfig = getIdeConfig();
  const scope = (process.env.MEMFORGE_RULES_SCOPE ?? 'global').toLowerCase();
  if (scope === 'workspace') {
    return ideConfig.projectRulesDir(process.cwd());
  }
  return ideConfig.rulesDir;
}

async function exportActiveRulesToIde(
  rulesDir: string,
  ruleFormat: RuleFormat,
  ruleExtension: string,
): Promise<void> {
  const adapter = createRulesAdapter(ruleFormat);

  try {
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string; title: string; description: string; rationale: string | null;
      example_good: string | null; example_bad: string | null;
      category: string; language: string | null; severity: string;
    }>(
      `SELECT id, title, description, rationale, example_good, example_bad, category, language, severity
       FROM memory.rules WHERE status = 'active' ORDER BY category, title`,
    );

    for (const rule of rows) {
      const filename = `memforge-${sanitizeFilename(rule.title)}${ruleExtension}`;
      const ruleFile = buildRuleFile(rule, filename);
      const fileContent = adapter.serializeRule(ruleFile);
      const hash = simpleHash(fileContent);

      if (syncState?.lastSyncHashes.get(filename) === hash) continue;

      const targetPath = join(rulesDir, filename);
      await writeFile(targetPath, fileContent, 'utf-8');
      syncState?.lastSyncHashes.set(filename, hash);
      if (syncState) syncState.exportCount++;

      logger.debug({ filename, ruleId: rule.id, ruleFormat }, '规则已导出');
    }

    logger.info({ count: rows.length, dir: rulesDir, ruleFormat }, 'Active 规则导出完成');
  } catch (err) {
    logger.warn({ err: (err as Error).message, ruleFormat }, '导出规则失败');
  }
}

async function startRuleWatcher(
  rulesDir: string,
  ruleFormat: RuleFormat,
  ruleExtension: string,
): Promise<void> {
  if (!syncState) return;

  const adapter = createRulesAdapter(ruleFormat);
  const watcher = watch(rulesDir, { signal: syncState.controller.signal });
  const pending = new Map<string, NodeJS.Timeout>();

  for await (const event of watcher) {
    if (!syncState?.active) break;

    const filename = event.filename;
    if (!filename?.endsWith(ruleExtension)) continue;

    if (filename.startsWith('memforge-')) {
      const hash = syncState.lastSyncHashes.get(filename);
      if (hash) {
        try {
          const content = await readFile(join(rulesDir, filename), 'utf-8');
          if (simpleHash(content) === hash) continue;
        } catch { continue; }
      }
    }

    const existing = pending.get(filename);
    if (existing) clearTimeout(existing);

    pending.set(filename, setTimeout(() => {
      pending.delete(filename);
      handleRuleChange(join(rulesDir, filename), filename, adapter).catch((err: Error) => {
        logger.warn({ file: filename, err: err.message }, '处理规则文件变化时出错');
      });
    }, DEBOUNCE_MS));
  }
}

async function handleRuleChange(
  filePath: string,
  filename: string,
  adapter: ReturnType<typeof createRulesAdapter>,
): Promise<void> {
  let exists = true;
  try { await stat(filePath); } catch { exists = false; }
  if (!exists) return;

  try {
    const content = await readFile(filePath, 'utf-8');

    if (/^memforge_rule_id:/m.test(content) || /^memforge_version:/m.test(content)) {
      logger.debug({ file: filename }, '跳过 Memforge 托管文件的反向同步（防止回环/双重注入）');
      return;
    }

    const parsed = adapter.parseRule(content, filename);
    if (!parsed.body || parsed.body.length < 10) return;

    const pool = getPool();

    const { rows } = await pool.query(
      `SELECT id FROM memory.rules WHERE title = $1 AND status IN ('active', 'candidate', 'voting') LIMIT 1`,
      [parsed.title],
    );

    if (rows.length > 0) {
      await pool.query(
        `UPDATE memory.rules SET description = $1, updated_at = NOW() WHERE id = $2`,
        [parsed.description || parsed.body.slice(0, 5000), rows[0].id],
      );
      logger.info({ file: filename, ruleId: rows[0].id }, '规则文件变更已同步到数据库');
    } else {
      await pool.query(
        `INSERT INTO memory.rules (project_id, rule_type, title, description, category, severity, status, source)
         VALUES ('default', 'coding', $1, $2, $3, $4, 'candidate', 'manual')`,
        [parsed.title, parsed.body.slice(0, 5000), 'convention', 'info'],
      );
      logger.info({ file: filename }, '规则文件已导入为新规则候选');
    }

    if (syncState) syncState.importCount++;
  } catch (err) {
    logger.warn({ file: filename, err: (err as Error).message }, '规则文件处理失败');
  }
}

function buildRuleFile(
  rule: {
    id: string; title: string; description: string; rationale: string | null;
    example_good: string | null; example_bad: string | null;
    category: string; language: string | null; severity: string;
  },
  filename: string,
): RuleFile {
  const body = [
    `# ${rule.title}`,
    '',
    rule.description,
    ...(rule.rationale ? ['', `## 原因`, '', rule.rationale] : []),
    ...(rule.example_good ? ['', '## 正确示例', '', '```', rule.example_good, '```'] : []),
    ...(rule.example_bad ? ['', '## 错误示例', '', '```', rule.example_bad, '```'] : []),
  ].join('\n');

  const globs = rule.language ? [`**/*.${langToExt(rule.language)}`] : undefined;

  return {
    filename,
    title: rule.title,
    description: rule.title,
    content: '',
    body,
    frontmatter: {
      description: rule.title,
      globs: globs ?? '',
      alwaysApply: true,
      memforge_rule_id: rule.id,
      memforge_version: '1.0.0',
    },
    globs,
    alwaysApply: true,
  };
}

function sanitizeFilename(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function langToExt(lang: string): string {
  const map: Record<string, string> = {
    java: 'java', php: 'php', javascript: 'js', typescript: 'ts',
    python: 'py', go: 'go', vue: 'vue', rust: 'rs',
  };
  return map[lang.toLowerCase()] ?? '*';
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}
