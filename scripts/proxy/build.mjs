#!/usr/bin/env node
// Memforge Proxy 打包脚本
// 将 TypeScript 源码 + scanner.ts 依赖打包为自包含单文件 .mjs

import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));

const version = '3.0.0';

const result = await build({
  entryPoints: [join(__dirname, 'src/main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: join(__dirname, '../mcp-remote-proxy.mjs'),
  banner: {
    js: [
      '#!/usr/bin/env node',
      `// Memforge MCP Remote Proxy — bundled from TypeScript`,
      `// @version ${version}`,
      '',
      `import { createRequire as __bundled_createRequire } from 'module';`,
      `import { fileURLToPath as __bundled_fileURLToPath } from 'url';`,
      `import { dirname as __bundled_dirname } from 'path';`,
      `const require = __bundled_createRequire(import.meta.url);`,
      `const __filename = __bundled_fileURLToPath(import.meta.url);`,
      `const __dirname = __bundled_dirname(__filename);`,
      '',
    ].join('\n'),
  },
  external: [],
  alias: {
    'pino': join(__dirname, 'src/pino-shim.ts'),
  },
  // 将 import.meta.url 替换为运行时值（esbuild 默认支持）
  define: {},
  // 启用 tree-shaking，排除未使用的流量查询等模块
  treeShaking: true,
  // sourcemap 便于调试（可选）
  sourcemap: false,
  // 不压缩，保持可读性（Gateway 分发时可额外压缩）
  minify: false,
  logLevel: 'info',
});

console.log(`✓ 打包完成: scripts/mcp-remote-proxy.mjs`);
