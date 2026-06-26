// Created by dev on 2026/05/20
// Memforge IDE 配置抽象层 — 支持 Cursor / Claude Code / Codex CLI / Trae

import { z } from 'zod';
import { homedir } from 'os';
import { join, basename } from 'path';
import { existsSync } from 'fs';

// ═══════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════

export const IdeTypeSchema = z.enum([
  'cursor', 'claude-code', 'codex', 'trae', 'trae-cn', 'unknown',
]);
export type IdeType = z.infer<typeof IdeTypeSchema>;

export type RuleFormat = 'mdc' | 'md' | 'agents-md';
export type McpFormat = 'json' | 'toml';

export interface IdeConfig {
  ide: IdeType;
  displayName: string;

  // 全局路径
  configDir: string;
  rulesDir: string;
  mcpConfigPath: string;
  hooksDir: string;
  skillsDir: string;
  registryDir: string;

  // 项目级路径
  projectRulesDir: (projectRoot: string) => string;
  projectMcpPath: (projectRoot: string) => string;

  // 格式信息
  ruleFormat: RuleFormat;
  ruleExtension: string;
  mcpFormat: McpFormat;
  hooksSupport: boolean;

  // 标识
  deviceId: string;
  sessionId: string;
}

// ═══════════════════════════════════════
// IDE 注册表
// ═══════════════════════════════════════

interface IdePathConfig {
  configDir: string;
  rulesSubDir: string;
  mcpConfigName: string;
  projectConfigDir: string;
  ruleFormat: RuleFormat;
  ruleExtension: string;
  mcpFormat: McpFormat;
  hooksSupport: boolean;
  displayName: string;
  defaultDeviceId: string;
  envSessionKey: string;
}

const IDE_REGISTRY: Record<Exclude<IdeType, 'unknown'>, IdePathConfig> = {
  cursor: {
    configDir: '.cursor',
    rulesSubDir: 'rules',
    mcpConfigName: 'mcp.json',
    projectConfigDir: '.cursor',
    ruleFormat: 'mdc',
    ruleExtension: '.mdc',
    mcpFormat: 'json',
    hooksSupport: true,
    displayName: 'Cursor',
    defaultDeviceId: 'cursor-mcp-client',
    envSessionKey: 'CURSOR_SESSION_ID',
  },
  'claude-code': {
    configDir: '.claude',
    rulesSubDir: 'rules',
    mcpConfigName: '.mcp.json',
    projectConfigDir: '.claude',
    ruleFormat: 'md',
    ruleExtension: '.md',
    mcpFormat: 'json',
    hooksSupport: true,
    displayName: 'Claude Code',
    defaultDeviceId: 'claude-code-mcp-client',
    envSessionKey: 'CLAUDE_SESSION_ID',
  },
  codex: {
    configDir: '.codex',
    rulesSubDir: '',
    mcpConfigName: 'config.toml',
    projectConfigDir: '.codex',
    ruleFormat: 'agents-md',
    ruleExtension: '.md',
    mcpFormat: 'toml',
    hooksSupport: true,
    displayName: 'Codex CLI',
    defaultDeviceId: 'codex-mcp-client',
    envSessionKey: 'CODEX_HOME',
  },
  trae: {
    configDir: '.trae',
    rulesSubDir: 'rules',
    mcpConfigName: 'mcp.json',
    projectConfigDir: '.trae',
    ruleFormat: 'md',
    ruleExtension: '.md',
    mcpFormat: 'json',
    hooksSupport: false,
    displayName: 'Trae',
    defaultDeviceId: 'trae-mcp-client',
    envSessionKey: 'TRAE_SESSION_ID',
  },
  'trae-cn': {
    configDir: '.trae-cn',
    rulesSubDir: 'rules',
    mcpConfigName: 'mcp.json',
    projectConfigDir: '.trae',
    ruleFormat: 'md',
    ruleExtension: '.md',
    mcpFormat: 'json',
    hooksSupport: false,
    displayName: 'Trae CN',
    defaultDeviceId: 'trae-cn-mcp-client',
    envSessionKey: 'TRAE_SESSION_ID',
  },
};

// ═══════════════════════════════════════
// IDE 检测
// ═══════════════════════════════════════

function detectIdeFromEnv(): IdeType {
  if (process.env.CURSOR_SESSION_ID) return 'cursor';
  if (process.env.CLAUDE_CODE || process.env.CLAUDE_SESSION_ID) return 'claude-code';
  if (process.env.CODEX_HOME || process.env.CODEX_CLI) return 'codex';
  if (process.env.TRAE_SESSION_ID) {
    return existsSync(join(homedir(), '.trae-cn')) ? 'trae-cn' : 'trae';
  }
  return 'unknown';
}

function detectIdeFromProcess(): IdeType {
  try {
    const title = process.title?.toLowerCase() ?? '';
    const argv0 = process.argv[0]?.toLowerCase() ?? '';
    const combined = `${title} ${argv0}`;

    if (combined.includes('cursor')) return 'cursor';
    if (combined.includes('claude')) return 'claude-code';
    if (combined.includes('codex')) return 'codex';
    if (combined.includes('trae')) {
      return existsSync(join(homedir(), '.trae-cn')) ? 'trae-cn' : 'trae';
    }
  } catch {
    // 进程信息不可用
  }
  return 'unknown';
}

function detectIdeFromConfig(): IdeType {
  const home = homedir();
  // 按优先级检查：先看 MCP 配置文件是否存在
  const checks: Array<{ ide: Exclude<IdeType, 'unknown'>; paths: string[] }> = [
    { ide: 'cursor', paths: [join(home, '.cursor', 'mcp.json')] },
    { ide: 'claude-code', paths: [join(home, '.claude', '.mcp.json'), join(home, '.claude')] },
    { ide: 'codex', paths: [join(home, '.codex', 'config.toml'), join(home, '.codex')] },
    { ide: 'trae-cn', paths: [join(home, '.trae-cn', 'mcp.json')] },
    { ide: 'trae', paths: [join(home, '.trae', 'mcp.json')] },
  ];

  for (const { ide, paths } of checks) {
    if (paths.some(p => existsSync(p))) return ide;
  }
  return 'unknown';
}

function resolveIdeFromDir(dir: string): IdeType {
  const dirName = basename(dir);
  for (const [ide, config] of Object.entries(IDE_REGISTRY)) {
    if (config.configDir === dirName || config.configDir === `.${dirName}`) {
      return ide as IdeType;
    }
  }
  return 'unknown';
}

/**
 * 检测当前运行的 IDE 类型
 *
 * 检测优先级：
 * 1. MEMFORGE_IDE 环境变量（直接指定）
 * 2. MEMFORGE_IDE_DIR 环境变量（从目录名反推）
 * 3. IDE 会话环境变量（CURSOR_SESSION_ID 等）
 * 4. 进程信息检测
 * 5. 配置文件存在性检测
 * 6. 默认 cursor（向后兼容）
 */
export function detectIde(): IdeType {
  const envIde = process.env.MEMFORGE_IDE?.toLowerCase();
  if (envIde) {
    const parsed = IdeTypeSchema.safeParse(envIde);
    if (parsed.success) return parsed.data;
  }

  const envDir = process.env.MEMFORGE_IDE_DIR;
  if (envDir) {
    const resolved = resolveIdeFromDir(envDir);
    if (resolved !== 'unknown') return resolved;
  }

  const fromEnv = detectIdeFromEnv();
  if (fromEnv !== 'unknown') return fromEnv;

  const fromProcess = detectIdeFromProcess();
  if (fromProcess !== 'unknown') return fromProcess;

  const fromConfig = detectIdeFromConfig();
  if (fromConfig !== 'unknown') return fromConfig;

  return 'cursor';
}

// ═══════════════════════════════════════
// IdeConfig 构建
// ═══════════════════════════════════════

function buildConfig(ide: IdeType, home: string, configBase: string, pathConfig: IdePathConfig): IdeConfig {
  const configDir = configBase;
  const rulesDir = pathConfig.rulesSubDir
    ? join(configDir, pathConfig.rulesSubDir)
    : configDir;

  return {
    ide,
    displayName: pathConfig.displayName,

    configDir,
    rulesDir,
    mcpConfigPath: join(configDir, pathConfig.mcpConfigName),
    hooksDir: join(configDir, 'hooks'),
    skillsDir: join(configDir, 'skills'),
    registryDir: configDir,

    projectRulesDir: (projectRoot: string) => {
      const projectDir = join(projectRoot, pathConfig.projectConfigDir);
      return pathConfig.rulesSubDir
        ? join(projectDir, pathConfig.rulesSubDir)
        : projectDir;
    },
    projectMcpPath: (projectRoot: string) =>
      join(projectRoot, pathConfig.projectConfigDir, pathConfig.mcpConfigName),

    ruleFormat: pathConfig.ruleFormat,
    ruleExtension: pathConfig.ruleExtension,
    mcpFormat: pathConfig.mcpFormat,
    hooksSupport: pathConfig.hooksSupport,

    deviceId: process.env.MEMFORGE_DEVICE_ID || pathConfig.defaultDeviceId,
    sessionId: process.env[pathConfig.envSessionKey] || '',
  };
}

/**
 * 获取 IDE 配置
 *
 * 使用方式：
 * - `getIdeConfig()` — 自动检测当前 IDE
 * - `getIdeConfig('claude-code')` — 指定 IDE 类型
 *
 * 环境变量：
 * - `MEMFORGE_IDE` — 直接指定 IDE 类型
 * - `MEMFORGE_IDE_DIR` — 指定配置目录（自动推断 IDE 类型）
 * - `MEMFORGE_DEVICE_ID` — 覆盖默认 device ID
 */
export function getIdeConfig(ideOverride?: IdeType): IdeConfig {
  const ide = ideOverride || detectIde();
  const home = homedir();

  // MEMFORGE_IDE_DIR 直接指定配置目录
  const customDir = process.env.MEMFORGE_IDE_DIR;
  if (customDir && !ideOverride) {
    const absDir = customDir.startsWith('~')
      ? join(home, customDir.slice(1))
      : customDir;

    // 尝试从目录名推断 IDE 类型，否则用检测结果
    const dirIde = resolveIdeFromDir(absDir);
    const effectiveIde = dirIde !== 'unknown' ? dirIde : ide;
    const pathConfig = effectiveIde !== 'unknown'
      ? IDE_REGISTRY[effectiveIde]
      : IDE_REGISTRY.cursor;

    return buildConfig(effectiveIde, home, absDir, pathConfig);
  }

  if (ide === 'unknown') {
    return buildConfig('unknown', home, join(home, '.cursor'), IDE_REGISTRY.cursor);
  }

  const pathConfig = IDE_REGISTRY[ide];
  return buildConfig(ide, home, join(home, pathConfig.configDir), pathConfig);
}

// ═══════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════

/** 获取所有已注册的 IDE 类型（不含 unknown） */
export function getAllIdeTypes(): Array<Exclude<IdeType, 'unknown'>> {
  return Object.keys(IDE_REGISTRY) as Array<Exclude<IdeType, 'unknown'>>;
}

/** 获取 IDE 注册信息（用于配置展示等） */
export function getIdeRegistry(): Readonly<Record<Exclude<IdeType, 'unknown'>, Readonly<IdePathConfig>>> {
  return IDE_REGISTRY;
}

/** 检查 IDE 类型是否有效 */
export function isValidIdeType(value: string): value is IdeType {
  return IdeTypeSchema.safeParse(value).success;
}

/** 从 User-Agent 检测 IDE 类型 */
export function detectIdeFromUA(ua: string): IdeType {
  const lower = ua.toLowerCase();
  if (lower.includes('cursor')) return 'cursor';
  if (lower.includes('claude')) return 'claude-code';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('trae')) return 'trae';
  return 'unknown';
}
