// Created by dev on 2026/04/09
// MCP stdio 进程的 Gateway WebSocket 客户端
// 在 stdio 模式下启动时连接 Gateway，接收远程扫描等指令

import WebSocket from 'ws';
import { hostname, platform } from 'node:os';
import { getLogger, validateScanPath } from '@memforgeai/shared';
import { scanTopology as runTopologyScan } from '../tools/topology/index.js';

const logger = getLogger('gateway-ws-client');

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 25_000;

interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export interface GatewayClientOptions {
  gatewayUrl: string;
  token: string;
  cwd?: string;
}

export class GatewayWsClient {
  private ws: WebSocket | null = null;
  private opts: GatewayClientOptions;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  connect(): void {
    if (this.closed) return;

    const wsUrl = this.opts.gatewayUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:')
      .replace(/\/$/, '') + '/ws/mcp-client';

    logger.info({ url: wsUrl }, '正在连接 Gateway WebSocket');

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'WebSocket 创建失败');
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      logger.info('WebSocket 已连接，发送认证');

      this.send({
        type: 'auth',
        token: this.opts.token,
        machineInfo: {
          hostname: hostname(),
          platform: platform(),
          cwd: this.opts.cwd ?? process.cwd(),
        },
      });

      this.startHeartbeat();
    });

    this.ws.on('message', (raw: Buffer) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString()) as WsMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    });

    this.ws.on('close', (code, reason) => {
      logger.info({ code, reason: reason.toString() }, 'WebSocket 连接关闭');
      this.stopHeartbeat();
      if (!this.closed) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      logger.warn({ err: err.message }, 'WebSocket 错误');
    });
  }

  private handleMessage(msg: WsMessage): void {
    switch (msg.type) {
      case 'auth_ok':
        logger.info({ userId: msg.userId }, 'Gateway 认证成功');
        break;

      case 'heartbeat_ack':
        break;

      case 'error':
        logger.error({ message: msg.message }, 'Gateway 返回错误');
        break;

      case 'scan_topology':
        this.handleScanCommand(msg).catch(err => {
          logger.error({ err: (err as Error).message }, '处理扫描指令失败');
        });
        break;

      default:
        logger.debug({ type: msg.type }, '收到未知消息类型');
    }
  }

  private async handleScanCommand(msg: WsMessage): Promise<void> {
    const taskId = msg.taskId as string;
    const params = msg.params as Record<string, unknown>;
    const productLine = params.product_line as string;

    if (!productLine) {
      this.send({
        type: 'scan_result',
        taskId,
        success: false,
        error: '缺少 product_line 参数',
      });
      return;
    }

    logger.info({ taskId, productLine }, '收到远程扫描指令');

    this.send({ type: 'scan_progress', taskId, progress: { phase: 'starting', detail: '正在初始化扫描引擎' } });

    try {
      let rawScanRoots = (params.scan_roots as string[]) ?? [];
      const gitPatterns = (params.git_patterns as string[]) ?? [];
      const force = params.force === true;

      if (rawScanRoots.length === 0) {
        const cwd = this.opts.cwd ?? process.cwd();
        logger.info({ cwd }, '未指定 scan_roots，使用当前工作目录');
        rawScanRoots = [cwd];
      }

      const scanRoots: string[] = [];
      for (const root of rawScanRoots) {
        try {
          scanRoots.push(validateScanPath(root));
        } catch (err) {
          this.send({
            type: 'scan_result',
            taskId,
            success: false,
            error: (err as Error).message,
          });
          return;
        }
      }

      this.send({ type: 'scan_progress', taskId, progress: { phase: 'scanning', detail: `扫描 ${scanRoots.length} 个根目录`, percent: 10 } });

      const result = await runTopologyScan({
        productLine,
        scanRoots,
        gitPatterns,
      });

      this.send({ type: 'scan_progress', taskId, progress: { phase: 'uploading', detail: `发现 ${result.repoCount} 个仓库，正在上传`, percent: 80 } });

      const importUrl = `${this.opts.gatewayUrl.replace(/\/$/, '')}/api/topology/${productLine}/import`;
      const importBody = { ...result.registry, force };
      const resp = await fetch(importUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.opts.token}`,
        },
        body: JSON.stringify(importBody),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`上传失败 (${resp.status}): ${errText}`);
      }

      const importResult = await resp.json() as Record<string, unknown>;

      this.send({ type: 'scan_progress', taskId, progress: { phase: 'done', detail: '扫描完成', percent: 100 } });

      this.send({
        type: 'scan_result',
        taskId,
        success: true,
        data: {
          productLine,
          repoCount: result.repoCount,
          edgeCount: result.edgeCount,
          filePath: result.filePath,
          importResult,
        },
      });

      logger.info({ taskId, productLine, repos: result.repoCount, edges: result.edgeCount }, '远程扫描完成并已上传');
    } catch (err) {
      logger.error({ taskId, err: (err as Error).message }, '远程扫描失败');
      this.send({
        type: 'scan_result',
        taskId,
        success: false,
        error: (err as Error).message,
      });
    }
  }

  private send(msg: WsMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;

    logger.info({ delay, attempt: this.reconnectAttempts }, '计划重连');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, '客户端关闭');
      this.ws = null;
    }
  }
}

/**
 * 如果配置了 Gateway URL 和 Token，启动 WebSocket 客户端。
 * 在 stdio 模式的 MCP 进程中调用。
 */
export function startGatewayWsClient(): GatewayWsClient | null {
  const gatewayUrl = process.env.MEMFORGE_GATEWAY_URL;
  const token = process.env.MEMFORGE_TOKEN;

  if (!gatewayUrl || !token) {
    logger.debug('未配置 MEMFORGE_GATEWAY_URL 或 MEMFORGE_TOKEN，跳过 Gateway WebSocket 连接');
    return null;
  }

  const client = new GatewayWsClient({
    gatewayUrl,
    token,
    cwd: process.cwd(),
  });

  client.connect();
  return client;
}
