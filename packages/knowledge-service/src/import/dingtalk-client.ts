// Created by dev on 2026/05/25
import { getLogger } from '@memforgeai/shared';

const logger = getLogger('knowledge:dingtalk-client');

const API_BASE = 'https://api.dingtalk.com';

export interface DingTalkConfig {
  appKey: string;
  appSecret: string;
  operatorId: string;
}

export interface DingTalkNode {
  nodeId: string;
  name: string;
  type: 'FILE' | 'FOLDER';
  hasChildren: boolean;
  url?: string;
  /** ALIDOC=钉钉文档, DOCUMENT=上传文件, IMAGE, VIDEO, AUDIO, ARCHIVE, OTHER */
  category?: string;
  extension?: string;
  docType?: string;
  createdTime?: number;
  modifiedTime?: number;
}

export interface DingTalkBlock {
  id: string;
  blockType: string;
  index?: number;
  text?: string;
  /** 实际内容在 block[blockType] 子对象中，如 paragraph.text, heading.text */
  [key: string]: unknown;
}

export class DingTalkClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private readonly config: DingTalkConfig;
  private lastRequestAt = 0;
  private readonly minIntervalMs: number;

  constructor(config: DingTalkConfig, ratePerSecond = 15) {
    this.config = config;
    this.minIntervalMs = Math.ceil(1000 / ratePerSecond);
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise(resolve => setTimeout(resolve, this.minIntervalMs - elapsed));
    }
    this.lastRequestAt = Date.now();
  }

  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    const resp = await fetch(`${API_BASE}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appKey: this.config.appKey,
        appSecret: this.config.appSecret,
      }),
    });
    const data = await resp.json() as { accessToken?: string; expireIn?: number; code?: string; message?: string };
    if (!data.accessToken) {
      throw new Error(`DingTalk auth failed: ${data.code} - ${data.message}`);
    }
    this.accessToken = data.accessToken;
    // 提前 5 分钟过期，避免边界请求失败
    this.tokenExpiresAt = Date.now() + ((data.expireIn ?? 7200) - 300) * 1000;
    return this.accessToken;
  }

  private async request<T>(method: string, path: string, body?: unknown, version: string = 'v2.0'): Promise<T> {
    await this.throttle();
    const token = await this.getToken();
    const url = `${API_BASE}/${version}/${path}`;
    const opts: RequestInit = {
      method,
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const resp = await fetch(url, opts);
    const data = await resp.json() as T & { code?: string; message?: string };
    if ((data as { code?: string }).code && !resp.ok) {
      throw new Error(`DingTalk API [${path}]: ${(data as { code: string }).code} - ${(data as { message?: string }).message}`);
    }
    return data;
  }

  async listNodes(parentNodeId: string, nextToken?: string): Promise<{ nodes: DingTalkNode[]; nextToken?: string }> {
    const params = new URLSearchParams({
      operatorId: this.config.operatorId,
      maxResults: '50',
    });
    if (nextToken) params.set('nextToken', nextToken);

    return this.request<{ nodes: DingTalkNode[]; nextToken?: string }>(
      'GET',
      `wiki/nodes?parentNodeId=${parentNodeId}&${params.toString()}`,
    );
  }

  async listAllNodes(parentNodeId: string): Promise<DingTalkNode[]> {
    const allNodes: DingTalkNode[] = [];
    let nextToken: string | undefined;

    do {
      const page = await this.listNodes(parentNodeId, nextToken);
      allNodes.push(...(page.nodes ?? []));
      nextToken = page.nextToken;
    } while (nextToken);

    return allNodes;
  }

  async getDocumentBlocks(docId: string): Promise<DingTalkBlock[]> {
    try {
      const data = await this.request<{ success?: boolean; result?: { data?: DingTalkBlock[] } }>(
        'GET',
        `doc/suites/documents/${docId}/blocks?operatorId=${this.config.operatorId}`,
        undefined,
        'v1.0',
      );
      return data.result?.data ?? [];
    } catch (err) {
      logger.warn({ docId, err: String(err) }, 'Failed to fetch document blocks');
      return [];
    }
  }

  async walkTree(rootNodeId: string, maxDepth = 5): Promise<Array<{ node: DingTalkNode; path: string[]; depth: number }>> {
    const results: Array<{ node: DingTalkNode; path: string[]; depth: number }> = [];

    const walk = async (nodeId: string, currentPath: string[], depth: number): Promise<void> => {
      if (depth > maxDepth) return;

      const children = await this.listAllNodes(nodeId);
      for (const child of children) {
        const childPath = [...currentPath, child.name];
        results.push({ node: child, path: childPath, depth });

        if (child.type === 'FOLDER' && child.hasChildren) {
          await walk(child.nodeId, childPath, depth + 1);
        }
      }
    };

    await walk(rootNodeId, [], 0);
    logger.info({ rootNodeId, totalNodes: results.length }, 'DingTalk tree walk completed');
    return results;
  }
}
