// Created by dev on 2026/05/20
// 规则文件格式适配器 — 支持 .mdc / .md / AGENTS.md 三种格式

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type { RuleFormat } from './ide-config.js';

// ═══════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════

export interface RuleFile {
  filename: string;
  title: string;
  description: string;
  content: string;
  body: string;
  frontmatter: Record<string, unknown>;
  globs?: string[];
  alwaysApply?: boolean;
}

export interface IdeRulesAdapter {
  readRules(rulesDir: string): Promise<RuleFile[]>;
  writeRule(rulesDir: string, rule: RuleFile): Promise<void>;
  listRuleFiles(rulesDir: string): Promise<string[]>;
  parseRule(content: string, filename: string): RuleFile;
  serializeRule(rule: RuleFile): string;
}

// ═══════════════════════════════════════
// Frontmatter 解析/序列化
// ═══════════════════════════════════════

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const fm: Record<string, unknown> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: unknown = line.slice(idx + 1).trim();
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return { frontmatter: fm, body: match[2] };
}

function serializeFrontmatter(fm: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, val] of Object.entries(fm)) {
    if (val === undefined || val === null) continue;
    if (typeof val === 'string') lines.push(`${key}: "${val}"`);
    else if (typeof val === 'boolean') lines.push(`${key}: ${val}`);
    else if (Array.isArray(val)) lines.push(`${key}: ${JSON.stringify(val)}`);
    else lines.push(`${key}: ${String(val)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function extractTitle(body: string, filename: string): string {
  const titleMatch = body.match(/^#\s+(.+)/m);
  return titleMatch?.[1]?.trim() ?? basename(filename, extname(filename));
}

// ═══════════════════════════════════════
// MdcAdapter (Cursor .mdc)
// ═══════════════════════════════════════

class MdcAdapter implements IdeRulesAdapter {
  async readRules(rulesDir: string): Promise<RuleFile[]> {
    if (!existsSync(rulesDir)) return [];
    const files = (await readdir(rulesDir)).filter(f => f.endsWith('.mdc'));
    const rules: RuleFile[] = [];
    for (const file of files) {
      const content = await readFile(join(rulesDir, file), 'utf-8');
      rules.push(this.parseRule(content, file));
    }
    return rules;
  }

  async writeRule(rulesDir: string, rule: RuleFile): Promise<void> {
    if (!existsSync(rulesDir)) await mkdir(rulesDir, { recursive: true });
    const filename = rule.filename.endsWith('.mdc') ? rule.filename : `${rule.filename}.mdc`;
    await writeFile(join(rulesDir, filename), this.serializeRule(rule), 'utf-8');
  }

  async listRuleFiles(rulesDir: string): Promise<string[]> {
    if (!existsSync(rulesDir)) return [];
    return (await readdir(rulesDir)).filter(f => f.endsWith('.mdc'));
  }

  parseRule(content: string, filename: string): RuleFile {
    const { frontmatter, body } = parseFrontmatter(content);
    const title = extractTitle(body, filename);
    const description = typeof frontmatter.description === 'string' ? frontmatter.description : title;
    const globs = parseGlobs(frontmatter.globs);
    const alwaysApply = frontmatter.alwaysApply === true;

    return { filename, title, description, content, body, frontmatter, globs, alwaysApply };
  }

  serializeRule(rule: RuleFile): string {
    const fm: Record<string, unknown> = {
      description: rule.description || rule.title,
      ...rule.frontmatter,
    };
    if (rule.globs?.length) fm.globs = rule.globs;
    if (rule.alwaysApply !== undefined) fm.alwaysApply = rule.alwaysApply;
    return `${serializeFrontmatter(fm)}\n\n${rule.body}\n`;
  }
}

// ═══════════════════════════════════════
// MdAdapter (Claude Code / Trae .md)
// ═══════════════════════════════════════

class MdAdapter implements IdeRulesAdapter {
  async readRules(rulesDir: string): Promise<RuleFile[]> {
    if (!existsSync(rulesDir)) return [];
    const files = (await readdir(rulesDir)).filter(f => f.endsWith('.md'));
    const rules: RuleFile[] = [];
    for (const file of files) {
      const content = await readFile(join(rulesDir, file), 'utf-8');
      rules.push(this.parseRule(content, file));
    }
    return rules;
  }

  async writeRule(rulesDir: string, rule: RuleFile): Promise<void> {
    if (!existsSync(rulesDir)) await mkdir(rulesDir, { recursive: true });
    const filename = rule.filename.endsWith('.md') ? rule.filename : rule.filename.replace(/\.mdc$/, '.md');
    await writeFile(join(rulesDir, filename), this.serializeRule(rule), 'utf-8');
  }

  async listRuleFiles(rulesDir: string): Promise<string[]> {
    if (!existsSync(rulesDir)) return [];
    return (await readdir(rulesDir)).filter(f => f.endsWith('.md'));
  }

  parseRule(content: string, filename: string): RuleFile {
    const { frontmatter, body } = parseFrontmatter(content);
    const title = extractTitle(body, filename);
    const description = typeof frontmatter.description === 'string' ? frontmatter.description : title;

    // Claude 用 paths (CSV)，转为 globs 数组
    const globs = frontmatter.paths
      ? String(frontmatter.paths).split(',').map(s => s.trim()).filter(Boolean)
      : parseGlobs(frontmatter.globs);
    const alwaysApply = frontmatter.alwaysApply === true;

    return { filename, title, description, content, body, frontmatter, globs, alwaysApply };
  }

  serializeRule(rule: RuleFile): string {
    const fm: Record<string, unknown> = {};
    if (rule.description) fm.description = rule.description;
    // Claude/Trae 用 paths 而非 globs
    if (rule.globs?.length) fm.paths = rule.globs.join(', ');
    if (rule.alwaysApply !== undefined) fm.alwaysApply = rule.alwaysApply;
    // 剥离 Cursor 特有字段
    delete fm.memforge_version;
    delete fm.memforge_rule_id;

    if (Object.keys(fm).length === 0) return rule.body + '\n';
    return `${serializeFrontmatter(fm)}\n\n${rule.body}\n`;
  }
}

// ═══════════════════════════════════════
// AgentsMdAdapter (Codex AGENTS.md)
// ═══════════════════════════════════════

class AgentsMdAdapter implements IdeRulesAdapter {
  async readRules(rulesDir: string): Promise<RuleFile[]> {
    const agentsPath = join(rulesDir, 'AGENTS.md');
    if (!existsSync(agentsPath)) return [];
    const content = await readFile(agentsPath, 'utf-8');
    return this.splitAgentsMd(content);
  }

  async writeRule(rulesDir: string, rule: RuleFile): Promise<void> {
    if (!existsSync(rulesDir)) await mkdir(rulesDir, { recursive: true });
    const agentsPath = join(rulesDir, 'AGENTS.md');

    let existing = '';
    if (existsSync(agentsPath)) {
      existing = await readFile(agentsPath, 'utf-8');
    }

    const section = this.serializeRule(rule);
    const sectionHeader = `## ${rule.title}`;

    // 替换同名 section 或追加
    const sectionRegex = new RegExp(`^## ${escapeRegex(rule.title)}\\b[\\s\\S]*?(?=^## |\\Z)`, 'm');
    if (sectionRegex.test(existing)) {
      existing = existing.replace(sectionRegex, section);
    } else {
      existing = existing.trim() + '\n\n' + section;
    }

    await writeFile(agentsPath, existing.trim() + '\n', 'utf-8');
  }

  async listRuleFiles(rulesDir: string): Promise<string[]> {
    const agentsPath = join(rulesDir, 'AGENTS.md');
    if (!existsSync(agentsPath)) return [];
    return ['AGENTS.md'];
  }

  parseRule(content: string, filename: string): RuleFile {
    const title = extractTitle(content, filename);
    return {
      filename: 'AGENTS.md',
      title,
      description: title,
      content,
      body: content,
      frontmatter: {},
      alwaysApply: true,
    };
  }

  serializeRule(rule: RuleFile): string {
    const body = rule.body.startsWith('#') ? rule.body : `## ${rule.title}\n\n${rule.body}`;
    return body + '\n';
  }

  private splitAgentsMd(content: string): RuleFile[] {
    const sections: RuleFile[] = [];
    const parts = content.split(/^(?=## )/m);

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const titleMatch = trimmed.match(/^##\s+(.+)/);
      const title = titleMatch?.[1]?.trim() ?? 'Untitled';
      sections.push({
        filename: 'AGENTS.md',
        title,
        description: title,
        content: trimmed,
        body: trimmed,
        frontmatter: {},
        alwaysApply: true,
      });
    }
    return sections;
  }
}

// ═══════════════════════════════════════
// 工厂 + 转换
// ═══════════════════════════════════════

export function createRulesAdapter(format: RuleFormat): IdeRulesAdapter {
  switch (format) {
    case 'mdc': return new MdcAdapter();
    case 'md': return new MdAdapter();
    case 'agents-md': return new AgentsMdAdapter();
    default: return new MdcAdapter();
  }
}

/**
 * 将规则从一种格式转换到另一种
 * 内部格式以 RuleFile 为中间表示，仅转换序列化相关属性
 */
export function convertRule(rule: RuleFile, from: RuleFormat, to: RuleFormat): RuleFile {
  if (from === to) return { ...rule };

  const targetAdapter = createRulesAdapter(to);
  const converted = { ...rule };

  // 调整文件名扩展
  if (to === 'mdc') {
    converted.filename = converted.filename.replace(/\.md$/, '.mdc');
  } else if (to === 'md' || to === 'agents-md') {
    converted.filename = converted.filename.replace(/\.mdc$/, '.md');
  }

  // 剥离 Cursor 特有的 frontmatter 字段
  if (to !== 'mdc') {
    const cleanFm = { ...converted.frontmatter };
    delete cleanFm.memforge_version;
    delete cleanFm.memforge_rule_id;
    converted.frontmatter = cleanFm;
  }

  // agents-md 不用 frontmatter
  if (to === 'agents-md') {
    converted.frontmatter = {};
    converted.filename = 'AGENTS.md';
  }

  // 重新序列化以确保格式正确
  converted.content = targetAdapter.serializeRule(converted);
  return converted;
}

/**
 * 批量将规则同步到指定 IDE 的规则目录
 */
export async function syncRulesToIde(
  sourceRules: RuleFile[],
  targetRulesDir: string,
  targetFormat: RuleFormat,
  sourceFormat: RuleFormat = 'mdc',
): Promise<{ written: number; skipped: number }> {
  const adapter = createRulesAdapter(targetFormat);
  let written = 0;
  let skipped = 0;

  for (const rule of sourceRules) {
    try {
      const converted = convertRule(rule, sourceFormat, targetFormat);
      await adapter.writeRule(targetRulesDir, converted);
      written++;
    } catch {
      skipped++;
    }
  }
  return { written, skipped };
}

// ═══════════════════════════════════════
// 辅助
// ═══════════════════════════════════════

function parseGlobs(val: unknown): string[] | undefined {
  if (!val) return undefined;
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* not JSON */ }
    return val.split(',').map(s => s.trim()).filter(Boolean);
  }
  return undefined;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
