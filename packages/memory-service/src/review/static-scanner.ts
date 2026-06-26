import { getLogger } from '@memforgeai/shared';

const logger = getLogger('review:static');

export interface StaticFinding {
  severity: 'P0' | 'P1' | 'P2';
  category: 'security' | 'exception' | 'logic' | 'performance' | 'compatibility' | 'convention';
  source: 'static_rule';
  file: string;
  line?: number;
  description: string;
  suggestion: string;
  ruleRef?: string;
}

interface ContextRule {
  withinLines: number;
  mustMatch: RegExp;
}

interface ScanRule {
  id: string;
  pattern: RegExp;
  severity: StaticFinding['severity'];
  category: StaticFinding['category'];
  description: string;
  suggestion: string;
  fileFilter?: RegExp;
  contextRule?: ContextRule;
}

const SCAN_RULES: ScanRule[] = [
  {
    id: 'sql-select-star',
    pattern: /SELECT\s+\*/i,
    severity: 'P2',
    category: 'performance',
    description: 'SELECT * 查询，应明确指定需要的列',
    suggestion: '替换为具体列名，避免不必要的数据传输',
  },
  {
    id: 'sql-injection-concat',
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM|JOIN|SET)\s.*?(?:"\s*\+\s*\w+\s*\+\s*"|'\s*\.\s*\$|\.\s*concat\()/i,
    severity: 'P0',
    category: 'security',
    description: 'SQL 拼接风险，可能存在 SQL 注入',
    suggestion: '使用参数化查询（PreparedStatement / $1 绑定）',
    fileFilter: /\.(java|php|py|ts|js)$/,
  },
  {
    id: 'empty-catch',
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
    severity: 'P1',
    category: 'exception',
    description: '空 catch 块，异常被静默吞掉',
    suggestion: '至少记录 ERROR 日志，或向上抛出',
  },
  {
    id: 'hardcoded-secret',
    pattern: /(password|secret|token|api_key|apikey)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    severity: 'P0',
    category: 'security',
    description: '硬编码的密钥/Token',
    suggestion: '使用环境变量或配置中心管理敏感信息',
  },
  {
    id: 'console-log',
    pattern: /console\.(log|debug|info)\(/,
    severity: 'P2',
    category: 'convention',
    description: '残留的 console 输出',
    suggestion: '使用项目统一的 logger，移除 console 调用',
    fileFilter: /\.(ts|js|tsx|jsx)$/,
  },
  {
    id: 'todo-fixme',
    pattern: /\/\/\s*(TODO|FIXME|HACK|XXX)\b/i,
    severity: 'P2',
    category: 'convention',
    description: '残留的 TODO/FIXME 注释',
    suggestion: '在提交前处理或创建 issue 跟踪',
  },
  {
    id: 'cors-allow-all',
    pattern: /Access-Control-Allow-Origin['":\s]*\*/,
    severity: 'P1',
    category: 'security',
    description: 'CORS 配置允许所有来源',
    suggestion: '限定具体域名',
  },

  // ── WooYun 安全域：financial ──
  {
    id: 'wooyun-price-from-client',
    pattern: /\$_(?:GET|POST|REQUEST)\s*\[\s*['"](?:price|amount|money|fee|total)/i,
    severity: 'P0',
    category: 'security',
    description: '支付金额/价格来自客户端输入',
    suggestion: '金额必须由服务端从订单表读取，禁止信任客户端传入值',
    fileFilter: /\.(php|java|py|ts|js)$/,
  },
  {
    id: 'wooyun-balance-no-lock',
    pattern: /balance\s*[-+]=|balance\s*=\s*balance\s*[-+]/i,
    severity: 'P0',
    category: 'security',
    description: '余额直接加减运算，未使用行锁或原子操作',
    suggestion: '使用 SELECT ... FOR UPDATE 或 CAS 乐观锁保护余额变更',
    fileFilter: /\.(php|java|py|ts|js|sql)$/,
  },
  {
    id: 'wooyun-refund-no-idempotent',
    pattern: /(?:function|def|public|private|protected)\s+\w*(?:refund|退款)\w*\s*\(/i,
    severity: 'P2',
    category: 'security',
    description: '退款方法定义：请确认是否基于订单号做幂等',
    suggestion: '退款接口必须基于唯一订单号做幂等校验',
    fileFilter: /(?:pay|order|refund|wallet|recharge)\.(php|java|py|ts|js)$/i,
  },

  // ── WooYun 安全域：authorization ──
  {
    id: 'wooyun-user-id-param',
    pattern: /\$_(?:GET|POST|REQUEST)\s*\[\s*['"](?:user_?id|uid|member_?id)['"]\s*\]/i,
    severity: 'P1',
    category: 'security',
    description: 'user_id 从请求参数获取，存在水平越权风险',
    suggestion: '必须从 session/token 中获取已认证的 user_id，不信任客户端参数',
    fileFilter: /\.(php|java|py|ts|js)$/,
  },
  {
    id: 'wooyun-sequential-id',
    pattern: /(?:find|get|query|select|delete|update).*?(?:ById|by_id)\s*\(\s*\$(?:_GET|_POST|_REQUEST|id|params)/i,
    severity: 'P1',
    category: 'security',
    description: '使用可预测的自增 ID 直接查询，存在 IDOR 越权风险',
    suggestion: '对资源访问增加 owner 校验，或改用 UUID 替代自增 ID',
    fileFilter: /\.(php|java|py|ts|js)$/,
  },

  // ── WooYun 安全域：authentication ──
  {
    id: 'wooyun-predictable-token',
    pattern: /(?:md5|sha1)\s*\(\s*(?:time|date|strtotime|microtime)\s*\(/i,
    severity: 'P0',
    category: 'security',
    description: '使用时间戳生成 token/nonce，值可预测',
    suggestion: '使用加密安全随机数生成 token（如 random_bytes / SecureRandom）',
    fileFilter: /\.(php|java|py|ts|js)$/,
  },
  {
    id: 'wooyun-no-rate-limit-captcha',
    pattern: /verify_code|captcha|验证码/i,
    severity: 'P2',
    category: 'security',
    description: '验证码逻辑提示：请确认是否有次数限制和过期时间',
    suggestion: '验证码需加频率限制（如 5次/分钟）+ 过期时间（5分钟）',
    fileFilter: /\.(php|java|py|ts|js)$/,
  },

  // ── WooYun 安全域：information ──
  {
    id: 'wooyun-stack-trace-leak',
    pattern: /(?:printStackTrace|traceback\.print_exc|console\.trace|stack_trace_string)/i,
    severity: 'P1',
    category: 'security',
    description: '错误信息可能暴露内部路径/SQL/堆栈',
    suggestion: '生产环境应返回通用错误信息，堆栈仅写入日志',
    fileFilter: /\.(php|java|py|ts|js)$/,
  },
  {
    id: 'wooyun-debug-endpoint',
    pattern: /(?:phpinfo\s*\(|\/debug\/|\/actuator\/|Debugbar|dd\(|var_dump\()/,
    severity: 'P1',
    category: 'security',
    description: '调试接口/函数残留，可能泄露敏感信息',
    suggestion: '使用环境变量控制，生产环境必须禁用所有调试入口',
    fileFilter: /\.(php|java|py|ts|js)$/,
  },

  // ── WooYun 安全域：logic_flow ──
  {
    id: 'wooyun-toctou',
    pattern: /if\s*\(.*?(?:exists|count|check|has|find)(?:By|One|First)?\s*\(/i,
    severity: 'P1',
    category: 'security',
    description: '先检查后执行(TOCTOU)模式，存在竞态条件',
    suggestion: '使用数据库唯一约束或分布式锁替代 check-then-act',
    fileFilter: /\.(php|java|py|ts|js)$/,
    contextRule: {
      withinLines: 5,
      mustMatch: /(?:insert|create|update|delete|save|add|put|remove)\s*\(/i,
    },
  },
  {
    id: 'wooyun-batch-no-limit',
    pattern: /(?:foreach|for\s*\(|\.forEach|\.map)\s*\(\s*\$(?:_GET|_POST|_REQUEST)\[/i,
    severity: 'P1',
    category: 'security',
    description: '批量操作数据来自用户输入且无上限',
    suggestion: '限制单次批量操作的数量上限（如 max 100）',
    fileFilter: /\.(php|java|py|ts|js)$/,
  },

  // ── WooYun 安全域：configuration ──
  {
    id: 'wooyun-env-public',
    pattern: /(?:\.env|\.htaccess|web\.config|credentials\.json)\b/,
    severity: 'P1',
    category: 'security',
    description: '敏感配置文件被引用，确认不在公共可访问路径',
    suggestion: '检查 web 根目录和版本控制，确保 .env 等文件不可公开访问',
    fileFilter: /\.(conf|yml|yaml|nginx|apache|dockerfile)$/i,
  },
  {
    id: 'wooyun-default-password',
    pattern: /(?:password|passwd)\s*[:=]\s*['"](?:admin|123456|password|root|test|default)['"]/i,
    severity: 'P0',
    category: 'security',
    description: '使用默认/弱密码',
    suggestion: '强制修改默认凭据，密码应满足复杂度要求',
  },
];

/**
 * 对 diff 文本执行静态规则扫描（正则/关键词匹配）。
 * 不需要 LLM，确定性结果。
 */
export function scanDiff(diff: string, files: string[]): StaticFinding[] {
  const findings: StaticFinding[] = [];
  const lines = diff.split('\n');
  let currentFile = '';
  let lineNumber = 0;

  const maxContext = Math.max(0, ...SCAN_RULES.filter(r => r.contextRule).map(r => r.contextRule!.withinLines));
  const pendingContextRules: Array<{
    rule: ScanRule; file: string; line: number; remaining: number;
  }> = [];

  for (const line of lines) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      pendingContextRules.length = 0;
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      lineNumber = parseInt(hunkMatch[1], 10) - 1;
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineNumber++;
      const addedLine = line.slice(1);

      for (let pi = pendingContextRules.length - 1; pi >= 0; pi--) {
        const pending = pendingContextRules[pi];
        if (pending.file !== currentFile) {
          pendingContextRules.splice(pi, 1);
          continue;
        }
        pending.remaining--;
        if (pending.rule.contextRule!.mustMatch.test(addedLine)) {
          const alreadyFound = findings.some(
            f => f.file === currentFile && f.ruleRef === pending.rule.id && Math.abs((f.line || 0) - pending.line) < 3,
          );
          if (!alreadyFound) {
            findings.push({
              severity: pending.rule.severity,
              category: pending.rule.category,
              source: 'static_rule',
              file: currentFile,
              line: pending.line,
              description: pending.rule.description,
              suggestion: pending.rule.suggestion,
              ruleRef: pending.rule.id,
            });
          }
          pendingContextRules.splice(pi, 1);
        } else if (pending.remaining <= 0) {
          pendingContextRules.splice(pi, 1);
        }
      }

      for (const rule of SCAN_RULES) {
        if (rule.fileFilter && !rule.fileFilter.test(currentFile)) continue;
        if (rule.pattern.test(addedLine)) {
          if (rule.contextRule) {
            pendingContextRules.push({
              rule, file: currentFile, line: lineNumber,
              remaining: rule.contextRule.withinLines,
            });
          } else {
            const alreadyFound = findings.some(
              f => f.file === currentFile && f.ruleRef === rule.id && Math.abs((f.line || 0) - lineNumber) < 3,
            );
            if (!alreadyFound) {
              findings.push({
                severity: rule.severity,
                category: rule.category,
                source: 'static_rule',
                file: currentFile,
                line: lineNumber,
                description: rule.description,
                suggestion: rule.suggestion,
                ruleRef: rule.id,
              });
            }
          }
        }
      }
    } else if (!line.startsWith('-')) {
      lineNumber++;
      for (let pi = pendingContextRules.length - 1; pi >= 0; pi--) {
        pendingContextRules[pi].remaining--;
        if (pendingContextRules[pi].remaining <= 0) {
          pendingContextRules.splice(pi, 1);
        }
      }
    }
  }

  logger.info({ findingCount: findings.length, fileCount: files.length }, '静态扫描完成');
  return findings;
}
