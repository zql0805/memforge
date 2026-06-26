// Created by dev on 2026/04/05
// Copyright © 2026
// B3 优化: Git 上下文检测（从 context-service 归并到 shared）
// memory-service 和 rules-engine 统一从 shared 导入

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { GitContext } from './types.js';

/**
 * 检测 cwd 所在 Git 仓库的上下文（分支、remote、projectName 等）。
 * @param cwd - 工作目录绝对路径
 */
export function detectGitContext(cwd: string): GitContext {
  const gitDir = findGitDir(cwd);
  if (!gitDir) {
    throw new Error(`${cwd} 不是 Git 仓库`);
  }

  const branchName = getBranchName(cwd);
  const isWorktree = checkIsWorktree(gitDir);
  const projectPath = isWorktree ? getWorktreeMainRepo(gitDir) : resolve(gitDir, '..');
  const dirName = basename(projectPath);
  const remoteUrl = getRemoteUrl(cwd);
  const projectName = (remoteUrl ? deriveProjectIdFromRemoteUrl(remoteUrl) : null) ?? dirName;

  return {
    projectName,
    projectPath,
    branchName,
    isWorktree,
    worktreePath: isWorktree ? cwd : null,
    remoteUrl,
  };
}

/**
 * 从 git remote URL 派生稳定的项目标识。
 * git@git.example.com:org/team/service-name.git → org/team/service-name
 * https://github.com/user/repo.git → user/repo
 */
export function deriveProjectIdFromRemoteUrl(url: string): string | null {
  try {
    // SSH: git@host:group/repo.git
    const sshMatch = url.match(/:([^/].+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];

    // HTTPS: https://host/group/repo.git
    const httpsMatch = url.match(/\/\/[^/]+\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];

    return null;
  } catch {
    return null;
  }
}

function findGitDir(cwd: string): string | null {
  try {
    const result = execSync('git rev-parse --git-dir', { cwd, encoding: 'utf-8' }).trim();
    return resolve(cwd, result);
  } catch {
    return null;
  }
}

function getBranchName(cwd: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function checkIsWorktree(gitDir: string): boolean {
  return existsSync(join(gitDir, 'gitdir'));
}

function getWorktreeMainRepo(gitDir: string): string {
  const commonDir = join(gitDir, 'commondir');
  if (existsSync(commonDir)) {
    const relative = readFileSync(commonDir, 'utf-8').trim();
    return resolve(resolve(gitDir, relative), '..');
  }
  return resolve(gitDir, '..');
}

function getRemoteUrl(cwd: string): string | null {
  try {
    return execSync('git remote get-url origin', { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

/**
 * 构建三层级联 projectIds 数组：[当前项目, 产品线, '_global_']
 * 用于查询时同时匹配项目级、产品线级、全局级数据
 */
export function buildProjectCascade(projectName?: string, productLine?: string): string[] | undefined {
  if (!projectName && !productLine) return undefined;
  const ids = new Set<string>();
  if (projectName && projectName !== 'default') ids.add(projectName);
  if (productLine) ids.add(productLine);
  ids.add('_global_');
  return [...ids];
}
