// Created by dev on 2026/04/04
// Copyright © 2026
// Git 上下文检测：自动识别当前项目名、分支名、Worktree 状态

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { GitContext } from '@memforgeai/shared';
import { deriveProjectIdFromRemoteUrl } from '@memforgeai/shared';

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
  const worktreeFile = join(gitDir, 'gitdir');
  return existsSync(worktreeFile);
}

function getWorktreeMainRepo(gitDir: string): string {
  const commonDir = join(gitDir, 'commondir');
  if (existsSync(commonDir)) {
    const relative = readFileSync(commonDir, 'utf-8').trim();
    const absoluteCommon = resolve(gitDir, relative);
    return resolve(absoluteCommon, '..');
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
