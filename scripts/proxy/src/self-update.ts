// Created by dev on 2026/06/11
// Copyright © 2026
// Proxy 自动更新

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { GATEWAY_URL, SELF_PATH, log } from './config.js';
import { inlineSyncHooksAfterUpdate } from './rules-sync.js';

export async function selfUpdate(): Promise<void> {
  if (process.env.MEMFORGE_SKIP_UPDATE === 'true') return;
  try {
    const currentContent = existsSync(SELF_PATH) ? readFileSync(SELF_PATH, 'utf-8') : '';
    const localVersion = currentContent.match(/\/\/ @version (.+)/)?.[1]?.trim();

    const resp = await fetch(`${GATEWAY_URL.replace(/\/$/, '')}/api/setup/proxy-script`, {
      headers: localVersion ? { 'If-None-Match': localVersion } : {},
    });
    if (resp.status === 304 || !resp.ok) return;

    const remote = await resp.text();
    const remoteVersion = remote.match(/\/\/ @version (.+)/)?.[1]?.trim();
    if (!remoteVersion) return;
    if (localVersion && remoteVersion === localVersion) return;

    writeFileSync(SELF_PATH, remote, 'utf-8');
    log(`已自动更新: ${localVersion ?? '(无版本号)'} → ${remoteVersion}（下次启动生效）`);

    await inlineSyncHooksAfterUpdate();
  } catch (err: any) {
    log(`自动更新检查失败: ${err.message}`);
  }
}
