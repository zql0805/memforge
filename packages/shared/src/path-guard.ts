// Created by dev on 2026/05/20
// 路径边界校验 — 防止路径遍历攻击

import { resolve, sep, normalize } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const FORBIDDEN_PREFIXES = ['/etc', '/var', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/root'];

const SCAN_PATH_RE = /^[a-zA-Z0-9_\-./~@ ]+$/;

/**
 * 校验目标路径在允许的 baseDirs 范围内，返回规范化绝对路径。
 * @throws 路径越界时抛出 Error
 */
export function assertPathWithin(baseDirs: string[], targetPath: string): string {
  const resolved = resolve(targetPath);
  const normalizedTarget = existsSync(resolved) ? realpathSync(resolved) : normalize(resolved);

  for (const base of baseDirs) {
    const resolvedBase = resolve(base);
    const normalizedBase = existsSync(resolvedBase) ? realpathSync(resolvedBase) : normalize(resolvedBase);
    if (normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + sep)) {
      return normalizedTarget;
    }
  }
  throw new Error(`路径越界: ${targetPath} 不在允许的目录范围内`);
}

/** 校验拓扑扫描路径合法性，禁止系统目录与非法字符 */
export function validateScanPath(p: string): string {
  if (!SCAN_PATH_RE.test(p)) {
    throw new Error(`路径包含非法字符: ${p}`);
  }
  const resolved = resolve(p.replace(/^~/, homedir()));
  let normalized: string;
  try {
    normalized = realpathSync(resolved);
  } catch {
    throw new Error(`路径不存在或无法解析: ${p}`);
  }
  for (const forbidden of FORBIDDEN_PREFIXES) {
    if (normalized === forbidden || normalized.startsWith(forbidden + '/')) {
      throw new Error(`禁止扫描系统目录: ${normalized}`);
    }
  }
  return normalized;
}

/** 将 userPath 解析为 projectRoot 内的绝对路径，防止目录遍历 */
export function safeResolvePath(projectRoot: string, userPath: string): string {
  const resolved = resolve(projectRoot, userPath);
  const resolvedProject = resolve(projectRoot);
  const normalizedProject = existsSync(resolvedProject) ? realpathSync(resolvedProject) : normalize(resolvedProject);
  const normalizedResolved = existsSync(resolved) ? realpathSync(resolved) : normalize(resolved);
  if (normalizedResolved !== normalizedProject && !normalizedResolved.startsWith(normalizedProject + sep)) {
    throw new Error(`路径越界: ${userPath} 超出项目目录 ${projectRoot}`);
  }
  return normalizedResolved;
}
