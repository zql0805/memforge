// Created by dev on 2026/06/02
// 确定性基础设施提取器 — SQL/Redis/Kafka/RPC/配置/路由（无需 LLM）

import { getLogger } from '@memforgeai/shared';
import type { InfraRef, SupportedLang, SymbolInfo } from './types.js';

const logger = getLogger('deep-index:infra');

/**
 * 从源码文本中提取基础设施引用。纯正则 + 启发式，不依赖 AST。
 */
export function extractInfraRefs(
  code: string,
  filePath: string,
  lang: SupportedLang,
): InfraRef[] {
  const refs: InfraRef[] = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    refs.push(
      ...extractSqlTables(line, filePath, lineNum),
      ...extractRedisRefs(line, filePath, lineNum, lang),
      ...extractKafkaTopics(line, filePath, lineNum, lang),
      ...extractRpcRefs(line, filePath, lineNum, lang),
      ...extractConfigRefs(line, filePath, lineNum, lang),
      ...extractRoutes(line, filePath, lineNum, lang),
    );
  }

  return dedup(refs);
}

// ─── SQL 表引用 ──────────────────────────────────────────────

const SQL_TABLE_PATTERNS = [
  /\bFROM\s+`?(\w+)`?/gi,
  /\bJOIN\s+`?(\w+)`?/gi,
  /\bINTO\s+`?(\w+)`?/gi,
  /\bUPDATE\s+`?(\w+)`?\s+SET/gi,
  /\bTRUNCATE\s+(?:TABLE\s+)?`?(\w+)`?/gi,
  /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?/gi,
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi,
  /\bALTER\s+TABLE\s+`?(\w+)`?/gi,
];

// 排除 SQL 关键字被误识别为表名
const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null',
  'set', 'values', 'as', 'on', 'into', 'table', 'index', 'key',
  'if', 'exists', 'true', 'false', 'dual', 'to', 'by', 'order', 'group',
  'having', 'limit', 'offset', 'union', 'all', 'distinct', 'count',
  'sum', 'avg', 'min', 'max', 'like', 'between', 'case', 'when', 'then',
  'else', 'end', 'inner', 'outer', 'left', 'right', 'cross', 'natural',
  'using', 'primary', 'foreign', 'unique', 'default', 'constraint',
  'check', 'references', 'cascade', 'restrict', 'action', 'no',
  // 高频误报词
  'redis', 'config', 'server', 'pool', 'connection', 'session', 'cache',
  'data', 'result', 'list', 'map', 'string', 'integer', 'long', 'value',
  'name', 'type', 'status', 'time', 'date', 'user', 'info',
]);

function extractSqlTables(line: string, filePath: string, lineNum: number): InfraRef[] {
  const refs: InfraRef[] = [];
  for (const pattern of SQL_TABLE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const table = match[1].toLowerCase();
      if (SQL_KEYWORDS.has(table)) continue;
      if (table.length < 2) continue;
      refs.push({ type: 'sql_table', value: table, filePath, line: lineNum });
    }
  }
  return refs;
}

// ─── Redis 引用 ──────────────────────────────────────────────

function extractRedisRefs(line: string, filePath: string, lineNum: number, lang: SupportedLang): InfraRef[] {
  const refs: InfraRef[] = [];

  // PHP: $this->ctx->getRedis('cluster_name')
  const phpRedis = line.match(/getRedis\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (phpRedis) {
    refs.push({ type: 'redis_cluster', value: phpRedis[1], filePath, line: lineNum });
  }

  // Java: momostore / jedis
  const javaStore = line.match(/@MomoStore\s*\(\s*["']([^"']+)["']/);
  if (javaStore) {
    refs.push({ type: 'redis_cluster', value: javaStore[1], filePath, line: lineNum });
  }

  const jedisPool = line.match(/getJedis(?:Pool)?\s*\(\s*["']([^"']+)["']/);
  if (jedisPool) {
    refs.push({ type: 'redis_cluster', value: jedisPool[1], filePath, line: lineNum });
  }

  // Redis key 模式（启发式：含 : 分隔符的字符串常量）
  const keyPatterns = [
    /(?:REDIS_KEY|redis_key|redisKey|cacheKey|CACHE_KEY)\s*=\s*["']([^"']{3,})["']/,
    /\.(?:get|set|del|hget|hset|incr|expire|sadd|srem|zadd)\s*\(\s*["']([^"']{3,}:[^"']{2,})["']/,
  ];
  for (const pat of keyPatterns) {
    const m = line.match(pat);
    if (m) {
      refs.push({ type: 'redis_key', value: m[1], filePath, line: lineNum });
    }
  }

  return refs;
}

// ─── Kafka Topic ─────────────────────────────────────────────

function extractKafkaTopics(line: string, filePath: string, lineNum: number, lang: SupportedLang): InfraRef[] {
  const refs: InfraRef[] = [];

  // Java: @KafkaListener(topics = "xxx")
  const kafkaListener = line.match(/@KafkaListener\s*\(.*?topics?\s*=\s*["']([^"']+)["']/);
  if (kafkaListener) {
    refs.push({ type: 'kafka_topic', value: kafkaListener[1], filePath, line: lineNum });
  }

  // Java: producer.send("topic", ...)
  const kafkaSend = line.match(/\.send\s*\(\s*["']([^"']+)["']/);
  if (kafkaSend && (filePath.includes('kafka') || filePath.includes('Kafka') || filePath.includes('producer') || filePath.includes('Producer'))) {
    refs.push({ type: 'kafka_topic', value: kafkaSend[1], filePath, line: lineNum });
  }

  // 通用：TOPIC 常量
  const topicConst = line.match(/(?:TOPIC|topic_name|topicName)\s*=\s*["']([^"']+)["']/i);
  if (topicConst) {
    refs.push({ type: 'kafka_topic', value: topicConst[1], filePath, line: lineNum });
  }

  return refs;
}

// ─── RPC 引用（MOA） ─────────────────────────────────────────

function extractRpcRefs(line: string, filePath: string, lineNum: number, lang: SupportedLang): InfraRef[] {
  const refs: InfraRef[] = [];

  // Java: @MoaConsumer(serviceUri = "xxx")
  const moaConsumer = line.match(/@MoaConsumer\s*\(.*?serviceUri\s*=\s*["']([^"']+)["']/);
  if (moaConsumer) {
    refs.push({ type: 'rpc_consumer', value: moaConsumer[1], filePath, line: lineNum, context: 'MOA' });
  }

  // Java: @MoaProvider(serviceUri = "xxx")
  const moaProvider = line.match(/@MoaProvider\s*\(.*?serviceUri\s*=\s*["']([^"']+)["']/);
  if (moaProvider) {
    refs.push({ type: 'rpc_provider', value: moaProvider[1], filePath, line: lineNum, context: 'MOA' });
  }

  // PHP: Moa_Service_* 接口
  const phpMoa = line.match(/class\s+\w+.*implements.*?(Moa_Service_\w+)/);
  if (phpMoa) {
    refs.push({ type: 'rpc_provider', value: phpMoa[1], filePath, line: lineNum, context: 'MOA' });
  }

  const phpMoaCall = line.match(/Moa_Service_(\w+)::(?:getInstance|create)\(\)/);
  if (phpMoaCall) {
    refs.push({ type: 'rpc_consumer', value: `Moa_Service_${phpMoaCall[1]}`, filePath, line: lineNum, context: 'MOA' });
  }

  return refs;
}

// ─── 配置引用 ────────────────────────────────────────────────

function extractConfigRefs(line: string, filePath: string, lineNum: number, lang: SupportedLang): InfraRef[] {
  const refs: InfraRef[] = [];

  // Java: @Value("${xxx}")
  const springValue = line.match(/@Value\s*\(\s*["']\$\{([^}]+)\}["']\s*\)/);
  if (springValue) {
    refs.push({ type: 'config_key', value: springValue[1], filePath, line: lineNum });
  }

  // PHP: cc_get / getConfig / getPanguConfig
  const phpConfig = line.match(/(?:cc_get|getConfig|getPanguConfig)\s*\(\s*['"]([^'"]+)['"]/);
  if (phpConfig) {
    refs.push({ type: 'config_key', value: phpConfig[1], filePath, line: lineNum });
  }

  // 通用: @ConfigurationProperties(prefix = "xxx")
  const configProps = line.match(/@ConfigurationProperties\s*\(.*?prefix\s*=\s*["']([^"']+)["']/);
  if (configProps) {
    refs.push({ type: 'config_key', value: configProps[1], filePath, line: lineNum });
  }

  return refs;
}

// ─── 路由定义 ────────────────────────────────────────────────

function extractRoutes(line: string, filePath: string, lineNum: number, lang: SupportedLang): InfraRef[] {
  const refs: InfraRef[] = [];

  // Java Spring: @RequestMapping, @GetMapping, @PostMapping ...
  const springMapping = line.match(/@(?:Request|Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
  if (springMapping) {
    const method = line.includes('@GetMapping') ? 'GET'
      : line.includes('@PostMapping') ? 'POST'
      : line.includes('@PutMapping') ? 'PUT'
      : line.includes('@DeleteMapping') ? 'DELETE'
      : 'ANY';
    refs.push({ type: 'route', value: springMapping[1], filePath, line: lineNum, context: method });
  }

  // PHP 路由表: Route::get('/path', ...) 或 $router->addRoute('GET', '/path', ...)
  const phpRoute = line.match(/(?:Route::(\w+)|addRoute\s*\(\s*['"](\w+)['"])\s*\(\s*['"]([^'"]+)['"]/);
  if (phpRoute) {
    const method = (phpRoute[1] ?? phpRoute[2]).toUpperCase();
    refs.push({ type: 'route', value: phpRoute[3], filePath, line: lineNum, context: method });
  }

  // TS: @Controller / app.get / router.get
  const tsRoute = line.match(/(?:app|router)\.(get|post|put|delete|patch|all)\s*\(\s*['"]([^'"]+)['"]/);
  if (tsRoute) {
    refs.push({ type: 'route', value: tsRoute[2], filePath, line: lineNum, context: tsRoute[1].toUpperCase() });
  }

  return refs;
}

// ─── 去重 ────────────────────────────────────────────────────

function dedup(refs: InfraRef[]): InfraRef[] {
  const seen = new Set<string>();
  return refs.filter(r => {
    const key = `${r.type}:${r.value}:${r.filePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Mapper XML 提取（Java MyBatis） ─────────────────────────

/**
 * 从 MyBatis mapper XML 中提取 SQL 表引用。
 */
export function extractFromMapperXml(content: string, filePath: string): InfraRef[] {
  const refs: InfraRef[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    refs.push(...extractSqlTables(line, filePath, i + 1));
  }

  return dedup(refs);
}

// ─── AST 级 Spring 路由提取（从已提取的 symbols 解析） ──────

const SPRING_METHOD_MAP: Record<string, string> = {
  GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT',
  DeleteMapping: 'DELETE', PatchMapping: 'PATCH', RequestMapping: 'ANY',
};

/**
 * 从 AST 已提取的 symbols 中解析 Spring 路由。
 * 比正则更准确：支持多行注解、value 数组、类级前缀继承。
 */
export function extractSpringRoutesFromAST(symbols: SymbolInfo[]): InfraRef[] {
  const refs: InfraRef[] = [];

  // 第一遍：收集类级 @RequestMapping 前缀
  const classPrefixes = new Map<string, string>();
  for (const sym of symbols) {
    if (sym.kind !== 'class' && sym.kind !== 'interface') continue;
    for (const ann of sym.annotations) {
      const prefix = parseSpringMappingPath(ann);
      if (prefix) {
        classPrefixes.set(sym.name, prefix);
      }
    }
  }

  // 第二遍：解析方法级 @XxxMapping
  for (const sym of symbols) {
    if (sym.kind !== 'method') continue;
    for (const ann of sym.annotations) {
      const mappingType = Object.keys(SPRING_METHOD_MAP).find(k => ann.includes(`@${k}`));
      if (!mappingType) continue;

      const path = parseSpringMappingPath(ann);
      if (!path) continue;

      const httpMethod = SPRING_METHOD_MAP[mappingType];
      const classPrefix = sym.parent ? (classPrefixes.get(sym.parent) ?? '') : '';
      const fullPath = normalizePath(`${classPrefix}/${path}`);

      refs.push({
        type: 'route',
        value: fullPath,
        filePath: sym.filePath,
        line: sym.startLine,
        context: `${httpMethod} ${fullPath}`,
      });
    }
  }

  return refs;
}

/** 从 Spring Mapping 注解文本中提取 path/value */
function parseSpringMappingPath(annotation: string): string | null {
  // @GetMapping("/users") 或 @GetMapping(value = "/users")
  const valueMatch = annotation.match(/(?:value\s*=\s*)?["']([^"']+)["']/);
  if (valueMatch) return valueMatch[1];

  // @GetMapping({"/a", "/b"}) — 取第一个
  const arrayMatch = annotation.match(/\{\s*["']([^"']+)["']/);
  if (arrayMatch) return arrayMatch[1];

  return null;
}

function normalizePath(p: string): string {
  return '/' + p.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

// ─── AST 级 Laravel 路由提取 ─────────────────────────────────

/**
 * 从 Laravel 路由文件中提取路由定义。
 * 支持 Route::get/post/...、Route::group + prefix/middleware、Route::resource。
 */
export function extractLaravelRoutesEnhanced(code: string, filePath: string): InfraRef[] {
  if (!filePath.includes('routes/') && !filePath.includes('Routes/')) return [];

  const refs: InfraRef[] = [];
  const lines = code.split('\n');

  // 追踪 Route::group 嵌套的 prefix 和 middleware
  const prefixStack: string[] = [];
  const middlewareStack: string[][] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Route::group(['prefix' => 'api/v1', 'middleware' => ['auth']], ...)
    const groupMatch = line.match(/Route::(?:group|middleware|prefix)\s*\(/);
    if (groupMatch) {
      const prefixMatch = line.match(/['"]prefix['"]\s*=>\s*['"]([^'"]+)['"]/);
      const mwMatch = line.match(/['"]middleware['"]\s*=>\s*\[([^\]]*)\]/);
      prefixStack.push(prefixMatch?.[1] ?? '');
      middlewareStack.push(
        mwMatch ? mwMatch[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean) : [],
      );
    }

    // 闭合 group 的 });
    if (line.match(/^\s*\}\s*\)\s*;/) && prefixStack.length > 0) {
      prefixStack.pop();
      middlewareStack.pop();
    }

    // Route::get('/path', [Controller::class, 'method']) 或 Route::get('/path', 'Controller@method')
    const routeMatch = line.match(/Route::(get|post|put|delete|patch|any|options)\s*\(\s*['"]([^'"]+)['"]/i);
    if (routeMatch) {
      const method = routeMatch[1].toUpperCase();
      const routePath = routeMatch[2];
      const fullPrefix = prefixStack.filter(Boolean).join('/');
      const fullPath = normalizePath(`${fullPrefix}/${routePath}`);
      const allMiddleware = middlewareStack.flat();

      // 提取 controller@action
      const controllerMatch = line.match(/['"]([A-Z]\w+)(?:Controller)?(?:::class\s*,\s*['"](\w+)['"]|@(\w+))/);
      const controller = controllerMatch?.[1];
      const action = controllerMatch?.[2] ?? controllerMatch?.[3];

      refs.push({
        type: 'route',
        value: fullPath,
        filePath,
        line: lineNum,
        context: `${method} ${fullPath}${allMiddleware.length ? ` [${allMiddleware.join(',')}]` : ''}${controller ? ` → ${controller}${action ? `@${action}` : ''}` : ''}`,
      });
    }

    // Route::resource('/users', UserController::class)
    const resourceMatch = line.match(/Route::resource\s*\(\s*['"]([^'"]+)['"].*?['"]?(\w+)(?:Controller)?/);
    if (resourceMatch) {
      const fullPrefix = prefixStack.filter(Boolean).join('/');
      const fullPath = normalizePath(`${fullPrefix}/${resourceMatch[1]}`);
      refs.push({
        type: 'route',
        value: fullPath,
        filePath,
        line: lineNum,
        context: `RESOURCE ${fullPath} → ${resourceMatch[2]}Controller`,
      });
    }
  }

  return refs;
}
