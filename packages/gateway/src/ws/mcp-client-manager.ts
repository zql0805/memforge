// Created by dev on 2026/04/09
// MCP 客户端 WebSocket 管理器
// 管理通过 WebSocket 连接的 MCP stdio 客户端，支持反向调度（远程扫描等）

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { getLogger } from '@memforgeai/shared';

const logger = getLogger('mcp-client-mgr');

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const RECONNECT_COOLDOWN_MS = 5_000;
const RECONNECT_LOG_INTERVAL_MS = 60_000;

export interface ConnectedClient {
  userId: string;
  ws: WebSocket;
  connectedAt: Date;
  machineInfo: {
    hostname?: string;
    platform?: string;
    cwd?: string;
  };
  lastHeartbeat: Date;
  /** 进行中的远程扫描任务 */
  pendingScan: RemoteScanTask | null;
}

export interface RemoteScanTask {
  id: string;
  productLine: string;
  params: Record<string, unknown>;
  startedAt: Date;
  progress: ScanProgress;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

export interface ScanProgress {
  phase: string;
  detail?: string;
  percent?: number;
}

/** WebSocket 消息协议 */
export type WsMessage =
  | { type: 'auth'; token: string; machineInfo?: Record<string, string> }
  | { type: 'heartbeat' }
  | { type: 'scan_topology'; taskId: string; params: Record<string, unknown> }
  | { type: 'scan_progress'; taskId: string; progress: ScanProgress }
  | { type: 'scan_result'; taskId: string; success: boolean; data?: unknown; error?: string }
  | { type: 'exec_local_tool'; requestId: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; requestId: string; result: unknown }
  | { type: 'tool_error'; requestId: string; error: string }
  | { type: 'error'; message: string };

const REMOTE_SCAN_TIMEOUT_MS = 10 * 60 * 1000;

export class McpClientManager {
  private wss: WebSocketServer;
  private clients = new Map<string, ConnectedClient>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private authenticator: (token: string) => Promise<{ userId: string; role: string } | null>;
  /** WebUI 订阅扫描进度的回调 */
  private scanProgressListeners = new Map<string, Set<(progress: ScanProgress & { taskId: string }) => void>>();
  /** 通用本地工具待回调映射 */
  private pendingLocalTools = new Map<string, {
    userId: string;
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** 重连冷却：记录每个用户最后一次成功连接时间 */
  private lastConnectTime = new Map<string, number>();
  /** 重连日志降采样：记录每个用户被抑制的重连次数和上次日志时间 */
  private reconnectStats = new Map<string, { count: number; lastLogTime: number }>();

  constructor(
    authenticator: (token: string) => Promise<{ userId: string; role: string } | null>,
  ) {
    this.authenticator = authenticator;
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.startHeartbeatLoop();
  }

  /** 处理 HTTP Upgrade → WebSocket */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  private handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    let authenticated = false;
    let userId: string | null = null;

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        ws.close(4001, '认证超时');
      }
    }, 10_000);

    ws.on('message', async (raw: Buffer) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString()) as WsMessage;
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: '无效的 JSON 消息' }));
        return;
      }

      if (msg.type === 'auth') {
        const payload = await this.authenticator(msg.token);
        if (!payload) {
          ws.send(JSON.stringify({ type: 'error', message: '认证失败' }));
          ws.close(4003, '认证失败');
          return;
        }
        authenticated = true;
        userId = payload.userId;
        clearTimeout(authTimeout);

        // 重连冷却：5 秒内重复连接直接拒绝
        const now = Date.now();
        const lastConnect = this.lastConnectTime.get(userId) ?? 0;
        if (now - lastConnect < RECONNECT_COOLDOWN_MS) {
          ws.send(JSON.stringify({ type: 'error', message: '连接过于频繁，请稍后重试', retryAfterMs: RECONNECT_COOLDOWN_MS }));
          ws.close(4029, '连接过于频繁');
          this.trackReconnectThrottle(userId);
          return;
        }
        this.lastConnectTime.set(userId, now);

        const existing = this.clients.get(userId);
        if (existing) {
          this.logReconnect(userId);
          existing.ws.close(4000, '新连接已建立');
        }

        this.clients.set(userId, {
          userId,
          ws,
          connectedAt: new Date(),
          machineInfo: msg.machineInfo ?? {},
          lastHeartbeat: new Date(),
          pendingScan: null,
        });

        ws.send(JSON.stringify({ type: 'auth_ok', userId }));
        logger.info({ userId, machineInfo: msg.machineInfo }, 'MCP 客户端已连接');
        return;
      }

      if (!authenticated || !userId) {
        ws.send(JSON.stringify({ type: 'error', message: '未认证' }));
        return;
      }

      const client = this.clients.get(userId);
      if (!client) return;

      if (msg.type === 'heartbeat') {
        client.lastHeartbeat = new Date();
        ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
        return;
      }

      if (msg.type === 'scan_progress') {
        if (client.pendingScan && client.pendingScan.id === msg.taskId) {
          client.pendingScan.progress = msg.progress;
          this.notifyScanProgress(userId, msg.taskId, msg.progress);
        }
        return;
      }

      if (msg.type === 'scan_result') {
        if (client.pendingScan && client.pendingScan.id === msg.taskId) {
          clearTimeout(client.pendingScan.timeoutTimer);
          if (msg.success) {
            client.pendingScan.resolve(msg.data);
          } else {
            client.pendingScan.reject(new Error(msg.error ?? '扫描失败'));
          }
          client.pendingScan = null;
        }
        return;
      }

      // 通用本地工具回调
      if (msg.type === 'tool_result') {
        const pending = this.pendingLocalTools.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingLocalTools.delete(msg.requestId);
          pending.resolve(msg.result);
        }
        return;
      }

      if (msg.type === 'tool_error') {
        const pending = this.pendingLocalTools.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingLocalTools.delete(msg.requestId);
          pending.reject(new Error(msg.error));
        }
        return;
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (userId) {
        const client = this.clients.get(userId);
        if (client?.ws === ws) {
          if (client.pendingScan) {
            clearTimeout(client.pendingScan.timeoutTimer);
            client.pendingScan.reject(new Error('MCP 客户端断开连接'));
          }
          this.clients.delete(userId);
          logger.info({ userId }, 'MCP 客户端已断开');
        }
        // 断连时 reject 该用户所有 pending 本地工具调用
        for (const [requestId, pending] of this.pendingLocalTools) {
          if (pending.userId === userId) {
            clearTimeout(pending.timer);
            pending.reject(new Error('MCP 客户端断开连接'));
            this.pendingLocalTools.delete(requestId);
          }
        }
      }
    });

    ws.on('error', (err) => {
      logger.warn({ userId, err: err.message }, 'MCP 客户端 WebSocket 错误');
    });
  }

  /** 获取在线 MCP 客户端列表 */
  getOnlineClients(): Array<{
    userId: string;
    connectedAt: string;
    machineInfo: Record<string, string | undefined>;
    scanning: boolean;
    scanProgress: ScanProgress | null;
  }> {
    return [...this.clients.values()].map(c => ({
      userId: c.userId,
      connectedAt: c.connectedAt.toISOString(),
      machineInfo: c.machineInfo,
      scanning: c.pendingScan !== null,
      scanProgress: c.pendingScan?.progress ?? null,
    }));
  }

  /** 检查指定用户的 MCP 客户端是否在线 */
  isClientOnline(userId: string): boolean {
    const client = this.clients.get(userId);
    return !!client && client.ws.readyState === WebSocket.OPEN;
  }

  /**
   * 通用本地工具执行：通过 WebSocket 向 Local Agent 下发工具调用请求。
   * Gateway MCP Server 为本地工具（scan_topology、index_documents 等）使用。
   */
  async execLocalTool(userId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const client = this.clients.get(userId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`用户 ${userId} 的 Local Agent 未在线`);
    }

    const requestId = `lt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const TIMEOUT_MS = 120_000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingLocalTools.delete(requestId);
        reject(new Error(`本地工具 ${tool} 执行超时 (${TIMEOUT_MS / 1000}s)`));
      }, TIMEOUT_MS);

      this.pendingLocalTools.set(requestId, { userId, resolve, reject, timer });
      client.ws.send(JSON.stringify({ type: 'exec_local_tool', requestId, tool, args }));
    });
  }

  /** 向用户的 MCP 客户端下发远程扫描指令 */
  async triggerRemoteScan(
    userId: string,
    productLine: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const client = this.clients.get(userId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      throw new Error('MCP 客户端未连接');
    }
    if (client.pendingScan) {
      throw new Error('该客户端已有扫描任务进行中');
    }

    const taskId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        client.pendingScan = null;
        reject(new Error('远程扫描超时'));
      }, REMOTE_SCAN_TIMEOUT_MS);

      client.pendingScan = {
        id: taskId,
        productLine,
        params,
        startedAt: new Date(),
        progress: { phase: 'pending' },
        resolve,
        reject,
        timeoutTimer,
      };

      client.ws.send(JSON.stringify({
        type: 'scan_topology',
        taskId,
        params: { product_line: productLine, ...params },
      } satisfies WsMessage));
    });
  }

  /** 订阅扫描进度通知 */
  subscribeScanProgress(userId: string, callback: (progress: ScanProgress & { taskId: string }) => void): () => void {
    if (!this.scanProgressListeners.has(userId)) {
      this.scanProgressListeners.set(userId, new Set());
    }
    this.scanProgressListeners.get(userId)!.add(callback);
    return () => {
      this.scanProgressListeners.get(userId)?.delete(callback);
    };
  }

  private notifyScanProgress(userId: string, taskId: string, progress: ScanProgress): void {
    const listeners = this.scanProgressListeners.get(userId);
    if (listeners) {
      for (const cb of listeners) {
        try { cb({ taskId, ...progress }); } catch { /* 忽略回调异常 */ }
      }
    }
  }

  private startHeartbeatLoop(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [userId, client] of this.clients) {
        // 服务端主动 ping，防止 Nginx 因 idle 超时断开连接
        if (client.ws.readyState === 1) {
          client.ws.ping();
        }
        if (now - client.lastHeartbeat.getTime() > HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS) {
          logger.warn({ userId }, 'MCP 客户端心跳超时，断开连接');
          client.ws.close(4002, '心跳超时');
          this.clients.delete(userId);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** 重连日志降采样：每 60 秒最多输出 1 条日志 */
  private logReconnect(userId: string): void {
    const now = Date.now();
    const stats = this.reconnectStats.get(userId) ?? { count: 0, lastLogTime: 0 };
    stats.count++;

    if (now - stats.lastLogTime >= RECONNECT_LOG_INTERVAL_MS) {
      logger.info(
        { userId, suppressedCount: stats.count },
        `MCP 客户端重连，关闭旧连接（${stats.count > 1 ? `过去 ${Math.round((now - stats.lastLogTime) / 1000)}s 内重连 ${stats.count} 次` : '首次'}）`,
      );
      stats.count = 0;
      stats.lastLogTime = now;
    }
    this.reconnectStats.set(userId, stats);
  }

  /** 记录被冷却拒绝的连接（不输出日志，仅追踪指标） */
  private trackReconnectThrottle(userId: string): void {
    const stats = this.reconnectStats.get(userId) ?? { count: 0, lastLogTime: 0 };
    stats.count++;

    const now = Date.now();
    if (now - stats.lastLogTime >= RECONNECT_LOG_INTERVAL_MS) {
      logger.warn(
        { userId, throttledCount: stats.count },
        `MCP 客户端重连过于频繁，已拒绝 ${stats.count} 次`,
      );
      stats.count = 0;
      stats.lastLogTime = now;
    }
    this.reconnectStats.set(userId, stats);
  }

  shutdown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    for (const client of this.clients.values()) {
      client.ws.close(1001, '服务器关闭');
    }
    this.clients.clear();
    this.lastConnectTime.clear();
    this.reconnectStats.clear();
    this.wss.close();
  }
}
