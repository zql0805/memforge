// Created by dev on 2026/06/01
// Git Hooks 自动安装器 — MCP 连接时为当前仓库安装 post-commit / post-merge hooks
// 产品线归属校验 + token 嵌入脚本 + DB 绑定 product_line

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';
import { getLogger, getIdeConfig, getPool } from '@memforgeai/shared';

const logger = getLogger('git-hooks-installer');

const HOOK_MARKER = '# [memforge-auto-installed]';
const MEMFORGE_VERSION = '1.4.0';

/**
 * 将 Gateway URL 写入共享配置 ~/.memforge/config，
 * 所有仓库的 hook 脚本运行时从此文件读取 URL，
 * 服务器迁移只需改这一处。
 */
function writeSharedConfig(gatewayUrl: string): void {
  const configDir = join(homedir(), '.memforge');
  const configPath = join(configDir, 'config');
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    const content = `# Memforge 共享配置 — 由 MCP 连接时自动生成，勿手动编辑\nGATEWAY_URL=${gatewayUrl}\n`;
    writeFileSync(configPath, content, 'utf-8');
    logger.debug({ configPath, gatewayUrl }, '共享配置已更新');
  } catch (err) {
    logger.debug({ err: (err as Error).message }, '共享配置写入失败（不影响主流程）');
  }
}

function getGatewayUrl(): string {
  return process.env.MEMFORGE_GATEWAY_URL
    || process.env.GATEWAY_URL
    || `http://127.0.0.1:${process.env.GATEWAY_PORT || '3000'}`;
}

function getProductLine(): string | null {
  return process.env.MEMFORGE_PRODUCT_LINE || null;
}

function isRepoInProductLine(projectRoot: string, productLine: string | null): boolean {
  if (!productLine) return true;

  const ideConfig = getIdeConfig();
  const registryPath = join(ideConfig.configDir, `${productLine}-registry.json`);

  if (!existsSync(registryPath)) {
    logger.debug({ productLine, registryPath }, '产品线注册表不存在，允许安装（无法校验）');
    return true;
  }

  try {
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    const repos = registry.repos ?? {};
    const normalizedRoot = projectRoot.replace(/\/$/, '');

    for (const [, info] of Object.entries(repos) as Array<[string, { localPath?: string }]>) {
      const localPath = info.localPath?.replace(/^~/, homedir()).replace(/\/$/, '');
      if (localPath && normalizedRoot === localPath) {
        return true;
      }
    }

    logger.debug({ projectRoot, productLine }, '仓库不在本实例的产品线注册表中，跳过 hook 安装');
    return false;
  } catch (err) {
    logger.debug({ err: (err as Error).message }, '注册表读取失败，允许安装');
    return true;
  }
}

/**
 * 为当前仓库生成（或复用）一个绑定了 product_line 的 hook token。
 * token 直接嵌入 hook 脚本，不依赖共享文件。
 */
async function provisionToken(
  projectRoot: string,
  productLine: string | null,
  userId: string | null,
): Promise<string> {
  const pool = getPool();

  // 先检查是否已有该仓库 + 产品线的有效 token
  try {
    const existing = await pool.query(
      `SELECT token FROM memory.hook_tokens
       WHERE repo_path = $1 AND is_active = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [projectRoot],
    );
    if (existing.rows.length > 0) {
      return existing.rows[0].token as string;
    }
  } catch {
    // hook_tokens 表可能尚不含新字段，降级到生成新 token
  }

  const token = 'mfh_' + crypto.randomBytes(24).toString('hex');

  try {
    await pool.query(
      `INSERT INTO memory.hook_tokens (token, description, is_active, product_line, repo_path, created_by)
       VALUES ($1, $2, TRUE, $3, $4, $5)`,
      [
        token,
        `auto:${projectRoot.split('/').pop() ?? 'repo'}`,
        productLine,
        projectRoot,
        userId,
      ],
    );
    logger.info({ tokenPrefix: token.slice(0, 10), productLine, repo: projectRoot }, 'Hook Token 已自动创建并绑定产品线');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Hook Token 入库失败（降级到仅本地使用）');
  }

  return token;
}

function generateHookScript(
  hookType: 'post-commit' | 'post-merge',
  token: string,
): string {
  const gatewayUrl = getGatewayUrl();
  const productLine = getProductLine();
  const lines = [
    '#!/bin/bash',
    `${HOOK_MARKER} v${MEMFORGE_VERSION}`,
    `# Memforge Git Hook: ${hookType}`,
    `# Target: ${gatewayUrl}${productLine ? ` (product_line: ${productLine})` : ''}`,
    '',
    `HOOK_TOKEN="${token}"`,
    '',
    '# 从共享配置动态读取 Gateway URL，服务器迁移只需改 ~/.memforge/config',
    `MEMFORGE_URL="${gatewayUrl}"`,
    'MEMFORGE_CONFIG="$HOME/.memforge/config"',
    'if [ -f "$MEMFORGE_CONFIG" ]; then',
    '  _URL=$(grep \'^GATEWAY_URL=\' "$MEMFORGE_CONFIG" | cut -d= -f2-)',
    '  [ -n "$_URL" ] && MEMFORGE_URL="$_URL"',
    'fi',
    '',
  ];

  if (hookType === 'post-commit') {
    lines.push(
      'COMMIT=$(git rev-parse HEAD 2>/dev/null)',
      "MESSAGE=$(git log -1 --format='%s' HEAD 2>/dev/null)",
      "AUTHOR=$(git log -1 --format='%an' HEAD 2>/dev/null)",
      'BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)',
      'STATS=$(git diff --shortstat HEAD~1..HEAD 2>/dev/null)',
      "FILES=$(git diff --name-only HEAD~1..HEAD 2>/dev/null | head -50 | tr '\\n' ',' | sed 's/,$//')",
      "DELETED_FILES=$(git diff --diff-filter=D --name-only HEAD~1..HEAD 2>/dev/null | head -20 | tr '\\n' ',' | sed 's/,$//')",
      'REPO=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null)',
      'REPO_PATH=$(git rev-parse --show-toplevel 2>/dev/null)',
      'IS_MERGE="false"',
      'if git rev-parse HEAD^2 >/dev/null 2>&1; then IS_MERGE="true"; fi',
      'DIFF=$(git diff HEAD~1..HEAD 2>/dev/null | head -c 51200)',
      "ej() { printf '%s' \"$1\" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()),end=\"\")' 2>/dev/null || printf '\"'\"'\"'%s'\"'\"'\"' \"$1\"; }",
      '',
      '(curl -s -X POST "$MEMFORGE_URL/api/hooks/commit" \\',
      '  -H "X-Hook-Token: $HOOK_TOKEN" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d "{\\"commit\\":\\"$COMMIT\\",\\"message\\":$(ej "$MESSAGE"),\\"author\\":$(ej "$AUTHOR"),\\"branch\\":\\"$BRANCH\\",\\"stats\\":$(ej "$STATS"),\\"files\\":\\"$FILES\\",\\"deleted_files\\":\\"$DELETED_FILES\\",\\"repo\\":\\"$REPO\\",\\"repo_path\\":$(ej "$REPO_PATH"),\\"diff\\":$(ej "$DIFF"),\\"is_merge\\":$IS_MERGE,\\"timestamp\\":$(date +%s)}" \\',
      '  --connect-timeout 5 --max-time 30 &) 2>/dev/null',
    );
  } else {
    lines.push(
      'BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)',
      'REPO=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null)',
      'REPO_PATH=$(git rev-parse --show-toplevel 2>/dev/null)',
      "MERGED_COMMITS=$(git log --oneline ORIG_HEAD..HEAD 2>/dev/null | head -20 | tr '\\n' ';' | sed 's/;$//')",
      "ej() { printf '%s' \"$1\" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()),end=\"\")' 2>/dev/null || printf '\"'\"'\"'%s'\"'\"'\"' \"$1\"; }",
      '',
      '(curl -s -X POST "$MEMFORGE_URL/api/hooks/commit" \\',
      '  -H "X-Hook-Token: $HOOK_TOKEN" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d "{\\"commit\\":\\"merge\\",\\"message\\":$(ej \\"merge: $MERGED_COMMITS\\"),\\"author\\":\\"git-merge\\",\\"branch\\":\\"$BRANCH\\",\\"repo\\":\\"$REPO\\",\\"repo_path\\":$(ej \\"$REPO_PATH\\"),\\"is_merge\\":true,\\"timestamp\\":$(date +%s)}" \\',
      '  --connect-timeout 5 --max-time 30 &) 2>/dev/null',
    );
  }

  lines.push('exit 0', '');
  return lines.join('\n');
}

function extractInstalledVersion(hookPath: string): string | null {
  if (!existsSync(hookPath)) return null;
  const content = readFileSync(hookPath, 'utf-8');
  const match = content.match(/# \[memforge-auto-installed\] v(\S+)/);
  return match?.[1] ?? null;
}

function isMemforgeHook(hookPath: string): boolean {
  if (!existsSync(hookPath)) return false;
  const content = readFileSync(hookPath, 'utf-8');
  // 兼容旧版脚本（由 /api/setup/git-hooks 生成，含 Memforge 字样但无 HOOK_MARKER）
  return content.includes(HOOK_MARKER) || content.includes('# Memforge Git Hook:');
}

function extractInstalledUrl(hookPath: string): string | null {
  if (!existsSync(hookPath)) return null;
  const content = readFileSync(hookPath, 'utf-8');
  const match = content.match(/^MEMFORGE_URL="([^"]+)"$/m);
  return match?.[1] ?? null;
}

export interface GitHooksInstallResult {
  projectRoot: string;
  gitDir: string | null;
  installed: string[];
  updated: string[];
  skipped: string[];
  userHookPreserved: string[];
  productLineSkipped: boolean;
}

export async function installGitHooks(
  projectRoot: string,
  userId?: string | null,
): Promise<GitHooksInstallResult> {
  const result: GitHooksInstallResult = {
    projectRoot,
    gitDir: null,
    installed: [],
    updated: [],
    skipped: [],
    userHookPreserved: [],
    productLineSkipped: false,
  };

  const gitDir = join(projectRoot, '.git');
  if (!existsSync(gitDir)) {
    logger.debug({ projectRoot }, '非 git 仓库，跳过 git hooks 安装');
    return result;
  }

  const productLine = getProductLine();
  if (!isRepoInProductLine(projectRoot, productLine)) {
    result.productLineSkipped = true;
    return result;
  }

  result.gitDir = gitDir;

  const hooksDir = join(gitDir, 'hooks');
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  const currentUrl = getGatewayUrl();
  const hooks: Array<'post-commit' | 'post-merge'> = ['post-commit', 'post-merge'];

  // 每次 MCP 连接都刷新共享配置，确保所有仓库的 hook 能读到最新 URL
  writeSharedConfig(currentUrl);

  // URL 通过共享配置动态读取，只需比对版本号决定是否重写脚本
  let needsInstall = false;
  for (const hookType of hooks) {
    const hookPath = join(hooksDir, hookType);
    if (existsSync(hookPath) && !isMemforgeHook(hookPath)) continue;
    const installedVersion = extractInstalledVersion(hookPath);
    if (installedVersion === MEMFORGE_VERSION) continue;
    needsInstall = true;
    break;
  }

  if (!needsInstall) {
    result.skipped.push(...hooks);
    return result;
  }

  // 按需 provision token（绑定 product_line + repo_path）
  const token = await provisionToken(projectRoot, productLine, userId ?? null);

  for (const hookType of hooks) {
    const hookPath = join(hooksDir, hookType);

    if (existsSync(hookPath) && !isMemforgeHook(hookPath)) {
      result.userHookPreserved.push(hookType);
      logger.debug({ hookType, hookPath }, '已有用户自定义 hook，不覆盖');
      continue;
    }

    const installedVersion = extractInstalledVersion(hookPath);
    if (installedVersion === MEMFORGE_VERSION) {
      result.skipped.push(hookType);
      continue;
    }

    const script = generateHookScript(hookType, token);
    writeFileSync(hookPath, script, 'utf-8');
    chmodSync(hookPath, 0o755);

    if (installedVersion) {
      result.updated.push(hookType);
      logger.info({ hookType, from: installedVersion, to: MEMFORGE_VERSION, url: currentUrl }, 'Git hook 已更新');
    } else {
      result.installed.push(hookType);
      logger.info({ hookType, url: currentUrl }, 'Git hook 已安装');
    }
  }

  return result;
}
