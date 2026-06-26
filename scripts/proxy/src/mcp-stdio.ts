// Created by dev on 2026/06/11
// Copyright © 2026
// MCP STDIO 协议转发（scan_topology 本地拦截，避免 Gateway 死锁）

import { createInterface } from 'readline';
import { GATEWAY_URL, API_KEY, DEVICE_ID, log } from './config.js';
import { execScanTopology } from './scan-handler.js';

function safeParseId(line: string): string | number | null {
  try {
    return JSON.parse(line).id ?? null;
  } catch {
    return null;
  }
}

/** 检测是否为 scan_topology 的 tools/call 请求 */
function extractLocalToolCall(line: string): { id: string | number | null; args: Record<string, any> } | null {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'tools/call' && msg.params?.name === 'scan_topology') {
      return { id: msg.id ?? null, args: msg.params.arguments ?? {} };
    }
  } catch {}
  return null;
}

function wsSendNoop(): void {}

export function startStdioForwarding(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', async (line) => {
    if (!line.trim()) return;

    // scan_topology 本地拦截：直接在进程内执行，不走 Gateway 转发
    const localCall = extractLocalToolCall(line);
    if (localCall) {
      log('[STDIO] scan_topology 本地拦截执行');
      const t0 = Date.now();
      try {
        const result = await execScanTopology(localCall.args, null, wsSendNoop);
        log(`[STDIO] scan_topology 完成: ${Date.now() - t0}ms`);
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          },
          id: localCall.id,
        }) + '\n');
      } catch (err: any) {
        log(`[STDIO] scan_topology 失败: ${err.message}`);
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          result: {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }],
            isError: true,
          },
          id: localCall.id,
        }) + '\n');
      }
      return;
    }

    try {
      const response = await fetch(`${GATEWAY_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': `Bearer ${API_KEY}`,
          'X-Device-Id': DEVICE_ID,
        },
        body: line,
      });

      const text = await response.text();

      for (const part of text.split('\n')) {
        if (part.startsWith('data: ')) {
          process.stdout.write(part.slice(6) + '\n');
        }
      }
    } catch (err: any) {
      const parsed = safeParseId(line);
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: `远程代理错误: ${err.message}` },
        id: parsed,
      }) + '\n');
    }
  });
}
