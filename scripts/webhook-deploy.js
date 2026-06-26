#!/usr/bin/env node
// Created by dev on 2026/05/09
// GitLab Webhook 自动部署服务
// 接收 GitLab push 事件 → git pull → 编译 → PM2 重启

const http = require('http');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.WEBHOOK_PORT || '9876', 10);
const SECRET = process.env.WEBHOOK_SECRET || '';
const DEPLOY_DIR = process.env.MEMFORGE_DEPLOY_DIR || '/opt/memforge';
const DEPLOY_BRANCH = process.env.MEMFORGE_GIT_BRANCH || 'master';
const LOG_DIR = path.join(DEPLOY_DIR, '.logs');

if (!SECRET) {
  console.warn('[webhook] WEBHOOK_SECRET 未设置，webhook 将以只读模式运行（拒绝所有 deploy 请求）');
  console.warn('[webhook] 配置 WEBHOOK_SECRET 环境变量后执行 pm2 restart webhook-deploy --update-env');
}

const NO_SECRET_MODE = !SECRET;

let deploying = false;
let lastDeployTime = null;
let lastDeployCommit = null;

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'webhook-deploy.log'), line + '\n');
  } catch (_) {}
}

function runStep(label, cmd, opts = {}) {
  log(`  → ${label}`);
  try {
    const output = execSync(cmd, {
      cwd: DEPLOY_DIR,
      timeout: opts.timeout || 120_000,
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/usr/local/lib/node_modules/pm2/bin` },
    });
    if (output.trim()) log(`    ${output.trim().split('\n').join('\n    ')}`);
    return { ok: true, output: output.trim() };
  } catch (err) {
    log(`  ✗ ${label} 失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

function detectChangedPackages(diffOutput) {
  const pkgs = new Set();
  const lines = diffOutput.split('\n');
  for (const line of lines) {
    if (line.includes('packages/shared/')) pkgs.add('shared');
    if (line.includes('packages/memory-service/')) pkgs.add('memory-service');
    if (line.includes('packages/gateway/')) pkgs.add('gateway');
    if (line.includes('packages/rules-engine/')) pkgs.add('rules-engine');
    if (line.includes('packages/knowledge-service/')) pkgs.add('knowledge-service');
    if (line.includes('packages/web-ui/')) pkgs.add('web-ui');
    if (line.includes('package.json') || line.includes('package-lock.json')) pkgs.add('_deps');
  }
  return pkgs;
}

async function deploy(pushInfo) {
  if (deploying) {
    log('⚠ 部署进行中，跳过本次触发');
    return { status: 'skipped', reason: 'deploy in progress' };
  }

  deploying = true;
  const startTime = Date.now();
  log(`═══ 开始自动部署 ═══`);
  log(`  触发: ${pushInfo.user || 'unknown'} push → ${pushInfo.ref || DEPLOY_BRANCH}`);
  log(`  提交: ${pushInfo.commitId || 'unknown'} ${pushInfo.commitMsg || ''}`);

  try {
    const pull = runStep('拉取代码', `git pull origin ${DEPLOY_BRANCH} 2>&1`);
    if (!pull.ok) return { status: 'failed', step: 'git pull', error: pull.error };

    if (pull.output.includes('Already up to date')) {
      log('  代码已是最新，跳过');
      return { status: 'skipped', reason: 'already up to date' };
    }

    const diff = runStep('检测变更', 'git diff HEAD~1 --name-only 2>/dev/null || echo ""');
    const changed = detectChangedPackages(diff.output);

    if (changed.has('_deps')) {
      const install = runStep('安装依赖', 'npm install --production=false 2>&1', { timeout: 180_000 });
      if (!install.ok) return { status: 'failed', step: 'npm install', error: install.error };
    }

    const tscTargets = ['shared', 'memory-service', 'gateway', 'rules-engine', 'knowledge-service']
      .filter(p => changed.size === 0 || changed.has('shared') || changed.has(p))
      .map(p => `packages/${p}`)
      .join(' ');

    if (tscTargets) {
      const build = runStep('TypeScript 编译', `npx tsc -b ${tscTargets} 2>&1`, { timeout: 120_000 });
      if (!build.ok) return { status: 'failed', step: 'tsc build', error: build.error };
    }

    if (changed.has('web-ui') || changed.size === 0) {
      runStep('前端构建', 'cd packages/web-ui && npx vite build 2>&1', { timeout: 120_000 });
    }

    const restartTargets = ['memory-service', 'gateway', 'rules-engine', 'knowledge-service']
      .filter(p => changed.size === 0 || changed.has('shared') || changed.has(p));

    if (restartTargets.length > 0) {
      for (const svc of restartTargets) {
        runStep(`重启 ${svc}`, `pm2 restart ${svc} --update-env 2>&1`);
      }
      runStep('保存 PM2 状态', 'pm2 save 2>&1');
    }

    await new Promise(r => setTimeout(r, 3000));

    for (const port of [3001, 3002, 3003, 3000]) {
      try {
        execSync(`curl -sf --connect-timeout 3 http://127.0.0.1:${port}/health`, { encoding: 'utf-8' });
        log(`  ✓ 端口 ${port} 健康`);
      } catch (_) {
        log(`  ✗ 端口 ${port} 不健康`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    lastDeployTime = new Date().toISOString();
    lastDeployCommit = pushInfo.commitId;
    log(`═══ 部署完成 (${elapsed}s) ═══`);
    return { status: 'success', elapsed, changed: [...changed] };
  } catch (err) {
    log(`═══ 部署异常: ${err.message} ═══`);
    return { status: 'error', error: err.message };
  } finally {
    deploying = false;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      deploying,
      lastDeployTime,
      lastDeployCommit,
      uptime: process.uptime(),
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook/deploy') {
    if (NO_SECRET_MODE) {
      log('⚠ WEBHOOK_SECRET 未配置，拒绝部署请求');
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'WEBHOOK_SECRET not configured' }));
      return;
    }
    const token = req.headers['x-gitlab-token'];
    if (token !== SECRET) {
      log(`⚠ 认证失败 (IP: ${req.socket.remoteAddress})`);
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let pushInfo = {};
      try {
        const payload = JSON.parse(body);
        const ref = payload.ref || '';
        const branch = ref.replace('refs/heads/', '');

        if (branch !== DEPLOY_BRANCH) {
          log(`跳过非目标分支: ${branch} (期望: ${DEPLOY_BRANCH})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'skipped', reason: `branch ${branch} != ${DEPLOY_BRANCH}` }));
          return;
        }

        const lastCommit = (payload.commits || []).slice(-1)[0] || {};
        pushInfo = {
          ref: branch,
          user: payload.user_name || payload.user_username,
          commitId: (payload.after || '').slice(0, 8),
          commitMsg: (lastCommit.message || '').split('\n')[0].slice(0, 80),
        };
      } catch (_) {
        pushInfo = { ref: DEPLOY_BRANCH, user: 'unknown', commitId: 'unknown' };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted', message: 'deploy triggered' }));

      const result = await deploy(pushInfo);
      log(`部署结果: ${JSON.stringify(result)}`);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  log(`Webhook 部署服务启动 — 端口 ${PORT}, 分支 ${DEPLOY_BRANCH}`);
  log(`健康检查: http://127.0.0.1:${PORT}/health`);
  log(`Webhook URL: http://<server>:${PORT}/webhook/deploy`);
});
