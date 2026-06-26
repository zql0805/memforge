// Created by dev on 2026/06/11
// Copyright © 2026
// Proxy 配置 — 环境变量、IDE 检测、路径

import { hostname, platform, homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export const PROXY_VERSION = '3.0.0';
export const HEARTBEAT_INTERVAL_MS = 25_000;
export const RECONNECT_BASE_MS = 2_000;
export const RECONNECT_MAX_MS = 60_000;

export const GATEWAY_URL = process.env.MEMFORGE_GATEWAY_URL || '';
export const API_KEY = process.env.MEMFORGE_API_KEY || '';
export const SKIP_RULES_SYNC = process.env.MEMFORGE_SKIP_RULES_SYNC === 'true';
export const SELF_PATH = new URL(import.meta.url).pathname;

export type IdeType = 'cursor' | 'claude-code' | 'codex' | 'trae' | 'trae-cn';

export function getIdeType(): IdeType {
  const explicit = (process.env.MEMFORGE_IDE || '').toLowerCase();
  if (['cursor', 'claude-code', 'codex', 'trae', 'trae-cn'].includes(explicit)) return explicit as IdeType;
  if (process.env.CODEX_HOME || process.env.CODEX_CLI) return 'codex';
  if (process.env.CLAUDE_CODE || process.env.CLAUDE_SESSION_ID) return 'claude-code';
  if (process.env.TRAE_SESSION_ID) return existsSync(join(homedir(), '.trae-cn')) ? 'trae-cn' : 'trae';
  if (process.env.CURSOR_SESSION_ID) return 'cursor';
  return 'cursor';
}

export function getDefaultDeviceId(): string {
  const map: Record<IdeType, string> = {
    'cursor': 'cursor-mcp-client',
    'claude-code': 'claude-code-mcp-client',
    'codex': 'codex-mcp-client',
    'trae': 'trae-mcp-client',
    'trae-cn': 'trae-cn-mcp-client',
  };
  return map[getIdeType()] || 'cursor-mcp-client';
}

export const DEVICE_ID = process.env.MEMFORGE_DEVICE_ID || getDefaultDeviceId();

export function getIdeDir(): string {
  const customDir = process.env.MEMFORGE_IDE_DIR;
  if (customDir) {
    return customDir.startsWith('~') ? join(homedir(), customDir.slice(1)) : customDir;
  }
  const map: Record<string, string> = {
    'cursor': '.cursor',
    'claude-code': '.claude',
    'codex': '.codex',
    'trae': '.trae',
    'trae-cn': '.trae-cn',
  };
  return join(homedir(), map[getIdeType()] || '.cursor');
}

export function getIdeRulesDir(): string {
  if (getIdeType() === 'codex') return getIdeDir();
  return join(getIdeDir(), 'rules');
}

export function getIdeRegistryDir(): string {
  return getIdeDir();
}

export function getIdeHooksDir(): string {
  return join(getIdeDir(), 'hooks');
}

export function getHooksConfigPath(): string {
  return getIdeType() === 'claude-code'
    ? join(getIdeDir(), 'settings.json')
    : join(getIdeDir(), 'hooks.json');
}

export function containsMemforgeHook(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('hooks/memforge/');
  if (Array.isArray(value)) return value.some(containsMemforgeHook);
  if (value && typeof value === 'object') return Object.values(value).some(containsMemforgeHook);
  return false;
}

export function getMachineInfo() {
  return {
    hostname: hostname(),
    platform: platform(),
    cwd: process.cwd(),
    proxyVersion: PROXY_VERSION,
  };
}

export function log(msg: string): void {
  process.stderr.write(`[mcp-proxy] ${msg}\n`);
}
