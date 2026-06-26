// Memforge MCP Remote Proxy v3.0.0 — TypeScript 重构版
// 功能: STDIO 协议转发 + WebSocket 注册 + 本地扫描 + 自动更新

import { GATEWAY_URL, API_KEY, log } from './config.js';
import { selfUpdate } from './self-update.js';
import { syncIdeRules, syncIdeHooks, syncGitHooks, writeSharedConfig } from './rules-sync.js';
import { startStdioForwarding } from './mcp-stdio.js';
import { connectGateway, closeGateway } from './ws-client.js';

if (!GATEWAY_URL || !API_KEY) {
  process.stderr.write('错误: 需要设置 MEMFORGE_GATEWAY_URL 和 MEMFORGE_API_KEY 环境变量\n');
  process.exit(1);
}

startStdioForwarding();

async function main(): Promise<void> {
  await selfUpdate();
  writeSharedConfig();
  await Promise.all([syncIdeRules(), syncIdeHooks(), syncGitHooks()]);
  connectGateway();
}

main().catch(err => {
  log(`启动失败: ${err.message}`);
});

process.on('SIGTERM', closeGateway);
process.on('SIGINT', closeGateway);
