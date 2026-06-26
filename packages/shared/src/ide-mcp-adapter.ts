// Created by dev on 2026/05/20
// MCP 配置格式适配器 — 支持 JSON (Cursor/Claude/Trae) 和 TOML (Codex)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { getLogger } from './logger.js';
import { sanitizeEnvVarName } from './ide-hooks-adapter.js';
import type { McpFormat } from './ide-config.js';

const logger = getLogger('ide-mcp-adapter');

function parseJsonConfig(raw: string, configPath: string): Record<string, unknown> {
  try {
    const data = JSON.parse(raw);
    return typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
  } catch (err) {
    logger.warn({ err, configPath }, 'MCP 配置文件 JSON 解析失败，使用空配置');
    return {};
  }
}

// ═══════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface IdeMcpAdapter {
  readConfig(configPath: string): Promise<McpServerConfig[]>;
  upsertServer(configPath: string, server: McpServerConfig): Promise<void>;
  removeServer(configPath: string, serverName: string): Promise<void>;
  generateInstallSnippet(server: McpServerConfig): string;
}

// ═══════════════════════════════════════
// JSON Adapter (Cursor / Claude Code / Trae)
// ═══════════════════════════════════════

class JsonMcpAdapter implements IdeMcpAdapter {
  async readConfig(configPath: string): Promise<McpServerConfig[]> {
    if (!existsSync(configPath)) return [];
    const raw = await readFile(configPath, 'utf-8');
    const data = parseJsonConfig(raw, configPath);
    const servers = (data.mcpServers ?? {}) as Record<string, unknown>;
    return Object.entries(servers).map(([name, cfg]) => ({
      name,
      ...(cfg as Record<string, unknown>),
    })) as McpServerConfig[];
  }

  async upsertServer(configPath: string, server: McpServerConfig): Promise<void> {
    const dir = dirname(configPath);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });

    let data: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      const raw = await readFile(configPath, 'utf-8');
      data = parseJsonConfig(raw, configPath);
    }

    if (!data.mcpServers) data.mcpServers = {};
    const servers = data.mcpServers as Record<string, unknown>;

    const { name, ...rest } = server;
    servers[name] = rest;

    await writeFile(configPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  async removeServer(configPath: string, serverName: string): Promise<void> {
    if (!existsSync(configPath)) return;
    const raw = await readFile(configPath, 'utf-8');
    const data = parseJsonConfig(raw, configPath);
    const servers = data.mcpServers as Record<string, unknown> | undefined;
    if (servers) {
      delete servers[serverName];
    }
    await writeFile(configPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  generateInstallSnippet(server: McpServerConfig): string {
    const cfg: Record<string, unknown> = {};
    if (server.command) cfg.command = server.command;
    if (server.args) cfg.args = server.args;
    if (server.env) cfg.env = server.env;
    if (server.url) cfg.url = server.url;
    return JSON.stringify({ mcpServers: { [server.name]: cfg } }, null, 2);
  }
}

// ═══════════════════════════════════════
// TOML Adapter (Codex CLI)
// ═══════════════════════════════════════

/** 以 server.name 构造 env key 时须转义，避免 `-`/`.` 等非法字符 */
function resolveServerEnvKey(serverName: string, key: string): string {
  if (key.startsWith(serverName)) {
    return sanitizeEnvVarName(key);
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
    return key;
  }
  return sanitizeEnvVarName(`${serverName}_${key}`);
}

function escapeTomlString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

async function loadToml(): Promise<{ parse: (s: string) => Record<string, unknown>; stringify: (o: Record<string, unknown>) => string }> {
  try {
    const toml = await import('@iarna/toml');
    return {
      parse: (s: string) => toml.parse(s) as Record<string, unknown>,
      stringify: (o: Record<string, unknown>) => toml.stringify(o as any),
    };
  } catch {
    throw new Error(
      'TOML 支持需要安装 @iarna/toml: npm install @iarna/toml\n'
      + '或设置 MEMFORGE_IDE 为非 codex 值以使用 JSON 格式',
    );
  }
}

class TomlMcpAdapter implements IdeMcpAdapter {
  async readConfig(configPath: string): Promise<McpServerConfig[]> {
    if (!existsSync(configPath)) return [];
    const toml = await loadToml();
    const raw = await readFile(configPath, 'utf-8');
    const data = toml.parse(raw);

    const servers = (data.mcp_servers ?? {}) as Record<string, Record<string, unknown>>;
    return Object.entries(servers).map(([name, cfg]) => ({
      name,
      command: cfg.command as string | undefined,
      args: cfg.args as string[] | undefined,
      env: cfg.env as Record<string, string> | undefined,
      url: cfg.url as string | undefined,
    }));
  }

  async upsertServer(configPath: string, server: McpServerConfig): Promise<void> {
    const toml = await loadToml();
    const dir = dirname(configPath);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });

    let data: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      const raw = await readFile(configPath, 'utf-8');
      data = toml.parse(raw);
    }

    if (!data.mcp_servers) data.mcp_servers = {};
    const servers = data.mcp_servers as Record<string, unknown>;

    const cfg: Record<string, unknown> = {};
    if (server.command) cfg.command = server.command;
    if (server.args) cfg.args = server.args;
    if (server.url) cfg.url = server.url;
    if (server.env) cfg.env = server.env;
    servers[server.name] = cfg;

    await writeFile(configPath, toml.stringify(data) + '\n', 'utf-8');
  }

  async removeServer(configPath: string, serverName: string): Promise<void> {
    if (!existsSync(configPath)) return;
    const toml = await loadToml();
    const raw = await readFile(configPath, 'utf-8');
    const data = toml.parse(raw);
    if (data.mcp_servers) {
      delete (data.mcp_servers as Record<string, unknown>)[serverName];
    }
    await writeFile(configPath, toml.stringify(data) + '\n', 'utf-8');
  }

  generateInstallSnippet(server: McpServerConfig): string {
    const lines = [`[mcp_servers.${server.name}]`];
    if (server.command) lines.push(`command = "${escapeTomlString(server.command)}"`);
    if (server.args?.length) {
      lines.push(`args = [${server.args.map(a => `"${escapeTomlString(a)}"`).join(', ')}]`);
    }
    if (server.url) lines.push(`url = "${escapeTomlString(server.url)}"`);
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push('');
      lines.push(`[mcp_servers.${server.name}.env]`);
      for (const [k, v] of Object.entries(server.env)) {
        lines.push(`${resolveServerEnvKey(server.name, k)} = "${escapeTomlString(v)}"`);
      }
    }
    return lines.join('\n');
  }
}

// ═══════════════════════════════════════
// 工厂
// ═══════════════════════════════════════

export function createMcpAdapter(format: McpFormat): IdeMcpAdapter {
  switch (format) {
    case 'json': return new JsonMcpAdapter();
    case 'toml': return new TomlMcpAdapter();
    default: return new JsonMcpAdapter();
  }
}
