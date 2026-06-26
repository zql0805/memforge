// Created by dev on 2026/04/06
// Copyright © 2026
// 拓扑扫描引擎 — 依赖检测模块
// 检测仓库间依赖关系：包管理器依赖 + 协议级依赖（MOA/gRPC/Kafka 等）
// 依赖检测引擎：支持 15+ 语言/框架的自动依赖分析

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
import { getLogger } from '@memforgeai/shared';
import type { ScannedRepo, DetectedDep, RepoSignals } from './types.js';

const logger = getLogger('topology:dep-detection');

// ─── 主入口 ──────────────────────────────────────────────

export interface DepDetectionResult {
  deps: DetectedDep[];
  signals: RepoSignals;
  description: string;
  appKey?: string;
  appKeys?: string[];
}

export function detectDeps(repo: ScannedRepo): DepDetectionResult {
  const deps: DetectedDep[] = [];
  const signals: RepoSignals = {};
  let description = '';

  try {
    const desc = readDescription(repo.localPath, repo.lang);
    if (desc) description = desc;
  } catch (err) {
    logger.warn({ err: (err as Error).message, repoId: repo.repoId }, '读取仓库描述失败');
  }

  const detectors: Array<(r: ScannedRepo, d: DetectedDep[], s: RepoSignals) => void> = [
    detectPhpDeps,
    detectJavaDeps,
    detectGoDeps,
    detectPythonDeps,
    detectRustDeps,
    detectFlutterDeps,
    detectIosDeps,
    detectAndroidDeps,
    detectRubyDeps,
    detectScalaDeps,
    detectCppDeps,
    detectFrontendDeps,
    detectClientApiDeps,
    detectSpringHttpDeps,
    detectBackendEnvDeps,
    detectLaravelConfigDeps,
    detectGoConfigDeps,
    detectKafkaDeps,
    detectInfraDeps,
    detectPhpInnerHttpDeps,
    detectGobackCallbackDeps,
  ];

  for (const detect of detectors) {
    try {
      detect(repo, deps, signals);
    } catch {
      // 单个检测器失败不影响整体
    }
  }

  // 检测 appKey
  try {
    const appKey = detectAppKey(repo.localPath);
    const appKeys = detectAllAppKeys(repo.localPath);
    if (appKey || appKeys.length > 0) {
      return { deps, signals, description, appKey: appKey ?? appKeys[0], appKeys: appKeys.length > 0 ? appKeys : undefined };
    }
  } catch { /* 忽略 */ }

  return { deps, signals, description };
}

// ─── 辅助函数 ─────────────────────────────────────────────

function fileExists(p: string): boolean {
  return fs.existsSync(p);
}

function readFile(p: string): string {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}

function readJson(p: string): unknown {
  try { return JSON.parse(readFile(p)); } catch { return null; }
}

/**
 * 从项目中提取 appKey
 * - Java: src/main/resources/app.yaml 中的 appKey 字段
 * - PHP: index.php 中的 $_SERVER['MOMO_APPKEY'] = 'xxx' 赋值
 */
function detectAppKey(repoPath: string): string | undefined {
  // Java: app.yaml
  const candidates = findFiles(repoPath, /app\.yaml$/, 4);
  for (const f of candidates) {
    if (!f.includes('src/main/resources')) continue;
    const content = readFile(f);
    const match = content.match(/appKey\s*:\s*['"]?([^\s'"#]+)/);
    if (match) return match[1];
  }
  // PHP: index.php 中 MOMO_APPKEY 赋值（MOA 服务如 activity 在 index.php 中硬编码）
  for (const indexPath of ['index.php', 'public/index.php']) {
    const fullPath = path.join(repoPath, indexPath);
    const content = readFile(fullPath);
    if (!content) continue;
    const match = content.match(/MOMO_APPKEY['"]\s*\]\s*=\s*['"]([^'"]+)['"]/);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * 从项目中提取所有关联 appKey（去重）
 * PHP API 网关项目（如 fproject-api）由 Nginx 按 URL 前缀分发到不同 appKey，
 * 在 readme.md / Nginx 配置中声明了多个 MOMO_APPKEY
 */
function detectAllAppKeys(repoPath: string): string[] {
  const keys = new Set<string>();
  // readme.md / *.md 中 Nginx fastcgi_param MOMO_APPKEY 声明
  for (const mdFile of ['readme.md', 'README.md']) {
    const content = readFile(path.join(repoPath, mdFile));
    if (!content) continue;
    const pattern = /MOMO_APPKEY\s+["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      keys.add(m[1]);
    }
  }
  // index.php 中的单 appKey 也加入
  for (const indexPath of ['index.php', 'public/index.php']) {
    const content = readFile(path.join(repoPath, indexPath));
    if (!content) continue;
    const match = content.match(/MOMO_APPKEY['"]\s*\]\s*=\s*['"]([^'"]+)['"]/);
    if (match) keys.add(match[1]);
  }
  return [...keys];
}

function grepFile(filePath: string, pattern: RegExp): string[] {
  const content = readFile(filePath);
  if (!content) return [];
  return content.match(pattern) || [];
}

/**
 * 递归查找匹配的文件（限深度为 5，跳过常见的非代码目录）
 */
function findFiles(dir: string, pattern: RegExp, maxDepth = 5): string[] {
  const results: string[] = [];
  walkForFiles(dir, pattern, 0, maxDepth, results);
  return results;
}

function walkForFiles(
  dir: string, pattern: RegExp, depth: number, maxDepth: number, results: string[],
): void {
  if (depth > maxDepth || results.length > 500) return;
  const skipDirs = new Set([
    'node_modules', '.git', 'vendor', 'target', 'build', 'dist',
    '__pycache__', '.gradle', 'Pods', '.pub-cache', 'test', 'tests',
  ]);

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && pattern.test(e.name)) {
      results.push(full);
    } else if (e.isDirectory() && !skipDirs.has(e.name) && !e.name.startsWith('.')) {
      walkForFiles(full, pattern, depth + 1, maxDepth, results);
    }
  }
}

/**
 * 安全执行 grep 命令并返回匹配行。
 * 优先使用 rg（ripgrep），不可用时自动回退到 grep -rl。
 */
function safeGrep(pattern: string, dir: string, fileGlob: string, maxCount = 50): string[] {
  const execOpts = { encoding: 'utf-8' as const, timeout: 300000, stdio: ['ignore' as const, 'pipe' as const, 'pipe' as const] };
  const excludeGlobs = ['!vendor/**', '!libs/**', '!node_modules/**', '!target/**', '!build/**', '!dist/**'];
  try {
    const args = ['-l', '--glob', fileGlob];
    for (const eg of excludeGlobs) args.push('--glob', eg);
    args.push(pattern, dir);
    const output = execFileSync('rg', args, execOpts);
    return output.trim().split('\n').filter(Boolean).slice(0, maxCount);
  } catch (err) {
    logger.warn({ err: (err as Error).message, dir, pattern }, 'rg 搜索失败，回退 grep');
  }
  try {
    const args = ['-rl', `--include=${fileGlob}`,
      '--exclude-dir=vendor', '--exclude-dir=libs', '--exclude-dir=node_modules', '--exclude-dir=target',
      '-E', pattern, dir];
    const output = execFileSync('grep', args, execOpts);
    return output.trim().split('\n').filter(Boolean).slice(0, maxCount);
  } catch (err) {
    logger.warn({ err: (err as Error).message, dir, pattern }, 'grep 搜索失败');
    return [];
  }
}

function readDescription(repoPath: string, lang: string): string {
  if (lang === 'PHP') {
    const cJson = readJson(path.join(repoPath, 'composer.json')) as { description?: string } | null;
    const desc = cJson?.description || '';
    return sanitizeDesc(desc) || '';
  }
  const pkgJson = readJson(path.join(repoPath, 'package.json')) as { description?: string } | null;
  if (pkgJson?.description) {
    const desc = sanitizeDesc(pkgJson.description);
    if (desc) return desc;
  }

  const readme = readFile(path.join(repoPath, 'README.md'));
  if (readme) {
    for (const line of readme.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const desc = sanitizeDesc(trimmed);
      if (desc) return desc;
    }
  }
  return '';
}

function sanitizeDesc(raw: string): string {
  const trimmed = raw.trim().substring(0, 80);
  if (!trimmed) return '';
  if (/^[`>|!\[\]\-*\d.{}<(]/.test(trimmed)) return '';
  if (/[`{}<>;=()]/.test(trimmed)) return '';
  if (/```/.test(trimmed)) return '';
  if (trimmed.includes('http://') || trimmed.includes('https://')) return '';
  if (trimmed.length < 3) return '';
  return trimmed;
}

// ─── PHP 检测 ─────────────────────────────────────────────

function detectPhpDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  if (repo.lang !== 'PHP') return;

  // MOA consumer 检测（PHP 项目通过 serviceUri 配置引用 Java MOA 服务）
  // 使用 safeGrep 高效查找包含 serviceUri 的文件，避免 findFiles 的 200 文件截断限制
  const moaFiles = safeGrep('serviceUri', repo.localPath, '*.php', 100);
  const serviceUriPattern = /['"]serviceUri['"]\s*=>\s*['"]([^'"]+)['"]/g;
  for (const f of moaFiles) {
    const content = readFile(f);
    let match: RegExpExecArray | null;
    while ((match = serviceUriPattern.exec(content)) !== null) {
      signals.has_moa_consumers = true;
      deps.push({
        type: 'moa_consumer',
        serviceUri: match[1],
        source: path.relative(repo.localPath, f),
        confidence: 0.9,
      });
    }
  }

  // Composer 依赖
  const composerPath = path.join(repo.localPath, 'composer.json');
  if (fileExists(composerPath)) {
    const composer = readJson(composerPath) as { require?: Record<string, string> } | null;
    if (composer?.require) {
      for (const pkg of Object.keys(composer.require)) {
        if (pkg === 'php' || pkg.startsWith('ext-')) continue;
        deps.push({
          type: 'composer',
          artifactId: pkg,
          source: 'composer.json',
          confidence: 0.6,
        });
      }
    }
  }

  // PHP MOA Provider 检测（通过 moa-proxy-service.yaml）
  const moaProxyYaml = path.join(repo.localPath, 'moa-proxy-service.yaml');
  if (fileExists(moaProxyYaml)) {
    const yamlContent = readFile(moaProxyYaml);
    const providerUriPattern = /serviceUri:\s*(\S+)/g;
    let providerMatch: RegExpExecArray | null;
    while ((providerMatch = providerUriPattern.exec(yamlContent)) !== null) {
      signals.provides_moa = true;
      deps.push({
        type: 'moa_provider',
        serviceUri: providerMatch[1],
        source: 'moa-proxy-service.yaml',
        confidence: 0.95,
      });
    }
  }

  // PHP MOA Consumer 方法级追踪
  // 步骤 1: 从 moa/config/*.php 建立 serviceUri → interface 类名映射
  const moaConfigUriToInterface = new Map<string, string>();
  for (const configBase of ['app/models/moa/config', 'application/models/moa/config']) {
    const configDir = path.join(repo.localPath, configBase);
    if (!fileExists(configDir)) continue;
    const configFiles = findFiles(configDir, /\.php$/, 1);
    for (const cf of configFiles) {
      const cfContent = readFile(cf);
      // 匹配配置项中 serviceUri + interface 的组合
      // 'key' => [ 'serviceUri' => '/service/xxx', 'interface' => 'Moa_Service_Yyy', ... ]
      const entryPattern = /['"]serviceUri['"]\s*=>\s*['"]([^'"]+)['"][\s\S]*?['"]interface['"]\s*=>\s*['"]([^'"]+)['"]/g;
      let entryMatch: RegExpExecArray | null;
      while ((entryMatch = entryPattern.exec(cfContent)) !== null) {
        moaConfigUriToInterface.set(entryMatch[1], entryMatch[2]);
      }
    }
  }

  // 步骤 2: 从 moa/service/**/*.php 提取接口方法签名
  // 建立 interface 类名 → method 名列表
  const interfaceMethods = new Map<string, string[]>();
  for (const serviceBase of ['app/models/moa/service', 'application/models/moa/service']) {
    const serviceDir = path.join(repo.localPath, serviceBase);
    if (!fileExists(serviceDir)) continue;
    const serviceFiles = findFiles(serviceDir, /\.php$/, 4);
    for (const sf of serviceFiles) {
      const sfContent = readFile(sf);
      // 提取接口名
      const ifaceMatch = sfContent.match(/interface\s+(Moa_Service_\w+)/);
      if (!ifaceMatch) continue;
      const ifaceName = ifaceMatch[1];
      // 提取 public function 方法名
      const methods: string[] = [];
      const methodPattern = /(?:public\s+)?function\s+(\w+)\s*\(/g;
      let mm: RegExpExecArray | null;
      while ((mm = methodPattern.exec(sfContent)) !== null) {
        if (mm[1] !== '__construct') methods.push(mm[1]);
      }
      if (methods.length > 0) {
        interfaceMethods.set(ifaceName, methods);
      }
    }
  }

  // 步骤 3: 将 serviceUri → interface → methods 关联，为已有 consumer dep 补充 methodName
  for (const [uri, ifaceName] of moaConfigUriToInterface) {
    const methods = interfaceMethods.get(ifaceName);
    if (!methods || methods.length === 0) continue;
    for (const methodName of methods) {
      deps.push({
        type: 'moa_consumer',
        serviceUri: uri,
        methodName,
        source: `moa/config→${ifaceName}`,
        confidence: 0.85,
      });
    }
  }

  // 步骤 4: 为 moa-proxy-service.yaml 中声明的 provider serviceUri 补充方法名
  // 从本项目的 moa/config 反查: 如果某个 serviceUri 既是本项目的 provider 又在 config 中有 interface 映射
  if (signals.provides_moa) {
    for (const dep of [...deps]) {
      if (dep.type !== 'moa_provider' || !dep.serviceUri || dep.methodName) continue;
      const ifaceName = moaConfigUriToInterface.get(dep.serviceUri);
      if (!ifaceName) continue;
      const methods = interfaceMethods.get(ifaceName);
      if (!methods) continue;
      for (const methodName of methods) {
        deps.push({
          type: 'moa_provider',
          serviceUri: dep.serviceUri,
          methodName,
          source: dep.source,
          confidence: 0.95,
        });
      }
    }
  }

  // PHP 目录结构信号
  if (fileExists(path.join(repo.localPath, 'application', 'controllers', 'api'))) {
    signals.has_api_controllers = true;
  }
  if (fileExists(path.join(repo.localPath, 'application', 'controllers', 'inner'))) {
    signals.has_inner_controllers = true;
  }
  if (fileExists(path.join(repo.localPath, 'application', 'controllers', 'task'))) {
    signals.has_task_controllers = true;
  }

  // PHP 框架内部服务路径调用检测
  // 匹配如 /service/group/team/service-name 形式的内部服务引用
  const phpServiceFiles = safeGrep('/service/', repo.localPath, '*.php', 100);
  const servicePathPattern = /['"]\/service\/([a-zA-Z0-9/_-]+)['"]/g;
  for (const f of phpServiceFiles) {
    const content = readFile(f);
    let match: RegExpExecArray | null;
    servicePathPattern.lastIndex = 0;
    while ((match = servicePathPattern.exec(content)) !== null) {
      const servicePath = match[1];
      signals.has_php_service_calls = true;
      deps.push({
        type: 'php_service',
        servicePath,
        source: path.relative(repo.localPath, f),
        confidence: 0.85,
      });
    }
  }
}

// ─── Java 检测 ────────────────────────────────────────────

function detectJavaDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  if (repo.lang !== 'Java' && repo.lang !== 'Kotlin') return;

  // POM 依赖
  const pomFiles = findFiles(repo.localPath, /pom\.xml$/);
  for (const pom of pomFiles) {
    parseJavaPom(pom, repo, deps);
  }

  // MOA Provider/Consumer 检测
  // @MoaProvider 使用 uri= 属性；@MoaConsumer/@RedisMoaConsumer 使用 serviceUri= 属性
  const javaFiles = safeGrep('@MoaProvider|@MoaConsumer|@RedisMoaConsumer', repo.localPath, '*.java');
  for (const f of javaFiles) {
    const content = readFile(f);
    if (content.includes('@MoaProvider')) {
      signals.provides_moa = true;
      const providerUriMatches = content.match(/@MoaProvider\s*\(\s*uri\s*=\s*"([^"]+)"/g);
      if (providerUriMatches) {
        for (const m of providerUriMatches) {
          const uri = m.match(/"([^"]+)"/)?.[1];
          if (uri) {
            deps.push({
              type: 'moa_provider',
              serviceUri: uri,
              source: path.relative(repo.localPath, f),
              confidence: 0.95,
            });
          }
        }
      }
      // 提取 Provider 类中的 public 方法名
      const methodMatches = content.match(/public\s+\w[\w<>,\s]*?\s+(\w+)\s*\(/g);
      if (methodMatches) {
        for (const mm of methodMatches) {
          const methodName = mm.match(/(\w+)\s*\($/)?.[1];
          if (methodName && !['toString', 'hashCode', 'equals', 'getClass'].includes(methodName)) {
            const existingProviderDep = deps.find(d => d.type === 'moa_provider' && d.source === path.relative(repo.localPath, f));
            if (existingProviderDep) {
              deps.push({
                type: 'moa_provider',
                serviceUri: existingProviderDep.serviceUri,
                methodName,
                source: path.relative(repo.localPath, f),
                confidence: 0.95,
              });
            }
          }
        }
      }
    }
    if (content.includes('@MoaConsumer') || content.includes('@RedisMoaConsumer')) {
      signals.has_moa_consumers = true;

      // 提取 @MoaConsumer 注解的字段名和 serviceUri
      // 格式: @MoaConsumer(serviceUri = "xxx") private Type fieldName;
      // 或: @RedisMoaConsumer(serviceUri = "xxx") private Type fieldName;
      const consumerFieldPattern = /@(?:Moa|RedisMoa)Consumer\s*\([^)]*(?:serviceUri|uri)\s*=\s*"([^"]+)"[^)]*\)\s*(?:private|protected|public)?\s+\w[\w<>,\s]*?\s+(\w+)\s*;/g;
      let fieldMatch: RegExpExecArray | null;
      const fieldToUri = new Map<string, string>();

      while ((fieldMatch = consumerFieldPattern.exec(content)) !== null) {
        const uri = fieldMatch[1];
        const fieldName = fieldMatch[2];
        fieldToUri.set(fieldName, uri);

        deps.push({
          type: 'moa_consumer',
          serviceUri: uri,
          consumerFieldName: fieldName,
          source: path.relative(repo.localPath, f),
          confidence: 0.95,
        });
      }

      // 如果未通过字段模式提取到（可能是构造注入等），降级到原始提取
      if (fieldToUri.size === 0) {
        const consumerUriMatches = content.match(/(?:serviceUri|uri)\s*=\s*"([^"]+)"/g);
        if (consumerUriMatches) {
          for (const m of consumerUriMatches) {
            const uri = m.match(/"([^"]+)"/)?.[1];
            if (uri) {
              deps.push({
                type: 'moa_consumer',
                serviceUri: uri,
                source: path.relative(repo.localPath, f),
                confidence: 0.95,
              });
            }
          }
        }
      }

      // 全局追踪字段方法调用
      // 支持两种模式：
      // 1. 直接引用: fieldName.someMethod(
      // 2. Lombok getter 链式调用: wrapper.getFieldName().someMethod(
      const hasLombokGetter = /^@(?:Getter|Data|Value)\b/m.test(content);
      for (const [fieldName, uri] of fieldToUri) {
        const calledMethods = new Set<string>();

        // 推断 Lombok getter 名：fieldName → getFieldName
        const getterName = 'get' + fieldName.charAt(0).toUpperCase() + fieldName.slice(1);

        // 当前文件搜索（直接引用）
        const callPattern = new RegExp(`${fieldName}\\s*\\.\\s*(\\w+)\\s*\\(`, 'g');
        let callMatch: RegExpExecArray | null;
        while ((callMatch = callPattern.exec(content)) !== null) {
          calledMethods.add(callMatch[1]);
        }

        // 全局搜索：直接引用 fieldName.method( 和 Lombok getter 链式调用 getFieldName().method(
        const searchPatterns = [`${fieldName}\\.`];
        if (hasLombokGetter) {
          searchPatterns.push(`${getterName}()`);
        }

        for (const glob of ['*.java', '*.php']) {
          const globalFiles = safeGrep(searchPatterns.join('|'), repo.localPath, glob, 99999);
          for (const gf of globalFiles) {
            if (gf === f) continue;
            const gContent = readFile(gf);

            // 直接引用：fieldName.method(
            const gCallPattern = new RegExp(`${fieldName}\\s*\\.\\s*(\\w+)\\s*\\(`, 'g');
            let gMatch: RegExpExecArray | null;
            while ((gMatch = gCallPattern.exec(gContent)) !== null) {
              calledMethods.add(gMatch[1]);
            }

            // Lombok getter 链式调用：xxx.getFieldName().method(
            if (hasLombokGetter) {
              const getterCallPattern = new RegExp(`${getterName}\\s*\\(\\s*\\)\\s*\\.\\s*(\\w+)\\s*\\(`, 'g');
              let gcMatch: RegExpExecArray | null;
              while ((gcMatch = getterCallPattern.exec(gContent)) !== null) {
                calledMethods.add(gcMatch[1]);
              }
            }
          }
        }

        for (const methodName of calledMethods) {
          deps.push({
            type: 'moa_consumer',
            serviceUri: uri,
            methodName,
            consumerFieldName: fieldName,
            source: path.relative(repo.localPath, f),
            confidence: 0.95,
          });
        }
      }
    }
  }

  // Spring Web 检测
  const springFiles = safeGrep('@RestController|@Controller|@RequestMapping', repo.localPath, '*.java');
  if (springFiles.length > 0) {
    signals.has_spring_web = true;
  }

  // HTTP 端点检测：提取 @RestController + @RequestMapping/@GetMapping 等
  if (signals.has_spring_web) {
    for (const sf of springFiles) {
      const content = readFile(sf);
      // 提取类级 path
      const classPathMatch = content.match(/@(?:Request)?Mapping\s*\(\s*(?:value\s*=\s*)?(?:\{[^}]*"([^"]+)"|"([^"]+)")/);
      const classPath = classPathMatch?.[1] || classPathMatch?.[2] || '';

      // 提取方法级 path
      const methodMappings = content.match(/@(?:Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*)?(?:\{[^}]*"([^"]+)"|"([^"]+)")/g);
      if (methodMappings) {
        for (const mm of methodMappings) {
          const pathMatch = mm.match(/"([^"]+)"/);
          if (pathMatch) {
            const methodPath = pathMatch[1];
            const fullPath = classPath ? `${classPath.replace(/\/$/, '')}/${methodPath.replace(/^\//, '')}` : methodPath;
            deps.push({
              type: 'moa_provider',  // 复用 type，通过 httpPath 字段区分
              httpPath: fullPath,
              source: path.relative(repo.localPath, sf),
              confidence: 0.9,
            });
          }
        }
      }
    }
  }

  // Proto/gRPC 检测
  const protoFiles = findFiles(repo.localPath, /\.proto$/);
  if (protoFiles.length > 0) {
    signals.has_proto = true;
    const hasGrpc = protoFiles.some(f => readFile(f).includes('service '));
    if (hasGrpc) signals.has_grpc = true;
  }
}

function parseJavaPom(pomPath: string, repo: ScannedRepo, deps: DetectedDep[]): void {
  const content = readFile(pomPath);
  if (!content) return;

  const depPattern = /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/g;
  let match: RegExpExecArray | null;
  while ((match = depPattern.exec(content)) !== null) {
    const [, groupId, artifactId] = match;
    if (groupId.startsWith('org.springframework') ||
        groupId.startsWith('org.apache') ||
        groupId.startsWith('junit') ||
        groupId.startsWith('org.slf4j') ||
        groupId.startsWith('com.google') ||
        groupId === 'org.projectlombok') {
      continue;
    }
    deps.push({
      type: 'maven',
      groupId,
      artifactId,
      source: path.relative(repo.localPath, pomPath),
      confidence: 0.7,
    });
  }
}

// ─── Go 检测 ──────────────────────────────────────────────

function detectGoDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  if (repo.lang !== 'Go') return;

  const goModPath = path.join(repo.localPath, 'go.mod');
  if (!fileExists(goModPath)) return;

  const content = readFile(goModPath);
  const requireBlock = content.match(/require\s*\(([\s\S]*?)\)/);
  if (requireBlock) {
    const lines = requireBlock[1].split('\n');
    for (const line of lines) {
      const modMatch = line.trim().match(/^([\w./-]+)\s+/);
      if (modMatch && !modMatch[1].startsWith('//')) {
        deps.push({
          type: 'go_module',
          module: modMatch[1],
          source: 'go.mod',
          confidence: 0.7,
        });
      }
    }
  }

  // gRPC / HTTP framework 信号
  if (content.includes('google.golang.org/grpc')) signals.has_grpc = true;
  if (content.includes('github.com/gin-gonic/gin') || content.includes('github.com/labstack/echo')) {
    signals.has_http_framework = true;
    signals.web_framework = 'gin/echo';
  }
}

// ─── Python 检测 ──────────────────────────────────────────

function detectPythonDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  if (repo.lang !== 'Python') return;

  // requirements.txt
  const reqPath = path.join(repo.localPath, 'requirements.txt');
  if (fileExists(reqPath)) {
    const lines = readFile(reqPath).split('\n');
    for (const line of lines) {
      const pkg = line.trim().split(/[>=<!\s]/)[0];
      if (pkg && !pkg.startsWith('#') && !pkg.startsWith('-')) {
        deps.push({
          type: 'npm',
          artifactId: pkg,
          source: 'requirements.txt',
          confidence: 0.5,
        });
      }
    }
  }

  // pyproject.toml
  const pyprojectPath = path.join(repo.localPath, 'pyproject.toml');
  if (fileExists(pyprojectPath)) {
    const content = readFile(pyprojectPath);
    if (content.includes('django') || content.includes('Django')) {
      signals.has_http_framework = true;
      signals.web_framework = 'django';
    }
    if (content.includes('flask') || content.includes('Flask')) {
      signals.has_http_framework = true;
      signals.web_framework = 'flask';
    }
    if (content.includes('fastapi') || content.includes('FastAPI')) {
      signals.has_http_framework = true;
      signals.web_framework = 'fastapi';
    }
    if (content.includes('celery')) signals.has_celery = true;
  }

  // ML / AI 信号
  const mlLibs = ['torch', 'tensorflow', 'transformers', 'sklearn', 'keras', 'onnx'];
  const allPyDeps = readFile(reqPath) + readFile(pyprojectPath);
  if (mlLibs.some(lib => allPyDeps.includes(lib))) {
    signals.has_ml = true;
  }
}

// ─── Rust 检测 ─────────────────────────────────────────────

function detectRustDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  if (repo.lang !== 'Rust') return;

  const cargoPath = path.join(repo.localPath, 'Cargo.toml');
  if (!fileExists(cargoPath)) return;

  const content = readFile(cargoPath);
  const inDeps = content.indexOf('[dependencies]');
  if (inDeps === -1) return;

  const depsSection = content.substring(inDeps);
  const nextSection = depsSection.indexOf('\n[', 1);
  const block = nextSection > 0 ? depsSection.substring(0, nextSection) : depsSection;

  const lines = block.split('\n');
  for (const line of lines) {
    const m = line.match(/^(\w[\w-]*)\s*=/);
    if (m) {
      deps.push({
        type: 'npm',
        artifactId: m[1],
        source: 'Cargo.toml',
        confidence: 0.5,
      });
    }
  }

  if (content.includes('actix') || content.includes('axum') || content.includes('rocket')) {
    signals.has_http_framework = true;
  }
  if (content.includes('tonic') || content.includes('prost')) {
    signals.has_grpc = true;
  }
}

// ─── Flutter 检测 ──────────────────────────────────────────

function detectFlutterDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  if (repo.lang !== 'Flutter') return;

  const pubspecPath = path.join(repo.localPath, 'pubspec.yaml');
  if (!fileExists(pubspecPath)) return;

  const content = readFile(pubspecPath);
  if (content.includes('firebase')) signals.has_firebase = true;

  const depLines = content.split('\n');
  let inDeps = false;
  for (const line of depLines) {
    if (line.match(/^dependencies:/)) { inDeps = true; continue; }
    if (line.match(/^\S/) && inDeps) break;
    if (inDeps) {
      const m = line.match(/^\s+([\w_]+):/);
      if (m && m[1] !== 'flutter' && m[1] !== 'flutter_test') {
        deps.push({
          type: 'npm',
          artifactId: m[1],
          source: 'pubspec.yaml',
          confidence: 0.4,
        });
      }
    }
  }
}

// ─── iOS 检测 ──────────────────────────────────────────────

function detectIosDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  if (repo.lang !== 'iOS') return;

  const podfilePath = path.join(repo.localPath, 'Podfile');
  if (fileExists(podfilePath)) {
    const content = readFile(podfilePath);
    const podPattern = /pod\s+['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = podPattern.exec(content)) !== null) {
      deps.push({
        type: 'npm',
        artifactId: m[1],
        source: 'Podfile',
        confidence: 0.5,
      });
    }
    if (content.includes('Firebase')) signals.has_firebase = true;
  }

  const swiftPkgPath = path.join(repo.localPath, 'Package.swift');
  if (fileExists(swiftPkgPath)) {
    const content = readFile(swiftPkgPath);
    const urlPattern = /url:\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = urlPattern.exec(content)) !== null) {
      deps.push({
        type: 'npm',
        artifactId: m[1],
        source: 'Package.swift',
        confidence: 0.5,
      });
    }
  }
}

// ─── Android 检测 ──────────────────────────────────────────

function detectAndroidDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  if (repo.lang !== 'Android') return;

  const gradleFiles = findFiles(repo.localPath, /build\.gradle(\.kts)?$/);
  for (const gf of gradleFiles) {
    const content = readFile(gf);
    const implPattern = /implementation\s+['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = implPattern.exec(content)) !== null) {
      const parts = m[1].split(':');
      if (parts.length >= 2) {
        deps.push({
          type: 'maven',
          groupId: parts[0],
          artifactId: parts[1],
          source: path.relative(repo.localPath, gf),
          confidence: 0.5,
        });
      }
    }
    if (content.includes('firebase')) signals.has_firebase = true;
  }
}

// ─── Ruby 检测 ─────────────────────────────────────────────

function detectRubyDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  if (repo.lang !== 'Ruby') return;

  const gemfilePath = path.join(repo.localPath, 'Gemfile');
  if (!fileExists(gemfilePath)) return;

  const content = readFile(gemfilePath);
  const gemPattern = /gem\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = gemPattern.exec(content)) !== null) {
    deps.push({
      type: 'npm',
      artifactId: m[1],
      source: 'Gemfile',
      confidence: 0.5,
    });
  }

  if (content.includes("'rails'") || content.includes('"rails"')) {
    signals.has_http_framework = true;
    signals.web_framework = 'rails';
  }
}

// ─── Scala 检测 ────────────────────────────────────────────

function detectScalaDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  if (repo.lang !== 'Scala') return;

  const sbtPath = path.join(repo.localPath, 'build.sbt');
  if (!fileExists(sbtPath)) return;

  const content = readFile(sbtPath);
  const depPattern = /"([^"]+)"\s+%%?\s+"([^"]+)"\s+%\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = depPattern.exec(content)) !== null) {
    deps.push({
      type: 'maven',
      groupId: m[1],
      artifactId: m[2],
      source: 'build.sbt',
      confidence: 0.5,
    });
  }

  if (content.includes('akka-http') || content.includes('play')) {
    signals.has_http_framework = true;
  }
}

// ─── C/C++ 检测 ────────────────────────────────────────────

function detectCppDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  if (repo.lang !== 'C++' && repo.lang !== 'C') return;

  const cmakePath = path.join(repo.localPath, 'CMakeLists.txt');
  if (!fileExists(cmakePath)) return;

  const content = readFile(cmakePath);
  const findPkgPattern = /find_package\((\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = findPkgPattern.exec(content)) !== null) {
    deps.push({
      type: 'npm',
      artifactId: m[1],
      source: 'CMakeLists.txt',
      confidence: 0.4,
    });
  }

  if (content.includes('gRPC') || content.includes('grpc')) signals.has_grpc = true;
}

// ─── 前端项目检测（proxy 代理、.env API 地址、axios baseURL、微前端）──────

/** 匹配 target: 后跟单引号、双引号或模板字符串的 URL */
const PROXY_TARGET_RE = /target:\s*['"`]([^'"`]+)['"`]/g;

function detectFrontendDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  const lang = repo.lang;
  if (lang !== 'Vue' && lang !== 'React' && lang !== 'Angular' && lang !== 'Node' && lang !== 'TypeScript') return;

  // ── 1. devServer / Vite proxy target ──
  const proxyConfigFiles = [
    'vue.config.js', 'vue.config.ts', 'webpack.config.js',
    'vite.config.ts', 'vite.config.js', 'vite.config.mts',
  ];
  for (const cf of proxyConfigFiles) {
    const cfPath = path.join(repo.localPath, cf);
    if (!fileExists(cfPath)) continue;
    const content = readFile(cfPath);
    PROXY_TARGET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PROXY_TARGET_RE.exec(content)) !== null) {
      try {
        const url = new URL(m[1]);
        deps.push({ type: 'proxy', domain: url.hostname, source: cf, confidence: 0.7 });
      } catch { /* 非法 URL */ }
    }
    // 简写语法: '/path': 'https://xxx'（Vite shorthand）
    const shorthandRe = /['"`]\/\w+['"`]\s*:\s*['"`](https?:\/\/[^'"`]+)['"`]/g;
    let sh: RegExpExecArray | null;
    while ((sh = shorthandRe.exec(content)) !== null) {
      try {
        const url = new URL(sh[1]);
        deps.push({ type: 'proxy', domain: url.hostname, source: cf, confidence: 0.65 });
      } catch { /* 非法 URL */ }
    }
  }

  // ── 2. .env 文件中的 API 地址 ──
  const envFiles = [
    '.env', '.env.local',
    '.env.development', '.env.dev', '.env.alpha', '.env.test',
    '.env.staging', '.env.stage',
    '.env.production', '.env.prod',
  ];
  for (const ef of envFiles) {
    const envPath = path.join(repo.localPath, ef);
    if (!fileExists(envPath)) continue;
    const content = readFile(envPath);
    const urlPattern = /(?:API|BASE|BACKEND|SERVER|SERVICE|URL|HOST|ENDPOINT).*?=\s*['"]?(https?:\/\/[^\s'"]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = urlPattern.exec(content)) !== null) {
      try {
        const url = new URL(m[1]);
        deps.push({ type: 'env_api', domain: url.hostname, source: ef, confidence: 0.6 });
      } catch { /* 非法 URL */ }
    }
  }

  // ── 3. axios / fetch baseURL 检测 ──
  const requestFiles = [
    'src/utils/request.js', 'src/utils/request.ts',
    'src/utils/http.js', 'src/utils/http.ts',
    'src/api/index.js', 'src/api/index.ts',
    'src/api/request.js', 'src/api/request.ts',
    'src/services/request.js', 'src/services/request.ts',
    'src/utils/axios.js', 'src/utils/axios.ts',
  ];
  const baseUrlRe = /baseURL\s*[:=]\s*['"`](https?:\/\/[^'"`]+)['"`]/g;
  for (const rf of requestFiles) {
    const rfPath = path.join(repo.localPath, rf);
    if (!fileExists(rfPath)) continue;
    const content = readFile(rfPath);
    baseUrlRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = baseUrlRe.exec(content)) !== null) {
      try {
        const url = new URL(m[1]);
        deps.push({ type: 'env_api', domain: url.hostname, source: rf, confidence: 0.75 });
      } catch { /* 非法 URL */ }
    }
  }

  // ── 4. 微前端框架检测（wujie / qiankun / micro-app） ──
  detectMicroFrontendDeps(repo, deps, signals);
}

/** 检测微前端子应用注册，提取 entry URL 关联到其他前端仓库 */
function detectMicroFrontendDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  const pkgPath = path.join(repo.localPath, 'package.json');
  if (!fileExists(pkgPath)) return;

  const pkgContent = readFile(pkgPath);
  const microFrontendPkgs: Record<string, string> = {
    'wujie': 'wujie',
    'wujie-vue2': 'wujie',
    'wujie-vue3': 'wujie',
    'wujie-react': 'wujie',
    'qiankun': 'qiankun',
    '@micro-zoe/micro-app': 'micro-app',
  };

  let detectedFramework = '';
  for (const [pkg, framework] of Object.entries(microFrontendPkgs)) {
    if (pkgContent.includes(`"${pkg}"`)) {
      detectedFramework = framework;
      break;
    }
  }
  if (!detectedFramework) return;

  signals.has_micro_frontend = true;
  signals.micro_frontend_framework = detectedFramework;

  // 扫描 src/ 下的 JS/TS/Vue 文件查找子应用 entry URL
  const srcDir = path.join(repo.localPath, 'src');
  if (!fs.existsSync(srcDir)) return;
  const entryFiles = findFiles(srcDir, /\.(js|ts|vue)$/, 4);
  const entryUrlRe = /(?:url|entry)\s*[:=]\s*['"`](https?:\/\/[^'"`\s]+)['"`]/gi;

  for (const ef of entryFiles.slice(0, 50)) {
    const content = readFile(ef);
    entryUrlRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = entryUrlRe.exec(content)) !== null) {
      try {
        const url = new URL(m[1]);
        deps.push({
          type: 'micro_frontend',
          domain: url.hostname,
          source: path.relative(repo.localPath, ef),
          confidence: 0.7,
        });
      } catch { /* 非法 URL */ }
    }
  }
}

// ─── 客户端项目 API URL 检测（Flutter/iOS/Android）─────────

function detectClientApiDeps(repo: ScannedRepo, deps: DetectedDep[], _signals: RepoSignals): void {
  if (repo.lang !== 'Flutter' && repo.lang !== 'iOS' && repo.lang !== 'Android') return;

  const urlExtract = /https?:\/\/[a-zA-Z0-9._-]+\.[a-zA-Z]{2,}/g;
  const apiHints = /api|backend|server|gateway/i;

  // Flutter: 检查 assets/ 和 lib/core/config/ 下的 JSON/YAML/Dart 配置
  if (repo.lang === 'Flutter') {
    const configFiles = [
      ...findFiles(path.join(repo.localPath, 'assets'), /\.(json|yaml|yml)$/, 2),
      ...findFiles(path.join(repo.localPath, 'lib'), /config.*\.dart$/i, 4),
    ];
    for (const cf of configFiles.slice(0, 20)) {
      const content = readFile(cf);
      let m: RegExpExecArray | null;
      while ((m = urlExtract.exec(content)) !== null) {
        try {
          const url = new URL(m[0]);
          if (apiHints.test(url.hostname) || apiHints.test(m[0])) {
            deps.push({
              type: 'env_api',
              domain: url.hostname,
              source: path.relative(repo.localPath, cf),
              confidence: 0.5,
            });
          }
        } catch { /* 非法 URL */ }
      }
    }
  }

  // iOS: 检查 .xcconfig 和 Info.plist
  if (repo.lang === 'iOS') {
    const configFiles = findFiles(repo.localPath, /\.(xcconfig|plist)$/, 3);
    for (const cf of configFiles.slice(0, 10)) {
      const content = readFile(cf);
      let m: RegExpExecArray | null;
      while ((m = urlExtract.exec(content)) !== null) {
        try {
          const url = new URL(m[0]);
          if (apiHints.test(url.hostname)) {
            deps.push({
              type: 'env_api',
              domain: url.hostname,
              source: path.relative(repo.localPath, cf),
              confidence: 0.5,
            });
          }
        } catch { /* 非法 URL */ }
      }
    }
  }

  // Android: 检查 gradle.properties 和 build.gradle
  if (repo.lang === 'Android') {
    const configFiles = findFiles(repo.localPath, /gradle\.properties$|build\.gradle(\.kts)?$/, 2);
    for (const cf of configFiles.slice(0, 10)) {
      const content = readFile(cf);
      let m: RegExpExecArray | null;
      while ((m = urlExtract.exec(content)) !== null) {
        try {
          const url = new URL(m[0]);
          if (apiHints.test(url.hostname)) {
            deps.push({
              type: 'env_api',
              domain: url.hostname,
              source: path.relative(repo.localPath, cf),
              confidence: 0.5,
            });
          }
        } catch { /* 非法 URL */ }
      }
    }
  }
}

// ─── 后端 HTTP 内部调用检测 ────────────────────────────────

const EXTERNAL_DOMAIN_BLOCKLIST = /\b(google|facebook|github|amazonaws|cloudflare|sentry|stripe|wechat|weixin|apple|firebase|cdn\.|static\.|fonts\.|maps\.|play\.google|itunes|gravatar|jsdelivr|unpkg|aliyun|qcloud|tencent|baidu|163\.com|douyin|bytedance|dingtalk)\b/i;

function isLikelyInternalUrl(hostname: string): boolean {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return true;
  if (hostname === 'localhost') return true;
  if (/\.(local|internal|corp|lan|svc|cluster)$/i.test(hostname)) return true;
  const internalDomains = (process.env.INTERNAL_DOMAINS || 'example.com,internal.example.com').split(',');
  if (internalDomains.some(d => hostname.endsWith(d.trim()))) return true;
  return false;
}

function extractHttpUrls(content: string, source: string, deps: DetectedDep[], confidence: number): void {
  const urlPattern = /https?:\/\/[a-zA-Z0-9._:/-]+/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = urlPattern.exec(content)) !== null) {
    try {
      const rawUrl = m[0].replace(/[,;'")\]}>]+$/, '');
      const url = new URL(rawUrl);
      const host = url.hostname;
      if (seen.has(host)) continue;
      seen.add(host);
      if (isLikelyInternalUrl(host)) {
        deps.push({ type: 'httpApi', domain: host, source, confidence });
      }
    } catch { /* 非法 URL */ }
  }
}

function detectSpringHttpDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  if (repo.lang !== 'Java' && repo.lang !== 'Kotlin') return;

  // P0: application*.yml/yaml/properties 中的 HTTP URL
  const springConfigs = findFiles(repo.localPath, /application.*\.(yml|yaml|properties)$/, 3);
  for (const sc of springConfigs) {
    const content = readFile(sc);
    const lines = content.split('\n');
    for (const line of lines) {
      if (/^\s*#/.test(line)) continue;
      const urlMatch = line.match(/https?:\/\/[a-zA-Z0-9._:/-]+/);
      if (urlMatch) {
        try {
          const rawUrl = urlMatch[0].replace(/[,;'")\]}>]+$/, '');
          const url = new URL(rawUrl);
          if (isLikelyInternalUrl(url.hostname) && !/jdbc:|redis:|mongo:|kafka|amqp/i.test(line)) {
            deps.push({
              type: 'httpApi',
              domain: url.hostname,
              source: path.relative(repo.localPath, sc),
              confidence: 0.6,
            });
          }
        } catch { /* 非法 URL */ }
      }
    }
  }

  // P0: @FeignClient 注解
  const feignFiles = safeGrep('@FeignClient', repo.localPath, '*.java', 30);
  for (const f of feignFiles) {
    const content = readFile(f);
    signals.has_feign = true;
    const feignPattern = /@FeignClient\s*\([^)]*url\s*=\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = feignPattern.exec(content)) !== null) {
      const raw = m[1];
      if (raw.startsWith('${')) continue;
      try {
        const url = new URL(raw);
        deps.push({
          type: 'httpApi',
          domain: url.hostname,
          source: path.relative(repo.localPath, f),
          confidence: 0.85,
        });
      } catch { /* 非法 URL */ }
    }
    const namePattern = /@FeignClient\s*\([^)]*name\s*=\s*["']([^"']+)["']/g;
    while ((m = namePattern.exec(content)) !== null) {
      deps.push({
        type: 'httpApi',
        domain: m[1],
        source: path.relative(repo.localPath, f),
        confidence: 0.7,
      });
    }
  }

  // P2: @Value("${...url}") 属性注入
  const valueFiles = safeGrep('@Value.*url|@Value.*uri|@Value.*host', repo.localPath, '*.java', 20);
  for (const f of valueFiles) {
    const content = readFile(f);
    const valuePattern = /@Value\s*\(\s*"\$\{([^}]+(?:url|uri|host|endpoint)[^}]*)}"?\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = valuePattern.exec(content)) !== null) {
      signals.has_http_clients = true;
    }
  }
}

function detectBackendEnvDeps(repo: ScannedRepo, deps: DetectedDep[], _signals: RepoSignals): void {
  if (repo.lang === 'Vue' || repo.lang === 'React' || repo.lang === 'Angular' ||
      repo.lang === 'Flutter' || repo.lang === 'iOS' || repo.lang === 'Android') return;

  const envFiles = ['.env', '.env.example', '.env.local', '.env.development', '.env.production'];
  for (const ef of envFiles) {
    const envPath = path.join(repo.localPath, ef);
    if (!fileExists(envPath)) continue;
    const content = readFile(envPath);
    const urlPattern = /(?:_URL|_HOST|_ENDPOINT|_BASE|_API|_SERVER|APP_URL|WEB_HOST|SERVICE_).*?=\s*['"]?(https?:\/\/[^\s'"#]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = urlPattern.exec(content)) !== null) {
      try {
        const url = new URL(m[1].replace(/['"]+$/, ''));
        if (isLikelyInternalUrl(url.hostname)) {
          deps.push({
            type: 'httpApi',
            domain: url.hostname,
            source: ef,
            confidence: 0.55,
          });
        }
      } catch { /* 非法 URL */ }
    }
  }
}

function detectLaravelConfigDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  if (repo.lang !== 'PHP') return;

  // Laravel: config/  |  MPF: app/config/  |  其他变体
  const configDirs = [
    path.join(repo.localPath, 'config'),
    path.join(repo.localPath, 'app', 'config'),
  ];
  const foundDirs = configDirs.filter(d => fs.existsSync(d));
  if (foundDirs.length === 0) return;

  signals.is_laravel = true;
  for (const configDir of foundDirs) {
    const configFiles = findFiles(configDir, /\.php$/, 1);
    for (const cf of configFiles.slice(0, 20)) {
      const content = readFile(cf);
      const urlPattern = /['"]https?:\/\/[a-zA-Z0-9._:/-]+['"]/g;
      let m: RegExpExecArray | null;
      while ((m = urlPattern.exec(content)) !== null) {
        const raw = m[0].slice(1, -1);
        try {
          const url = new URL(raw);
          if (isLikelyInternalUrl(url.hostname)) {
            deps.push({
              type: 'httpApi',
              domain: url.hostname,
              source: path.relative(repo.localPath, cf),
              confidence: 0.55,
            });
          }
        } catch { /* 非法 URL */ }
      }
      const envPattern = /env\s*\(\s*['"]([^'"]*(?:URL|HOST|ENDPOINT|API|SERVER)[^'"]*)['"]\s*,\s*['"]?(https?:\/\/[^\s'"]+)/gi;
      while ((m = envPattern.exec(content)) !== null) {
        try {
          const url = new URL(m[2].replace(/['"]+$/, ''));
          if (isLikelyInternalUrl(url.hostname)) {
            deps.push({
              type: 'httpApi',
              domain: url.hostname,
              source: path.relative(repo.localPath, cf),
              confidence: 0.6,
            });
          }
        } catch { /* 非法 URL */ }
      }
    }
  }
}

function detectGoConfigDeps(repo: ScannedRepo, deps: DetectedDep[], _signals: RepoSignals): void {
  if (repo.lang !== 'Go') return;

  const configDirs = [
    path.join(repo.localPath, 'configs'),
    path.join(repo.localPath, 'config'),
    repo.localPath,
  ];

  for (const dir of configDirs) {
    if (!fs.existsSync(dir)) continue;
    const configFiles = findFiles(dir, /config.*\.(ya?ml|toml|json)$/, 1);
    for (const cf of configFiles.slice(0, 10)) {
      const content = readFile(cf);
      extractHttpUrls(content, path.relative(repo.localPath, cf), deps, 0.55);
    }
  }

  const envFiles = ['.env', '.env.example'];
  for (const ef of envFiles) {
    const envPath = path.join(repo.localPath, ef);
    if (fileExists(envPath)) {
      const content = readFile(envPath);
      const urlPattern = /https?:\/\/[a-zA-Z0-9._:/-]+/g;
      let m: RegExpExecArray | null;
      while ((m = urlPattern.exec(content)) !== null) {
        try {
          const url = new URL(m[0].replace(/[,;'")\]}>]+$/, ''));
          if (isLikelyInternalUrl(url.hostname)) {
            deps.push({
              type: 'httpApi',
              domain: url.hostname,
              source: ef,
              confidence: 0.5,
            });
          }
        } catch { /* 非法 URL */ }
      }
    }
  }
}

// ─── Kafka / MQ 检测 ──────────────────────────────────────

function detectKafkaDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  const mqPatterns = [
    /RabbitTemplate|@RabbitListener|amqp/,
    /RocketMQTemplate|@RocketMQMessageListener/,
  ];

  // 检测 application.yml / application.properties 中的 Kafka / MQ 配置（信号级别）
  const springConfigs = findFiles(repo.localPath, /application.*\.(yml|yaml|properties)$/, 3);
  for (const sc of springConfigs) {
    const content = readFile(sc);
    if (content.includes('kafka.bootstrap') || content.includes('spring.kafka')) {
      signals.has_kafka = true;
    }
    if (content.includes('rabbitmq') || content.includes('spring.rabbitmq')) {
      signals.has_mq = true;
    }
  }

  // Java/Kotlin: 提取 @KafkaListener topic（consumer）和 KafkaTemplate（producer）
  if (repo.lang === 'Java' || repo.lang === 'Kotlin') {
    const kafkaFiles = safeGrep('@KafkaListener|KafkaTemplate', repo.localPath, '*.java', 50);
    for (const f of kafkaFiles) {
      const content = readFile(f);
      signals.has_kafka = true;
      const relPath = path.relative(repo.localPath, f);

      // @KafkaListener(topics = "xxx") or topics = {"a", "b"}
      const listenerPattern = /@KafkaListener\s*\([^)]*topics?\s*=\s*(?:\{([^}]+)\}|"([^"]+)")/g;
      let m: RegExpExecArray | null;
      while ((m = listenerPattern.exec(content)) !== null) {
        const raw = m[1] || m[2];
        const topics = raw.split(',').map(t => t.trim().replace(/^"|"$/g, '')).filter(Boolean);
        for (const topic of topics) {
          if (topic.startsWith('${')) continue;
          deps.push({
            type: 'kafka_consumer',
            topic,
            source: relPath,
            confidence: 0.8,
          });
        }
      }

      // KafkaTemplate.send("topic", ...) 或 kafkaTemplate.send("topic", ...)
      if (content.includes('KafkaTemplate') || content.includes('kafkaTemplate')) {
        const sendPattern = /(?:kafka|kafkaTemplate)\w*\.send\s*\(\s*"([^"]+)"/gi;
        while ((m = sendPattern.exec(content)) !== null) {
          if (m[1].startsWith('${')) continue;
          deps.push({
            type: 'kafka_producer',
            topic: m[1],
            source: relPath,
            confidence: 0.8,
          });
        }
      }
    }
  }

  // 非 Java 项目的 MQ 信号检测
  if (repo.lang !== 'Java' && repo.lang !== 'Kotlin') {
    const sourceFiles = findFiles(repo.localPath, /\.(py|go|ts|js)$/, 3);
    for (const f of sourceFiles.slice(0, 100)) {
      const content = readFile(f);
      if (/kafka|KafkaConsumer|KafkaProducer|confluent_kafka/i.test(content)) {
        signals.has_kafka = true;
        break;
      }
      if (mqPatterns.some(p => p.test(content))) {
        signals.has_mq = true;
        break;
      }
    }
  }
}

// ─── 基础设施检测（MySQL / Redis / 端口）──────────────────

function detectInfraDeps(repo: ScannedRepo, _deps: DetectedDep[], signals: RepoSignals): void {
  const configFiles = findFiles(repo.localPath, /\.(yml|yaml|properties|json|ini|toml|env)$/, 2);
  for (const cf of configFiles.slice(0, 30)) {
    const content = readFile(cf);
    if (/mysql|jdbc:mysql|mariadb/i.test(content)) {
      signals['uses_mysql'] = true;
    }
    if (/redis|redisson|jedis|ioredis/i.test(content)) {
      signals['uses_redis'] = true;
    }
    if (/elasticsearch|opensearch/i.test(content)) {
      signals['uses_elasticsearch'] = true;
    }
    if (/mongodb|mongo/i.test(content)) {
      signals['uses_mongodb'] = true;
    }
  }
}

// ─── PHP 源码内部 HTTP 调用检测 ────────────────────────────

function detectPhpInnerHttpDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  if (repo.lang !== 'PHP') return;

  // 检测 inner controller 路径调用
  // 有 controllers/inner/<子目录> 的项目是 inner 接口提供者，标记信号但跳过调用方检测
  let isRealProvider = false;
  for (const base of ['application/controllers/inner', 'app/controllers/inner']) {
    const innerDir = path.join(repo.localPath, base);
    if (!fileExists(innerDir)) continue;
    try {
      const entries = fs.readdirSync(innerDir, { withFileTypes: true });
      if (entries.some(e => e.isDirectory())) {
        isRealProvider = true;
        signals.has_inner_controllers = true;
        break;
      }
    } catch { /* ignore */ }
  }

  if (!isRealProvider) {
    const innerFiles = safeGrep('/(inner|goback)/', repo.localPath, '*.php', 100);
    const innerPattern = /['"]?\/(inner|goback)\/([a-zA-Z0-9/_-]+)/g;
    for (const f of innerFiles) {
      const content = readFile(f);
      let m: RegExpExecArray | null;
      innerPattern.lastIndex = 0;
      while ((m = innerPattern.exec(content)) !== null) {
        signals.has_inner_http_calls = true;
        deps.push({
          type: m[1] === 'goback' ? 'http_callback' : 'inner_http',
          servicePath: m[2],
          source: path.relative(repo.localPath, f),
          confidence: 0.7,
        });
      }
    }
  }
}

// ─── Goback/Callback 异步回调检测 ──────────────────────────

function detectGobackCallbackDeps(repo: ScannedRepo, deps: DetectedDep[], signals: RepoSignals): void {
  // PHP goback/callback URL 检测
  if (repo.lang === 'PHP') {
    const gobackFiles = safeGrep('goback|callback.*url|notify.*url', repo.localPath, '*.php', 100);
    for (const f of gobackFiles) {
      const content = readFile(f);
      const urlPattern = /https?:\/\/[a-zA-Z0-9._:/-]+/g;
      let m: RegExpExecArray | null;
      while ((m = urlPattern.exec(content)) !== null) {
        try {
          const rawUrl = m[0].replace(/['")\]}>]+$/, '');
          const url = new URL(rawUrl);
          if (isLikelyInternalUrl(url.hostname)) {
            signals.has_goback_callback = true;
            deps.push({
              type: 'http_callback',
              domain: url.hostname,
              source: path.relative(repo.localPath, f),
              confidence: 0.6,
            });
          }
        } catch { /* 非法 URL */ }
      }
    }

    // Redis pub/sub 检测
    const redisMqFiles = safeGrep('publish|subscribe|lpush|rpush|blpop|brpop', repo.localPath, '*.php', 100);
    for (const f of redisMqFiles) {
      const content = readFile(f);
      const topicPattern = /(?:publish|subscribe|lpush|rpush|blpop|brpop)\s*\(\s*['"]([^'"]+)['"]/gi;
      let m: RegExpExecArray | null;
      while ((m = topicPattern.exec(content)) !== null) {
        signals.has_redis_mq = true;
        deps.push({
          type: 'redis_mq',
          topic: m[1],
          source: path.relative(repo.localPath, f),
          confidence: 0.6,
        });
      }
    }
  }

  // Java Redis pub/sub 检测
  if (repo.lang === 'Java' || repo.lang === 'Kotlin') {
    const redisMqFiles = safeGrep('convertAndSend|RedisTemplate.*opsForList', repo.localPath, '*.java', 50);
    for (const f of redisMqFiles) {
      const content = readFile(f);
      signals.has_redis_mq = true;
      const topicPattern = /convertAndSend\s*\(\s*['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = topicPattern.exec(content)) !== null) {
        deps.push({
          type: 'redis_mq',
          topic: m[1],
          source: path.relative(repo.localPath, f),
          confidence: 0.6,
        });
      }
    }
  }
}
