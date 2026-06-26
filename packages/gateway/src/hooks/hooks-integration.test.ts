import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

vi.mock('@memforgeai/shared', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getPool: () => ({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }),
  };
});

let server: Server;
let port: number;
const HOOK_TOKEN = 'mfh_' + 'a'.repeat(48);

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const path = url.pathname;

    const hookToken = req.headers['x-hook-token'] as string | undefined;
    if (!hookToken || hookToken.length < 32) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }

    if (path === '/api/hooks/commit' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { handleCommitHook } = await import('./commit-handler.js');
      return handleCommitHook(body, sendJson, res, 'http://localhost:3001');
    }

    if (path === '/api/hooks/batch' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { handleBatchHook } = await import('./batch-handler.js');
      return handleBatchHook(body, sendJson, res);
    }

    sendJson(res, 404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      port = typeof addr === 'object' ? addr!.port : 0;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

describe('Git Hook HTTP 端点集成测试', () => {
  describe('POST /api/hooks/commit', () => {
    it('缺少 X-Hook-Token 返回 401', async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/api/hooks/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commit: 'abc', message: 'test', repo: 'test' }),
      });
      expect(resp.status).toBe(401);
    });

    it('Token 过短返回 401', async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/api/hooks/commit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hook-Token': 'short',
        },
        body: JSON.stringify({ commit: 'abc', message: 'test', repo: 'test' }),
      });
      expect(resp.status).toBe(401);
    });

    it('缺少必填字段返回 400', async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/api/hooks/commit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hook-Token': HOOK_TOKEN,
        },
        body: JSON.stringify({ commit: 'abc' }),
      });
      expect(resp.status).toBe(400);
    });

    it('有效 commit payload 返回 accepted', async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/api/hooks/commit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hook-Token': HOOK_TOKEN,
        },
        body: JSON.stringify({
          commit: 'abc123def456',
          message: 'feat: add new feature',
          branch: 'main',
          stats: '1 file changed',
          files: 'src/index.ts,src/utils.ts',
          repo: 'my-project',
          timestamp: Date.now(),
        }),
      });
      expect(resp.status).toBe(200);
      const data = await resp.json() as Record<string, unknown>;
      expect(data.status).toBe('accepted');
      expect(data.classification).toBe('feature');
      expect(data.needsReview).toBe(true);
      expect(data.hasCode).toBe(true);
    });

    it('merge commit 不触发 review', async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/api/hooks/commit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hook-Token': HOOK_TOKEN,
        },
        body: JSON.stringify({
          commit: 'merge123',
          message: "Merge branch 'dev' into main",
          branch: 'main',
          files: 'src/index.ts',
          repo: 'my-project',
          is_merge: true,
          timestamp: Date.now(),
        }),
      });
      expect(resp.status).toBe(200);
      const data = await resp.json() as Record<string, unknown>;
      expect(data.classification).toBe('merge');
      expect(data.needsReview).toBe(false);
    });

    it('docs commit 不触发 review 但检测到 hasDocs', async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/api/hooks/commit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hook-Token': HOOK_TOKEN,
        },
        body: JSON.stringify({
          commit: 'docs123',
          message: 'docs: update readme',
          branch: 'main',
          files: 'docs/README.md',
          repo: 'my-project',
          timestamp: Date.now(),
        }),
      });
      expect(resp.status).toBe(200);
      const data = await resp.json() as Record<string, unknown>;
      expect(data.classification).toBe('docs');
      expect(data.needsReview).toBe(false);
      expect(data.hasDocs).toBe(true);
    });
  });

  describe('POST /api/hooks/batch', () => {
    it('缺少 repo_id 返回 400', async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/api/hooks/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hook-Token': HOOK_TOKEN,
        },
        body: JSON.stringify({ commits: [] }),
      });
      expect(resp.status).toBe(400);
    });
  });

  describe('路由', () => {
    it('未知 hook 路径返回 404', async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/api/hooks/unknown`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hook-Token': HOOK_TOKEN,
        },
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(404);
    });
  });
});
