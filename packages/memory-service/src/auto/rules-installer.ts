// Created by dev on 2026/04/05
// Copyright © 2026

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getLogger,
  getIdeConfig,
  createRulesAdapter,
  convertRule,
} from '@memforgeai/shared';
import type { RuleFile, RuleFormat } from '@memforgeai/shared';

const logger = getLogger('rules-installer');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RuleTemplate {
  filename: string;
  sourcePath: string;
}

function getTemplatesDir(): string {
  const distDir = join(__dirname, '..');
  const packageRoot = join(distDir, '..');
  const srcTemplates = join(packageRoot, 'src', 'rules-templates');
  if (existsSync(srcTemplates)) {
    return srcTemplates;
  }
  const distTemplates = join(distDir, 'rules-templates');
  if (existsSync(distTemplates)) {
    return distTemplates;
  }
  return srcTemplates;
}

function discoverTemplates(): RuleTemplate[] {
  const templatesDir = getTemplatesDir();
  if (!existsSync(templatesDir)) {
    logger.warn({ dir: templatesDir }, '规则模板目录不存在');
    return [];
  }

  return readdirSync(templatesDir)
    .filter(f => f.endsWith('.mdc'))
    .map(f => ({
      filename: f,
      sourcePath: join(templatesDir, f),
    }));
}

function extractVersion(content: string): string | null {
  const match = content.match(/memforge_version:\s*"([^"]+)"/);
  return match?.[1] ?? null;
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

function resolveTargetFilename(
  templateFilename: string,
  templateContent: string,
  ruleFormat: RuleFormat,
): string {
  const sourceAdapter = createRulesAdapter('mdc');
  const parsed = sourceAdapter.parseRule(templateContent, templateFilename);
  return convertRule(parsed, 'mdc', ruleFormat).filename;
}

function shouldInstall(templateContent: string, targetPath: string): 'install' | 'update' | 'skip' {
  if (!existsSync(targetPath)) {
    return 'install';
  }

  const existing = readFileSync(targetPath, 'utf-8');
  const existingVersion = extractVersion(existing);
  const templateVersion = extractVersion(templateContent);

  if (!existingVersion) {
    return 'skip';
  }

  if (!templateVersion) {
    return 'skip';
  }

  if (compareSemver(existingVersion, templateVersion) < 0) {
    return 'update';
  }

  return 'skip';
}

type RulesScope = 'global' | 'workspace';

function resolveRulesDir(projectRoot: string): { dir: string; scope: RulesScope } {
  const ideConfig = getIdeConfig();
  const scopeEnv = (process.env.MEMFORGE_RULES_SCOPE ?? 'global').toLowerCase() as RulesScope;

  if (scopeEnv === 'workspace') {
    return { dir: ideConfig.projectRulesDir(projectRoot), scope: 'workspace' };
  }

  return { dir: ideConfig.rulesDir, scope: 'global' };
}

export async function installIdeRules(projectRoot: string): Promise<{
  installed: string[];
  updated: string[];
  skipped: string[];
  scope: RulesScope;
  rulesDir: string;
}> {
  const ideConfig = getIdeConfig();
  const { dir: rulesDir, scope } = resolveRulesDir(projectRoot);
  const sourceAdapter = createRulesAdapter('mdc');
  const targetAdapter = createRulesAdapter(ideConfig.ruleFormat);

  const result = {
    installed: [] as string[],
    updated: [] as string[],
    skipped: [] as string[],
    scope,
    rulesDir,
  };

  const templates = discoverTemplates();
  if (templates.length === 0) {
    logger.info('无可用的规则模板');
    return result;
  }

  logger.info({ scope, rulesDir, ruleFormat: ideConfig.ruleFormat }, '规则安装目标');

  for (const tpl of templates) {
    try {
      const templateContent = readFileSync(tpl.sourcePath, 'utf-8');
      const targetFilename = resolveTargetFilename(tpl.filename, templateContent, ideConfig.ruleFormat);
      const targetPath = join(rulesDir, targetFilename);
      const action = shouldInstall(templateContent, targetPath);

      if (action === 'skip') {
        result.skipped.push(targetFilename);
        continue;
      }

      const parsedRule: RuleFile = sourceAdapter.parseRule(templateContent, tpl.filename);
      const convertedRule = convertRule(parsedRule, 'mdc', ideConfig.ruleFormat);

      await targetAdapter.writeRule(rulesDir, convertedRule);

      if (action === 'install') {
        result.installed.push(targetFilename);
        logger.info({ file: targetFilename, scope, ruleFormat: ideConfig.ruleFormat }, '已安装 IDE Rule');
      } else {
        result.updated.push(targetFilename);
        logger.info({ file: targetFilename, scope, ruleFormat: ideConfig.ruleFormat }, '已更新 IDE Rule');
      }
    } catch (err) {
      logger.warn({ file: tpl.filename, err: (err as Error).message }, '安装规则失败');
      result.skipped.push(tpl.filename);
    }
  }

  if (result.installed.length > 0 || result.updated.length > 0) {
    logger.info(
      { scope, installed: result.installed.length, updated: result.updated.length, skipped: result.skipped.length },
      'IDE Rules 自动部署完成',
    );
  }

  return result;
}

export const installCursorRules = installIdeRules;
