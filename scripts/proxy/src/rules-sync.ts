// Created by dev on 2026/06/11
// Copyright © 2026
// IDE Rules + Hooks + Git Hooks 同步

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { homedir } from 'os';
import {
  GATEWAY_URL, API_KEY, SKIP_RULES_SYNC,
  getIdeType, getIdeRulesDir, getIdeHooksDir, getHooksConfigPath,
  containsMemforgeHook, log,
} from './config.js';

function extractVersion(content: string): string | null {
  return content.match(/memforge_version:\s*"([^"]+)"/)?.[1] ?? null;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function shouldInstallRule(templateContent: string, targetPath: string): 'install' | 'update' | 'skip' {
  if (!existsSync(targetPath)) return 'install';
  const existing = readFileSync(targetPath, 'utf-8');
  const existingVersion = extractVersion(existing);
  const templateVersion = extractVersion(templateContent);
  if (!existingVersion) return 'skip';
  if (!templateVersion) return 'skip';
  if (compareSemver(existingVersion, templateVersion) < 0) return 'update';
  return 'skip';
}

export async function syncIdeRules(): Promise<void> {
  if (SKIP_RULES_SYNC) {
    log('跳过 IDE Rules 同步 (MEMFORGE_SKIP_RULES_SYNC=true)');
    return;
  }

  try {
    const ide = getIdeType();
    const url = `${GATEWAY_URL.replace(/\/$/, '')}/api/setup/ide-rules?ide=${encodeURIComponent(ide)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      log(`获取 IDE Rules 失败 (HTTP ${resp.status})，跳过同步`);
      return;
    }
    const { rules } = await resp.json() as { rules: Array<{ filename: string; content: string }> };
    if (!rules || rules.length === 0) {
      log('服务端无可用规则模板');
      return;
    }

    const rulesDir = getIdeRulesDir();
    if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });

    let installed = 0, updated = 0, skipped = 0;
    for (const rule of rules) {
      const targetPath = join(rulesDir, rule.filename);
      const action = shouldInstallRule(rule.content, targetPath);
      if (action === 'skip') { skipped++; continue; }
      writeFileSync(targetPath, rule.content, 'utf-8');
      if (action === 'install') { installed++; log(`已安装规则: ${rule.filename}`); }
      else { updated++; log(`已更新规则: ${rule.filename}`); }
    }
    if (installed > 0 || updated > 0) {
      log(`IDE Rules 同步完成: 安装 ${installed}, 更新 ${updated}, 跳过 ${skipped}`);
    }
  } catch (err: any) {
    log(`IDE Rules 同步失败 (${err.message})，不影响 MCP 功能`);
  }
}

export function mergeHooksConfig(configPath: string, hooksConfig: Record<string, any>): Record<string, any> {
  if (!existsSync(configPath)) return hooksConfig;
  try {
    const existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    const merged: Record<string, any> = { ...existing, ...hooksConfig, hooks: {} };
    for (const [event, hooks] of Object.entries(existing.hooks ?? {})) {
      const userHooks = ((hooks as any[]) ?? []).filter((h: unknown) => !containsMemforgeHook(h));
      if (userHooks.length > 0) merged.hooks[event] = userHooks;
    }
    for (const [event, hooks] of Object.entries(hooksConfig.hooks ?? {})) {
      merged.hooks[event] = [...(merged.hooks[event] ?? []), ...((hooks as any[]) ?? [])];
    }
    return merged;
  } catch {
    return hooksConfig;
  }
}

export async function syncIdeHooks(): Promise<void> {
  if (process.env.MEMFORGE_SKIP_HOOKS_SYNC === 'true') return;
  try {
    const ide = getIdeType();
    const hooksDir = join(getIdeHooksDir(), 'memforge');
    const hooksConfigPath = getHooksConfigPath();

    const localVersion = existsSync(join(hooksDir, '.version'))
      ? readFileSync(join(hooksDir, '.version'), 'utf-8').trim()
      : null;

    const resp = await fetch(`${GATEWAY_URL.replace(/\/$/, '')}/api/setup/ide-hooks?ide=${encodeURIComponent(ide)}`, {
      headers: localVersion ? { 'If-None-Match': localVersion } : {},
    });
    if (resp.status === 304) return;
    if (!resp.ok) { log(`Hooks 同步失败 (HTTP ${resp.status})，跳过`); return; }

    const { scripts, hooksConfig, version } = await resp.json() as {
      scripts: Array<{ filename: string; content: string }>;
      hooksConfig?: Record<string, any>;
      version: string;
    };
    if (!scripts || scripts.length === 0) return;

    mkdirSync(hooksDir, { recursive: true });

    let installed = 0;
    for (const script of scripts) {
      const targetPath = join(hooksDir, script.filename);
      const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : '';
      if (existing !== script.content) {
        writeFileSync(targetPath, script.content, { mode: 0o755 });
        installed++;
      }
    }

    if (hooksConfig) {
      const merged = mergeHooksConfig(hooksConfigPath, hooksConfig);
      writeFileSync(hooksConfigPath, JSON.stringify(merged, null, 2));
    }

    writeFileSync(join(hooksDir, '.version'), version);
    if (installed > 0) log(`IDE Hooks 已更新 (${installed} 个脚本)`);
  } catch (err: any) {
    log(`IDE Hooks 同步失败 (${err?.message})，不影响 MCP 功能`);
  }
}

export async function inlineSyncHooksAfterUpdate(): Promise<void> {
  try {
    const hooksDir = join(getIdeHooksDir(), 'memforge');
    const hooksConfigPath = getHooksConfigPath();
    const ide = getIdeType();

    const hResp = await fetch(`${GATEWAY_URL.replace(/\/$/, '')}/api/setup/ide-hooks?ide=${encodeURIComponent(ide)}`);
    if (!hResp.ok) return;

    const { scripts, hooksConfig, version } = await hResp.json() as {
      scripts: Array<{ filename: string; content: string }>;
      hooksConfig?: Record<string, any>;
      version: string;
    };
    if (!scripts || scripts.length === 0) return;

    mkdirSync(hooksDir, { recursive: true });

    let installed = 0;
    for (const script of scripts) {
      const targetPath = join(hooksDir, script.filename);
      const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : '';
      if (existing !== script.content) {
        writeFileSync(targetPath, script.content, { mode: 0o755 });
        installed++;
      }
    }

    if (hooksConfig) {
      const merged = mergeHooksConfig(hooksConfigPath, hooksConfig);
      writeFileSync(hooksConfigPath, JSON.stringify(merged, null, 2));
    }

    writeFileSync(join(hooksDir, '.version'), version);
    if (installed > 0) log(`Hooks 已随 proxy 更新同步安装 (${installed} 个脚本)`);
  } catch (err: any) {
    log(`更新后 hooks 同步失败: ${err?.message}`);
  }
}

export function writeSharedConfig(): void {
  const configDir = join(homedir(), '.memforge');
  const configPath = join(configDir, 'config');
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const content = [
      '# Memforge 共享配置 — 由 MCP proxy 自动生成，勿手动编辑',
      `GATEWAY_URL=${GATEWAY_URL.replace(/\/$/, '')}`,
      `HOOK_API_KEY=${API_KEY}`,
      '',
    ].join('\n');
    writeFileSync(configPath, content, { mode: 0o600 });
  } catch (err: any) {
    log(`共享配置写入失败: ${err?.message}`);
  }
}

const HOOK_MARKER = '# [memforge-auto-installed]';

function detectProjectRoot(): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch { return null; }
}

function isMemforgeHook(hookPath: string): boolean {
  if (!existsSync(hookPath)) return false;
  const content = readFileSync(hookPath, 'utf-8');
  return content.includes(HOOK_MARKER) || content.includes('# Memforge Git Hook:');
}

function extractHookVersion(hookPath: string): string | null {
  if (!existsSync(hookPath)) return null;
  const content = readFileSync(hookPath, 'utf-8');
  return content.match(/# \[memforge-auto-installed\] v(\S+)/)?.[1] ?? null;
}

export async function syncGitHooks(): Promise<void> {
  if (process.env.MEMFORGE_SKIP_GIT_HOOKS === 'true') return;
  try {
    const projectRoot = detectProjectRoot();
    if (!projectRoot) return;

    const hooksDir = join(projectRoot, '.git', 'hooks');
    if (!existsSync(hooksDir)) return;

    const firstHookPath = join(hooksDir, 'post-commit');
    const localVersion = extractHookVersion(firstHookPath);
    const resp = await fetch(`${GATEWAY_URL.replace(/\/$/, '')}/api/setup/git-hooks-template`, {
      headers: localVersion ? { 'If-None-Match': localVersion } : {},
    });
    if (resp.status === 304) return;
    if (!resp.ok) { log(`Git Hooks 模板获取失败 (HTTP ${resp.status})，跳过`); return; }

    const { version, scripts } = await resp.json() as {
      version: string;
      scripts: Record<string, string>;
    };
    if (!scripts) return;

    let installed = 0;
    for (const [hookType, content] of Object.entries(scripts)) {
      const hookPath = join(hooksDir, hookType);
      if (existsSync(hookPath) && !isMemforgeHook(hookPath)) continue;
      const currentVersion = extractHookVersion(hookPath);
      if (currentVersion === version) continue;
      writeFileSync(hookPath, content, { mode: 0o755 });
      installed++;
    }

    if (installed > 0) log(`Git Hooks 已升级到 v${version} (${installed} 个)`);
  } catch (err: any) {
    log(`Git Hooks 同步失败: ${err?.message}`);
  }
}
