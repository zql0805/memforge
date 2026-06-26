// Created by dev on 2026/05/20
// Hooks 格式适配器 — 支持 Cursor/Codex hooks.json 和 Claude Code settings.json

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getLogger } from './logger.js';
import type { IdeType } from './ide-config.js';

const logger = getLogger('ide-hooks-adapter');

/** server.name 转合法环境变量名片段 */
export function sanitizeEnvVarName(name: string): string {
  return name
    .replace(/[-.\s]+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
}

function parseHooksJsonSafe(raw: string, configPath: string): Record<string, unknown> {
  try {
    const data = JSON.parse(raw);
    return typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
  } catch (err) {
    logger.warn({ err, configPath }, 'Hooks 配置文件 JSON 解析失败，使用空配置');
    return {};
  }
}

// ═══════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════

export interface HookEntry {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

export interface IdeHooksAdapter {
  readHooks(configDir: string): Promise<HookEntry[]>;
  writeHooks(configDir: string, hooks: HookEntry[]): Promise<void>;
  isSupported(): boolean;
}

// 标准化事件名 (Memforge 内部统一用 camelCase)
type StandardEvent = 'sessionStart' | 'preToolUse' | 'postToolUse' | 'stop'
  | 'beforeShellExecution' | 'userPromptSubmit';

// ═══════════════════════════════════════
// 事件名映射
// ═══════════════════════════════════════

const CURSOR_EVENTS: Record<StandardEvent, string> = {
  sessionStart: 'sessionStart',
  preToolUse: 'preToolUse',
  postToolUse: 'postToolUse',
  stop: 'stop',
  beforeShellExecution: 'beforeShellExecution',
  userPromptSubmit: 'userPromptSubmit',
};

const CODEX_EVENTS: Record<StandardEvent, string> = {
  sessionStart: 'SessionStart',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  stop: 'Stop',
  beforeShellExecution: 'BeforeShellExecution',
  userPromptSubmit: 'UserPromptSubmit',
};

const CLAUDE_EVENTS: Record<StandardEvent, string> = {
  sessionStart: 'session_start',
  preToolUse: 'pre_tool_use',
  postToolUse: 'post_tool_use',
  stop: 'stop',
  beforeShellExecution: 'before_shell_execution',
  userPromptSubmit: 'user_prompt_submit',
};

function toStandardEvent(event: string): StandardEvent | null {
  const lower = event.toLowerCase().replace(/_/g, '');
  const map: Record<string, StandardEvent> = {
    sessionstart: 'sessionStart',
    pretooluse: 'preToolUse',
    posttooluse: 'postToolUse',
    stop: 'stop',
    beforeshellexecution: 'beforeShellExecution',
    userpromptsubmit: 'userPromptSubmit',
  };
  return map[lower] ?? null;
}

function fromStandardEvent(standard: StandardEvent, ide: IdeType): string {
  switch (ide) {
    case 'codex': return CODEX_EVENTS[standard] ?? standard;
    case 'claude-code': return CLAUDE_EVENTS[standard] ?? standard;
    default: return CURSOR_EVENTS[standard] ?? standard;
  }
}

// ═══════════════════════════════════════
// CursorHooksAdapter (hooks.json)
// ═══════════════════════════════════════

class CursorHooksAdapter implements IdeHooksAdapter {
  isSupported(): boolean { return true; }

  async readHooks(configDir: string): Promise<HookEntry[]> {
    const hooksPath = join(configDir, 'hooks.json');
    if (!existsSync(hooksPath)) return [];
    const raw = await readFile(hooksPath, 'utf-8');
    const data = parseHooksJsonSafe(raw, hooksPath);
    return this.parseHooksJson((data.hooks ?? data) as Record<string, unknown>);
  }

  async writeHooks(configDir: string, hooks: HookEntry[]): Promise<void> {
    const hooksPath = join(configDir, 'hooks.json');
    if (!existsSync(configDir)) await mkdir(configDir, { recursive: true });

    const grouped: Record<string, unknown[]> = {};
    for (const hook of hooks) {
      const ideEvent = fromStandardEvent(
        toStandardEvent(hook.event) ?? hook.event as StandardEvent,
        'cursor',
      );
      if (!grouped[ideEvent]) grouped[ideEvent] = [];
      const entry: Record<string, unknown> = { command: hook.command };
      if (hook.matcher) entry.matcher = hook.matcher;
      if (hook.timeout) entry.timeout = hook.timeout;
      grouped[ideEvent].push(entry);
    }

    const data = { version: 1, hooks: grouped };
    await writeFile(hooksPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  private parseHooksJson(hooks: Record<string, unknown>): HookEntry[] {
    const entries: HookEntry[] = [];
    for (const [event, items] of Object.entries(hooks)) {
      if (!Array.isArray(items)) continue;
      const standard = toStandardEvent(event);
      for (const item of items) {
        if (typeof item !== 'object' || !item) continue;
        const h = item as Record<string, unknown>;
        entries.push({
          event: standard ?? event,
          command: String(h.command ?? ''),
          matcher: h.matcher ? String(h.matcher) : undefined,
          timeout: typeof h.timeout === 'number' ? h.timeout : undefined,
        });
      }
    }
    return entries;
  }
}

// ═══════════════════════════════════════
// CodexHooksAdapter (hooks.json, PascalCase events)
// ═══════════════════════════════════════

class CodexHooksAdapter implements IdeHooksAdapter {
  isSupported(): boolean { return true; }

  async readHooks(configDir: string): Promise<HookEntry[]> {
    const hooksPath = join(configDir, 'hooks.json');
    if (!existsSync(hooksPath)) return [];
    const raw = await readFile(hooksPath, 'utf-8');
    const data = parseHooksJsonSafe(raw, hooksPath);
    return this.parseHooksJson((data.hooks ?? data) as Record<string, unknown>);
  }

  async writeHooks(configDir: string, hooks: HookEntry[]): Promise<void> {
    const hooksPath = join(configDir, 'hooks.json');
    if (!existsSync(configDir)) await mkdir(configDir, { recursive: true });

    const grouped: Record<string, unknown[]> = {};
    for (const hook of hooks) {
      const ideEvent = fromStandardEvent(
        toStandardEvent(hook.event) ?? hook.event as StandardEvent,
        'codex',
      );
      if (!grouped[ideEvent]) grouped[ideEvent] = [];
      const entry: Record<string, unknown> = { type: 'command', command: hook.command };
      if (hook.matcher) entry.matcher = hook.matcher;
      if (hook.timeout) entry.timeout = hook.timeout;
      grouped[ideEvent].push(entry);
    }

    await writeFile(hooksPath, JSON.stringify({ hooks: grouped }, null, 2) + '\n', 'utf-8');
  }

  private parseHooksJson(hooks: Record<string, unknown>): HookEntry[] {
    const entries: HookEntry[] = [];
    for (const [event, items] of Object.entries(hooks)) {
      if (!Array.isArray(items)) continue;
      const standard = toStandardEvent(event);
      for (const item of items) {
        if (typeof item !== 'object' || !item) continue;
        const h = item as Record<string, unknown>;
        entries.push({
          event: standard ?? event,
          command: String(h.command ?? ''),
          matcher: h.matcher ? String(h.matcher) : undefined,
          timeout: typeof h.timeout === 'number' ? h.timeout : undefined,
        });
      }
    }
    return entries;
  }
}

// ═══════════════════════════════════════
// ClaudeHooksAdapter (settings.json 内嵌)
// ═══════════════════════════════════════

class ClaudeHooksAdapter implements IdeHooksAdapter {
  isSupported(): boolean { return true; }

  async readHooks(configDir: string): Promise<HookEntry[]> {
    const settingsPath = join(configDir, 'settings.json');
    if (!existsSync(settingsPath)) return [];
    const raw = await readFile(settingsPath, 'utf-8');
    const data = parseHooksJsonSafe(raw, settingsPath);
    if (!data.hooks) return [];
    return this.parseSettings(data.hooks as Record<string, unknown>);
  }

  async writeHooks(configDir: string, hooks: HookEntry[]): Promise<void> {
    const settingsPath = join(configDir, 'settings.json');
    if (!existsSync(configDir)) await mkdir(configDir, { recursive: true });

    let data: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      const raw = await readFile(settingsPath, 'utf-8');
      data = parseHooksJsonSafe(raw, settingsPath);
    }

    const grouped: Record<string, unknown[]> = {};
    for (const hook of hooks) {
      const ideEvent = fromStandardEvent(
        toStandardEvent(hook.event) ?? hook.event as StandardEvent,
        'claude-code',
      );
      if (!grouped[ideEvent]) grouped[ideEvent] = [];
      const entry: Record<string, unknown> = { type: 'command', command: hook.command };
      if (hook.matcher) entry.matcher = hook.matcher;
      if (hook.timeout) entry.timeout = hook.timeout;
      grouped[ideEvent].push(entry);
    }

    data.hooks = grouped;
    await writeFile(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  private parseSettings(hooks: Record<string, unknown>): HookEntry[] {
    const entries: HookEntry[] = [];
    for (const [event, items] of Object.entries(hooks)) {
      if (!Array.isArray(items)) continue;
      const standard = toStandardEvent(event);
      for (const item of items) {
        if (typeof item !== 'object' || !item) continue;
        const h = item as Record<string, unknown>;
        entries.push({
          event: standard ?? event,
          command: String(h.command ?? ''),
          matcher: h.matcher ? String(h.matcher) : undefined,
          timeout: typeof h.timeout === 'number' ? h.timeout : undefined,
        });
      }
    }
    return entries;
  }
}

// ═══════════════════════════════════════
// NoopHooksAdapter (Trae — 暂不支持)
// ═══════════════════════════════════════

class NoopHooksAdapter implements IdeHooksAdapter {
  isSupported(): boolean { return false; }
  async readHooks(): Promise<HookEntry[]> { return []; }
  async writeHooks(): Promise<void> { /* Trae 暂不支持 hooks */ }
}

// ═══════════════════════════════════════
// 工厂
// ═══════════════════════════════════════

export function createHooksAdapter(ide: IdeType): IdeHooksAdapter {
  switch (ide) {
    case 'cursor': return new CursorHooksAdapter();
    case 'codex': return new CodexHooksAdapter();
    case 'claude-code': return new ClaudeHooksAdapter();
    case 'trae':
    case 'trae-cn': return new NoopHooksAdapter();
    default: return new CursorHooksAdapter();
  }
}
