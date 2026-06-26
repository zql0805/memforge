// pino 替代品 — proxy 打包环境下的轻量 stderr 日志
// 仅实现 scanner 依赖的 info/warn/error/child 方法

function createLogger(module?: string): any {
  const prefix = module ? `[${module}]` : '[proxy]';
  const write = (level: string, ...args: unknown[]) => {
    const msg = args.map(a =>
      typeof a === 'object' ? JSON.stringify(a) : String(a),
    ).join(' ');
    process.stderr.write(`${prefix} ${level}: ${msg}\n`);
  };

  const logger: Record<string, any> = {
    info: (...args: unknown[]) => write('INFO', ...args),
    warn: (...args: unknown[]) => write('WARN', ...args),
    error: (...args: unknown[]) => write('ERROR', ...args),
    debug: () => {},
    trace: () => {},
    fatal: (...args: unknown[]) => write('FATAL', ...args),
    child: (bindings: Record<string, string>) => createLogger(bindings.module || module),
    level: 'info',
    isLevelEnabled: () => true,
  };
  return logger;
}

export default function pino(_opts?: any): any {
  return createLogger();
}

pino.destination = () => process.stderr;
pino.transport = () => ({ write: () => {} });
