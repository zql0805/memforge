// Created by dev on 2026/06/11
// Copyright © 2026
// WebSocket 客户端 — Gateway 注册 + 远程扫描 RPC

import {
  GATEWAY_URL, API_KEY, DEVICE_ID,
  HEARTBEAT_INTERVAL_MS, RECONNECT_BASE_MS, RECONNECT_MAX_MS,
  getMachineInfo, log,
} from './config.js';
import { execScanTopology } from './scan-handler.js';

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let closed = false;

export function wsSend(msg: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function handleWsMessage(msg: Record<string, any>): void {
  switch (msg.type) {
    case 'auth_ok':
      log(`Gateway 认证成功 (userId=${msg.userId})`);
      startHeartbeat();
      break;

    case 'heartbeat_ack':
      break;

    case 'error':
      log(`Gateway 错误: ${msg.message}`);
      break;

    case 'scan_topology':
      execScanTopology(msg.params ?? {}, msg.taskId, wsSend).then(data => {
        wsSend({ type: 'scan_result', taskId: msg.taskId, success: true, data });
      }).catch(err => {
        wsSend({ type: 'scan_result', taskId: msg.taskId, success: false, error: err.message });
      });
      break;

    case 'exec_local_tool':
      handleLocalTool(msg).catch(err => {
        log(`本地工具失败: ${err.message}`);
      });
      break;

    default:
      break;
  }
}

async function handleLocalTool(msg: Record<string, any>): Promise<void> {
  const { requestId, tool, args } = msg;
  try {
    if (tool === 'scan_topology') {
      const result = await execScanTopology(args ?? {}, requestId, wsSend);
      wsSend({ type: 'tool_result', requestId, result });
    } else {
      wsSend({ type: 'tool_error', requestId, error: `本地工具 ${tool} 暂不支持远程执行` });
    }
  } catch (err: any) {
    wsSend({ type: 'tool_error', requestId, error: err.message });
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => wsSend({ type: 'heartbeat' }), HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect(): void {
  if (closed) return;
  reconnectAttempts++;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX_MS);
  log(`${delay / 1000}s 后重连 (第 ${reconnectAttempts} 次)`);
  setTimeout(connectGateway, delay);
}

export function connectGateway(): void {
  if (closed) return;

  const wsUrl = GATEWAY_URL
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:')
    .replace(/\/$/, '') + '/ws/mcp-client';

  try {
    ws = new WebSocket(wsUrl);
  } catch (err: any) {
    log(`WebSocket 创建失败: ${err.message}`);
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    reconnectAttempts = 0;
    log('WebSocket 已连接，发送认证');
    wsSend({ type: 'auth', token: API_KEY, machineInfo: getMachineInfo() });
  });

  ws.addEventListener('message', (event) => {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
    } catch { return; }
    handleWsMessage(msg);
  });

  ws.addEventListener('close', (event) => {
    log(`WebSocket 关闭 (code=${event.code})`);
    stopHeartbeat();
    if (!closed) scheduleReconnect();
  });

  ws.addEventListener('error', () => {});
}

export function closeGateway(): void {
  closed = true;
  stopHeartbeat();
  ws?.close();
}
