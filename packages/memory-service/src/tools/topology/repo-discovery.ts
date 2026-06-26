// Created by dev on 2026/04/06
// Copyright © 2026
// 拓扑扫描引擎 — 仓库发现模块
// 递归扫描目录发现 git 仓库，提取 remote URL、计算 repoId

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { ScannedRepo } from './types.js';

const MAX_DEPTH = 6;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'target', 'build', 'dist',
  '.idea', '.vscode', '__pycache__', '.gradle', 'Pods', '.pub-cache',
]);

/**
 * 扫描 scanRoots 下所有 git 仓库
 * @param scanRoots 要扫描的根目录列表
 * @param gitPatterns 可选的 git host/group 前缀过滤（空数组 = 不过滤）
 */
export function discoverRepos(
  scanRoots: string[],
  gitPatterns: string[] = [],
): ScannedRepo[] {
  const repos: ScannedRepo[] = [];
  const seen = new Set<string>();

  for (const root of scanRoots) {
    const absRoot = root.replace(/^~/, process.env.HOME || '');
    if (!fs.existsSync(absRoot)) continue;
    walkDir(absRoot, 0, repos, seen, gitPatterns);
  }
  return repos;
}

function walkDir(
  dir: string,
  depth: number,
  repos: ScannedRepo[],
  seen: Set<string>,
  gitPatterns: string[],
): void {
  if (depth > MAX_DEPTH) return;

  const gitDir = path.join(dir, '.git');
  if (fs.existsSync(gitDir)) {
    const repo = extractRepoInfo(dir, gitPatterns);
    if (repo && !seen.has(repo.repoId)) {
      seen.add(repo.repoId);
      repos.push(repo);
    }
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    walkDir(path.join(dir, entry.name), depth + 1, repos, seen, gitPatterns);
  }
}

function extractRepoInfo(
  repoPath: string,
  gitPatterns: string[],
): ScannedRepo | null {
  let remote: string;
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }

  if (!remote) return null;

  if (gitPatterns.length > 0) {
    const matches = gitPatterns.some(p => remote.includes(p));
    if (!matches) return null;
  }

  const { host, repoId, group } = parseGitRemote(remote);

  return {
    repoId,
    localPath: repoPath,
    lang: detectPrimaryLang(repoPath),
    remote,
    gitHost: host,
    gitGroup: group,
  };
}

interface ParsedRemote {
  host: string;
  repoId: string;
  group: string;
}

/**
 * 解析 git remote URL 为 host / repoId / group
 * 支持 SSH (git@host:group/repo.git) 和 HTTP(S) (https://host/group/repo.git)
 */
function parseGitRemote(remote: string): ParsedRemote {
  let host = '';
  let repoPath = '';

  const sshMatch = remote.match(/^[\w-]+@([\w.:@-]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    host = sshMatch[1];
    repoPath = sshMatch[2];
  } else {
    try {
      const url = new URL(remote);
      host = url.host;
      if (url.port) host = `${url.hostname}:${url.port}`;
      repoPath = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    } catch {
      host = 'unknown';
      repoPath = remote;
    }
  }

  // 归一化：某些 GitLab HTTPS URL 包含 group 前缀，SSH URL 不含
  // 统一去掉配置的前缀保证 SSH/HTTPS 产出相同 repoId
  const stripPrefix = process.env.GITLAB_REPO_PREFIX || '';
  if (stripPrefix && repoPath.startsWith(stripPrefix + '/')) {
    repoPath = repoPath.slice(stripPrefix.length + 1);
  }

  const parts = repoPath.split('/');
  const group = parts.length > 1 ? parts.slice(0, -1).join('/') : '';

  return { host, repoId: repoPath, group };
}

/**
 * 根据项目中特征文件快速判断主要语言
 */
function detectPrimaryLang(repoPath: string): string {
  const checks: [string, string][] = [
    ['pubspec.yaml', 'Flutter'],
    ['Podfile', 'iOS'],
    ['Package.swift', 'iOS'],
    ['build.gradle', 'Java'],
    ['build.gradle.kts', 'Kotlin'],
    ['pom.xml', 'Java'],
    ['composer.json', 'PHP'],
    ['go.mod', 'Go'],
    ['Cargo.toml', 'Rust'],
    ['pyproject.toml', 'Python'],
    ['requirements.txt', 'Python'],
    ['Gemfile', 'Ruby'],
    ['build.sbt', 'Scala'],
    ['CMakeLists.txt', 'C++'],
    ['Makefile', 'C'],
    ['package.json', 'Node'],
    ['tsconfig.json', 'TypeScript'],
  ];

  for (const [file, lang] of checks) {
    if (fs.existsSync(path.join(repoPath, file))) {
      if (file === 'build.gradle' || file === 'build.gradle.kts') {
        const hasAndroidManifest =
          fs.existsSync(path.join(repoPath, 'app', 'src', 'main', 'AndroidManifest.xml')) ||
          fs.existsSync(path.join(repoPath, 'src', 'main', 'AndroidManifest.xml'));
        if (hasAndroidManifest) return 'Android';
      }
      if (file === 'package.json') {
        return refineNodeLang(repoPath);
      }
      return lang;
    }
  }

  return 'unknown';
}

function refineNodeLang(repoPath: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps['vue'] || allDeps['@vue/cli-service'] || allDeps['nuxt']) return 'Vue';
    if (allDeps['react'] || allDeps['react-dom'] || allDeps['next']) return 'React';
    if (allDeps['@angular/core']) return 'Angular';
    if (allDeps['svelte']) return 'Svelte';
    if (allDeps['typescript'] && fs.existsSync(path.join(repoPath, 'tsconfig.json'))) return 'TypeScript';
  } catch {
    // 忽略解析失败
  }
  return 'Node';
}
