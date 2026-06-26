// Created by dev on 2026/06/02
// deep-index 模块类型定义 — tree-sitter AST 提取 + 基础设施依赖提取

export type SupportedLang = 'java' | 'php' | 'typescript' | 'kotlin';

export interface SymbolInfo {
  kind: 'class' | 'interface' | 'enum' | 'function' | 'method' | 'constant' | 'annotation';
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /** 方法/函数签名（不含 body） */
  signature: string;
  /** 完整源码（含 body，用于 LLM 分析） */
  body: string;
  /** 返回类型 */
  returnType?: string;
  /** 参数列表 */
  params?: ParamInfo[];
  /** 所属类/接口 */
  parent?: string;
  /** 注解/装饰器列表 */
  annotations: string[];
  /** Javadoc / PHPDoc / JSDoc */
  doc?: string;
  /** 修饰符 */
  modifiers: string[];
  /** 继承/实现 */
  extends?: string;
  implements?: string[];
}

export interface ParamInfo {
  name: string;
  type?: string;
  defaultValue?: string;
}

export interface CallEdge {
  /** 调用者 qualifiedName（如 UserService.getUser） */
  caller: string;
  /** 被调用者名称（尽可能解析为 qualifiedName） */
  callee: string;
  /** 原始调用表达式（如 profileService.getAvatar） */
  calleeRaw: string;
  filePath: string;
  line: number;
  kind: 'method_call' | 'static_call' | 'constructor' | 'function_call';
}

export interface InfraRef {
  type: 'sql_table' | 'redis_key' | 'redis_cluster' | 'kafka_topic' | 'rpc_consumer' | 'rpc_provider' | 'config_key' | 'route';
  value: string;
  filePath: string;
  line: number;
  /** 附加上下文（如 HTTP 方法、RPC 接口名） */
  context?: string;
}

export interface FileAnalysis {
  filePath: string;
  lang: SupportedLang;
  symbols: SymbolInfo[];
  infraRefs: InfraRef[];
  callEdges: CallEdge[];
  imports: string[];
  /** 文件级别的 namespace/package */
  namespace?: string;
}

export interface ModuleInfo {
  /** 模块路径（如 com.example.user, App\Http\Controllers） */
  path: string;
  files: FileAnalysis[];
  /** 模块内所有符号的数量统计 */
  stats: {
    classes: number;
    interfaces: number;
    methods: number;
    functions: number;
  };
}

export interface RepoAnalysis {
  repoId: string;
  lang: SupportedLang;
  repoPath: string;
  /** 所有文件的分析结果 */
  files: FileAnalysis[];
  /** 按模块/包分组 */
  modules: ModuleInfo[];
  /** 全局基础设施引用 */
  infraRefs: InfraRef[];
  /** 全局调用边 */
  callEdges: CallEdge[];
  /** 分析统计 */
  stats: {
    filesScanned: number;
    totalSymbols: number;
    totalInfraRefs: number;
    totalCallEdges: number;
    parseErrors: number;
    elapsedMs: number;
  };
}
