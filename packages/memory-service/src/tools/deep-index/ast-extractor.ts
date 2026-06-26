// Created by dev on 2026/06/02
// tree-sitter AST 符号提取器 — 支持 Java / PHP / TypeScript / Vue / JavaScript

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogger } from '@memforgeai/shared';
import type { SupportedLang, SymbolInfo, ParamInfo, CallEdge, FileAnalysis } from './types.js';

const logger = getLogger('deep-index:ast');

let ParserClass: any;
let LanguageClass: any;
let initialized = false;
let parseCount = 0;
const RECYCLE_THRESHOLD = 200;

// 各语法包自带 WASM 文件，按 npm 包名定位
const WASM_PATHS: Record<SupportedLang, { pkg: string; file: string }> = {
  java: { pkg: 'tree-sitter-java', file: 'tree-sitter-java.wasm' },
  php: { pkg: 'tree-sitter-php', file: 'tree-sitter-php.wasm' },
  typescript: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  kotlin: { pkg: 'tree-sitter-kotlin', file: 'tree-sitter-kotlin.wasm' },
};

const languageCache = new Map<SupportedLang, any>();

async function ensureInit(): Promise<void> {
  if (initialized) return;
  const mod = await import('web-tree-sitter');
  ParserClass = mod.Parser;
  LanguageClass = mod.Language;
  await ParserClass.init();
  initialized = true;
}

function findWasmPath(lang: SupportedLang): string {
  const { pkg, file } = WASM_PATHS[lang];
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const searchRoots = [
    resolve(thisDir, '..', '..', '..', 'node_modules', pkg, file),
    resolve(thisDir, '..', '..', '..', '..', '..', 'node_modules', pkg, file),
    resolve(process.cwd(), 'node_modules', pkg, file),
    // assets/wasm 存放自行编译的 WASM（如 tree-sitter-kotlin）
    resolve(process.cwd(), 'assets', 'wasm', file),
    resolve(thisDir, '..', '..', '..', '..', '..', 'assets', 'wasm', file),
  ];
  for (const p of searchRoots) {
    if (existsSync(p)) return p;
  }
  throw new Error(`未找到 ${pkg}/${file} WASM 文件，请确认已安装 ${pkg}`);
}

async function getLanguage(lang: SupportedLang): Promise<any> {
  const cached = languageCache.get(lang);
  if (cached) return cached;
  const wasmPath = findWasmPath(lang);
  const language = await LanguageClass.load(wasmPath);
  languageCache.set(lang, language);
  return language;
}

/**
 * 解析单个源码文件，提取所有符号。
 */
export async function extractSymbolsFromFile(
  filePath: string,
  lang: SupportedLang,
  sourceCode?: string,
): Promise<FileAnalysis> {
  await ensureInit();

  // WASM 线性内存只增不减，定期重置解析器释放堆
  parseCount++;
  if (parseCount >= RECYCLE_THRESHOLD) {
    await resetParser();
    parseCount = 0;
  }

  let code = sourceCode ?? await readFile(filePath, 'utf-8');

  // .vue 文件：提取 <script> 块内容，用 TypeScript 解析器解析
  const isVue = extname(filePath) === '.vue';
  if (isVue) {
    const scriptContent = extractVueScriptBlock(code);
    if (!scriptContent) {
      return { filePath, lang, symbols: [], infraRefs: [], callEdges: [], imports: [] };
    }
    code = scriptContent;
  }

  const language = await getLanguage(lang);
  const parser = new ParserClass();
  parser.setLanguage(language);

  const tree = parser.parse(code);
  try {
    const rootNode = tree.rootNode;

    const result: FileAnalysis = {
      filePath,
      lang,
      symbols: [],
      infraRefs: [],
      callEdges: [],
      imports: [],
    };

    switch (lang) {
      case 'java':
        extractJava(rootNode, code, filePath, result);
        break;
      case 'php':
        extractPhp(rootNode, code, filePath, result);
        break;
      case 'typescript':
        extractTypeScript(rootNode, code, filePath, result);
        break;
      case 'kotlin':
        extractKotlin(rootNode, code, filePath, result);
        break;
    }

    return result;
  } finally {
    tree.delete();
    parser.delete();
  }
}

async function resetParser(): Promise<void> {
  languageCache.clear();
  initialized = false;
  logger.info({ threshold: RECYCLE_THRESHOLD }, 'WASM 解析器已重置，释放线性内存');
}

// ─── Java 提取 ──────────────────────────────────────────────

function extractJava(root: any, code: string, filePath: string, result: FileAnalysis): void {
  // package 声明
  const pkgNode = findFirst(root, 'package_declaration');
  if (pkgNode) {
    const scopedId = findFirst(pkgNode, 'scoped_identifier') ?? findFirst(pkgNode, 'identifier');
    result.namespace = scopedId?.text;
  }

  // import 语句
  for (const imp of findAll(root, 'import_declaration')) {
    result.imports.push(imp.text.replace(/^import\s+/, '').replace(/;$/, '').trim());
  }

  // 类/接口/枚举/注解
  const typeDecls = [
    ...findAll(root, 'class_declaration'),
    ...findAll(root, 'interface_declaration'),
    ...findAll(root, 'enum_declaration'),
    ...findAll(root, 'annotation_type_declaration'),
  ];

  for (const decl of typeDecls) {
    const kind = nodeTypeToKind(decl.type);
    // childForFieldName('name') 精确获取类名，避免误取注解中的 identifier
    const nameNode = decl.childForFieldName('name') ?? findDirectChild(decl, 'identifier');
    if (!nameNode) continue;

    const name = nameNode.text;
    const qn = result.namespace ? `${result.namespace}.${name}` : name;
    const annotations = extractJavaAnnotations(decl);
    const modifiers = extractJavaModifiers(decl);
    const doc = extractPrecedingDoc(code, decl.startIndex);

    const extendsNode = findFirst(decl, 'superclass');
    const implementsNode = findFirst(decl, 'super_interfaces');

    const symbol: SymbolInfo = {
      kind,
      name,
      qualifiedName: qn,
      filePath,
      startLine: decl.startPosition.row + 1,
      endLine: decl.endPosition.row + 1,
      signature: extractSignatureLine(code, decl),
      body: decl.text,
      annotations,
      modifiers,
      doc,
      extends: extendsNode ? extractTypeText(extendsNode) : undefined,
      implements: implementsNode ? extractTypeListText(implementsNode) : undefined,
    };
    result.symbols.push(symbol);

    // 提取方法
    const methodDecls = findAll(decl, 'method_declaration');
    const constructorDecls = findAll(decl, 'constructor_declaration');
    for (const method of [...methodDecls, ...constructorDecls]) {
      const methodName = findFirst(method, 'identifier');
      if (!methodName) continue;

      const methodModifiers = extractJavaModifiers(method);
      if (!methodModifiers.includes('public') && kind !== 'interface') continue;

      const returnTypeNode = method.type === 'method_declaration'
        ? method.childForFieldName('type')
        : null;
      const formalParams = findFirst(method, 'formal_parameters');
      const params = formalParams ? extractJavaParams(formalParams) : [];
      const methodAnnotations = extractJavaAnnotations(method);
      const methodDoc = extractPrecedingDoc(code, method.startIndex);

      const methodQn = `${qn}.${methodName.text}`;
      result.symbols.push({
        kind: 'method',
        name: methodName.text,
        qualifiedName: methodQn,
        filePath,
        startLine: method.startPosition.row + 1,
        endLine: method.endPosition.row + 1,
        signature: extractSignatureLine(code, method),
        body: method.text,
        returnType: returnTypeNode?.text,
        params,
        parent: name,
        annotations: methodAnnotations,
        modifiers: methodModifiers,
        doc: mergeDocWithBodyComments(methodDoc, method.text),
      });

      // 调用边提取
      const methodBody = findFirst(method, 'block');
      if (methodBody) {
        extractJavaCallEdges(methodBody, methodQn, filePath, result);
      }
    }
  }
}

/** 从 Java 方法体中提取调用边 */
function extractJavaCallEdges(
  bodyNode: any, callerQn: string, filePath: string, result: FileAnalysis,
): void {
  for (const inv of findAll(bodyNode, 'method_invocation')) {
    const nameNode = inv.childForFieldName('name');
    if (!nameNode) continue;
    const methodName = nameNode.text;
    const objectNode = inv.childForFieldName('object');

    let calleeRaw: string;
    let callee: string;
    let kind: CallEdge['kind'] = 'method_call';

    if (objectNode) {
      calleeRaw = `${objectNode.text}.${methodName}`;
      // best-effort: 如果 object 是大写开头，可能是类名静态调用
      if (/^[A-Z]/.test(objectNode.text)) {
        kind = 'static_call';
        callee = `${objectNode.text}.${methodName}`;
      } else {
        callee = methodName;
      }
    } else {
      calleeRaw = methodName;
      callee = methodName;
      kind = 'function_call';
    }

    result.callEdges.push({
      caller: callerQn,
      callee,
      calleeRaw,
      filePath,
      line: inv.startPosition.row + 1,
      kind,
    });
  }

  // new Xxx() 构造函数调用
  for (const creation of findAll(bodyNode, 'object_creation_expression')) {
    const typeNode = findFirst(creation, 'type_identifier') ?? findFirst(creation, 'scoped_type_identifier');
    if (!typeNode) continue;
    result.callEdges.push({
      caller: callerQn,
      callee: typeNode.text,
      calleeRaw: `new ${typeNode.text}()`,
      filePath,
      line: creation.startPosition.row + 1,
      kind: 'constructor',
    });
  }
}

function extractJavaAnnotations(node: any): string[] {
  const annotations: string[] = [];
  for (const child of node.children) {
    if (child.type === 'modifiers') {
      for (const mod of child.children) {
        if (mod.type === 'marker_annotation' || mod.type === 'annotation') {
          annotations.push(mod.text);
        }
      }
    }
  }
  return annotations;
}

function extractJavaModifiers(node: any): string[] {
  const mods: string[] = [];
  for (const child of node.children) {
    if (child.type === 'modifiers') {
      for (const mod of child.children) {
        if (mod.type !== 'marker_annotation' && mod.type !== 'annotation') {
          mods.push(mod.text);
        }
      }
    }
  }
  return mods;
}

function extractJavaParams(paramsNode: any): ParamInfo[] {
  const params: ParamInfo[] = [];
  for (const child of paramsNode.children) {
    if (child.type === 'formal_parameter' || child.type === 'spread_parameter') {
      const typeNode = child.childForFieldName('type');
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        params.push({
          name: nameNode.text,
          type: typeNode?.text,
        });
      }
    }
  }
  return params;
}

// ─── PHP 提取 ──────────────────────────────────────────────

function extractPhp(root: any, code: string, filePath: string, result: FileAnalysis): void {
  // PHP 文件通常有一个 program node，其中包含 php_tag + 声明
  const phpNode = root.type === 'program' ? root : root;

  // namespace
  const nsDecl = findFirst(phpNode, 'namespace_definition');
  if (nsDecl) {
    const nsName = findFirst(nsDecl, 'namespace_name') ?? findFirst(nsDecl, 'qualified_name');
    result.namespace = nsName?.text;
  }

  // use 语句
  for (const use of findAll(phpNode, 'namespace_use_declaration')) {
    result.imports.push(use.text.replace(/^use\s+/, '').replace(/;$/, '').trim());
  }

  // 类
  for (const cls of findAll(phpNode, 'class_declaration')) {
    extractPhpClass(cls, code, filePath, result, 'class');
  }

  // 接口
  for (const iface of findAll(phpNode, 'interface_declaration')) {
    extractPhpClass(iface, code, filePath, result, 'interface');
  }

  // 顶层函数
  for (const fn of findAll(phpNode, 'function_definition')) {
    const nameNode = findFirst(fn, 'name');
    if (!nameNode) continue;

    const qn = result.namespace ? `${result.namespace}\\${nameNode.text}` : nameNode.text;
    const params = extractPhpParams(findFirst(fn, 'formal_parameters'));
    const returnType = fn.childForFieldName('return_type');
    const doc = extractPrecedingDoc(code, fn.startIndex);

    result.symbols.push({
      kind: 'function',
      name: nameNode.text,
      qualifiedName: qn,
      filePath,
      startLine: fn.startPosition.row + 1,
      endLine: fn.endPosition.row + 1,
      signature: extractSignatureLine(code, fn),
      body: fn.text,
      returnType: returnType?.text?.replace(/^:\s*/, ''),
      params,
      annotations: [],
      modifiers: [],
      doc,
    });
  }
}

function extractPhpClass(
  node: any, code: string, filePath: string, result: FileAnalysis, kind: 'class' | 'interface',
): void {
  const nameNode = findFirst(node, 'name');
  if (!nameNode) return;

  const name = nameNode.text;
  const qn = result.namespace ? `${result.namespace}\\${name}` : name;
  const doc = extractPrecedingDoc(code, node.startIndex);

  const extendsClause = findFirst(node, 'base_clause');
  const implementsClause = findFirst(node, 'class_interface_clause');

  result.symbols.push({
    kind,
    name,
    qualifiedName: qn,
    filePath,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractSignatureLine(code, node),
    body: node.text,
    annotations: [],
    modifiers: extractPhpModifiers(node),
    doc,
    extends: extendsClause?.text?.replace(/^extends\s+/, ''),
    implements: implementsClause
      ? implementsClause.text.replace(/^implements\s+/, '').split(',').map((s: string) => s.trim())
      : undefined,
  });

  // 方法
  const body = findFirst(node, 'declaration_list');
  if (!body) return;

  for (const method of findAll(body, 'method_declaration')) {
    const methodName = findFirst(method, 'name');
    if (!methodName) continue;

    const visibility = extractPhpModifiers(method);
    // PHP 接口方法默认 public
    if (kind !== 'interface' && !visibility.includes('public')) continue;

    const params = extractPhpParams(findFirst(method, 'formal_parameters'));
    const returnType = method.childForFieldName('return_type');
    const methodDoc = extractPrecedingDoc(code, method.startIndex);

    const methodQn = `${qn}::${methodName.text}`;
    result.symbols.push({
      kind: 'method',
      name: methodName.text,
      qualifiedName: methodQn,
      filePath,
      startLine: method.startPosition.row + 1,
      endLine: method.endPosition.row + 1,
      signature: extractSignatureLine(code, method),
      body: method.text,
      returnType: returnType?.text?.replace(/^:\s*/, ''),
      params,
      parent: name,
      annotations: extractPhpAttributes(method),
      modifiers: visibility,
      doc: mergeDocWithBodyComments(methodDoc, method.text),
    });

    // 调用边提取
    const methodBody = findFirst(method, 'compound_statement');
    if (methodBody) {
      extractPhpCallEdges(methodBody, methodQn, filePath, result);
    }
  }
}

function extractPhpModifiers(node: any): string[] {
  const mods: string[] = [];
  for (const child of node.children) {
    if (['visibility_modifier', 'static_modifier', 'abstract_modifier', 'final_modifier', 'readonly_modifier'].includes(child.type)) {
      mods.push(child.text);
    }
  }
  return mods;
}

function extractPhpAttributes(node: any): string[] {
  const attrs: string[] = [];
  for (const child of node.children) {
    if (child.type === 'attribute_list') {
      attrs.push(child.text);
    }
  }
  return attrs;
}

function extractPhpParams(paramsNode: any): ParamInfo[] {
  if (!paramsNode) return [];
  const params: ParamInfo[] = [];
  for (const child of paramsNode.children) {
    if (child.type === 'simple_parameter' || child.type === 'variadic_parameter' || child.type === 'property_promotion_parameter') {
      const nameNode = findFirst(child, 'variable_name');
      const typeNode = child.childForFieldName('type');
      const defaultNode = child.childForFieldName('default_value');
      if (nameNode) {
        params.push({
          name: nameNode.text,
          type: typeNode?.text,
          defaultValue: defaultNode?.text,
        });
      }
    }
  }
  return params;
}

/** 从 PHP 方法体中提取调用边 */
function extractPhpCallEdges(
  bodyNode: any, callerQn: string, filePath: string, result: FileAnalysis,
): void {
  // $this->method() / $obj->method()
  for (const call of findAll(bodyNode, 'member_call_expression')) {
    const nameNode = findFirst(call, 'name');
    if (!nameNode) continue;
    const objectNode = call.children[0];
    const calleeRaw = objectNode ? `${objectNode.text}->${nameNode.text}` : nameNode.text;
    result.callEdges.push({
      caller: callerQn,
      callee: nameNode.text,
      calleeRaw,
      filePath,
      line: call.startPosition.row + 1,
      kind: 'method_call',
    });
  }

  // ClassName::method() 静态调用
  for (const call of findAll(bodyNode, 'scoped_call_expression')) {
    const scopeNode = call.childForFieldName('scope') ?? call.children[0];
    const nameNode = findFirst(call, 'name');
    if (!nameNode || !scopeNode) continue;
    const calleeRaw = `${scopeNode.text}::${nameNode.text}`;
    result.callEdges.push({
      caller: callerQn,
      callee: `${scopeNode.text}::${nameNode.text}`,
      calleeRaw,
      filePath,
      line: call.startPosition.row + 1,
      kind: 'static_call',
    });
  }

  // 顶层函数调用 func()
  for (const call of findAll(bodyNode, 'function_call_expression')) {
    const fnNode = call.childForFieldName('function') ?? call.children[0];
    if (!fnNode || fnNode.type === 'member_call_expression' || fnNode.type === 'scoped_call_expression') continue;
    const funcName = fnNode.text;
    if (/^[a-z_]/.test(funcName) && !['array', 'isset', 'empty', 'unset', 'echo', 'print', 'die', 'exit'].includes(funcName)) {
      result.callEdges.push({
        caller: callerQn,
        callee: funcName,
        calleeRaw: funcName,
        filePath,
        line: call.startPosition.row + 1,
        kind: 'function_call',
      });
    }
  }
}

// ─── TypeScript 提取 ─────────────────────────────────────────

function extractTypeScript(root: any, code: string, filePath: string, result: FileAnalysis): void {
  // import 语句
  for (const imp of findAll(root, 'import_statement')) {
    result.imports.push(imp.text.replace(/;$/, '').trim());
  }

  // 类
  for (const cls of findAll(root, 'class_declaration')) {
    extractTsClass(cls, code, filePath, result);
  }

  // 接口
  for (const iface of [...findAll(root, 'interface_declaration'), ...findAll(root, 'type_alias_declaration')]) {
    const nameNode = findFirst(iface, 'type_identifier') ?? findFirst(iface, 'identifier');
    if (!nameNode) continue;

    const isExported = iface.parent?.type === 'export_statement';
    if (!isExported && iface.type !== 'interface_declaration') continue;

    result.symbols.push({
      kind: 'interface',
      name: nameNode.text,
      qualifiedName: nameNode.text,
      filePath,
      startLine: iface.startPosition.row + 1,
      endLine: iface.endPosition.row + 1,
      signature: extractSignatureLine(code, iface),
      body: iface.text,
      annotations: extractTsDecorators(iface),
      modifiers: isExported ? ['export'] : [],
      doc: extractPrecedingDoc(code, iface.startIndex),
    });
  }

  // 顶层函数（export function / export const ... = () => {}）
  for (const fn of findAll(root, 'function_declaration')) {
    const nameNode = findFirst(fn, 'identifier');
    if (!nameNode) continue;

    const isExported = fn.parent?.type === 'export_statement';
    const params = extractTsParams(findFirst(fn, 'formal_parameters'));
    const returnType = fn.childForFieldName('return_type');

    result.symbols.push({
      kind: 'function',
      name: nameNode.text,
      qualifiedName: nameNode.text,
      filePath,
      startLine: fn.startPosition.row + 1,
      endLine: fn.endPosition.row + 1,
      signature: extractSignatureLine(code, fn),
      body: fn.text,
      returnType: returnType?.text?.replace(/^:\s*/, ''),
      params,
      annotations: [],
      modifiers: isExported ? ['export'] : [],
      doc: extractPrecedingDoc(code, fn.startIndex),
    });

    // 顶层函数调用边提取
    const fnBody = findFirst(fn, 'statement_block');
    if (fnBody) {
      extractTsCallEdges(fnBody, nameNode.text, filePath, result);
    }
  }

  // export const / export enum
  for (const exp of findAll(root, 'export_statement')) {
    const varDecl = findFirst(exp, 'lexical_declaration');
    if (varDecl) {
      for (const declarator of findAll(varDecl, 'variable_declarator')) {
        const nameNode = findFirst(declarator, 'identifier');
        if (!nameNode) continue;
        result.symbols.push({
          kind: 'constant',
          name: nameNode.text,
          qualifiedName: nameNode.text,
          filePath,
          startLine: exp.startPosition.row + 1,
          endLine: exp.endPosition.row + 1,
          signature: extractSignatureLine(code, exp),
          body: exp.text,
          annotations: [],
          modifiers: ['export'],
          doc: extractPrecedingDoc(code, exp.startIndex),
        });
      }
    }

    const enumDecl = findFirst(exp, 'enum_declaration');
    if (enumDecl) {
      const nameNode = findFirst(enumDecl, 'identifier');
      if (nameNode) {
        result.symbols.push({
          kind: 'enum',
          name: nameNode.text,
          qualifiedName: nameNode.text,
          filePath,
          startLine: enumDecl.startPosition.row + 1,
          endLine: enumDecl.endPosition.row + 1,
          signature: extractSignatureLine(code, enumDecl),
          body: enumDecl.text,
          annotations: [],
          modifiers: ['export'],
          doc: extractPrecedingDoc(code, enumDecl.startIndex),
        });
      }
    }
  }
}

function extractTsClass(node: any, code: string, filePath: string, result: FileAnalysis): void {
  const nameNode = findFirst(node, 'type_identifier') ?? findFirst(node, 'identifier');
  if (!nameNode) return;

  const name = nameNode.text;
  const isExported = node.parent?.type === 'export_statement';
  const decorators = extractTsDecorators(node);
  const doc = extractPrecedingDoc(code, node.startIndex);

  const extendsClause = findFirst(node, 'class_heritage');

  result.symbols.push({
    kind: 'class',
    name,
    qualifiedName: name,
    filePath,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractSignatureLine(code, node),
    body: node.text,
    annotations: decorators,
    modifiers: isExported ? ['export'] : [],
    doc,
    extends: extendsClause?.text,
  });

  // 方法
  const classBody = findFirst(node, 'class_body');
  if (!classBody) return;

  for (const method of findAll(classBody, 'method_definition')) {
    const methodName = findFirst(method, 'property_identifier') ?? findFirst(method, 'identifier');
    if (!methodName) continue;

    const params = extractTsParams(findFirst(method, 'formal_parameters'));
    const returnType = method.childForFieldName('return_type');

    const tsMethodQn = `${name}.${methodName.text}`;
    result.symbols.push({
      kind: 'method',
      name: methodName.text,
      qualifiedName: tsMethodQn,
      filePath,
      startLine: method.startPosition.row + 1,
      endLine: method.endPosition.row + 1,
      signature: extractSignatureLine(code, method),
      body: method.text,
      returnType: returnType?.text?.replace(/^:\s*/, ''),
      params,
      parent: name,
      annotations: extractTsDecorators(method),
      modifiers: extractTsModifiers(method),
      doc: mergeDocWithBodyComments(extractPrecedingDoc(code, method.startIndex), method.text),
    });

    // 调用边提取
    const tsMethodBody = findFirst(method, 'statement_block');
    if (tsMethodBody) {
      extractTsCallEdges(tsMethodBody, tsMethodQn, filePath, result);
    }
  }
}

function extractTsDecorators(node: any): string[] {
  const decorators: string[] = [];
  for (const child of node.children) {
    if (child.type === 'decorator') {
      decorators.push(child.text);
    }
  }
  return decorators;
}

function extractTsModifiers(node: any): string[] {
  const mods: string[] = [];
  for (const child of node.children) {
    if (child.type === 'accessibility_modifier' || child.type === 'readonly') {
      mods.push(child.text);
    }
    if (child.type === 'static') mods.push('static');
    if (child.type === 'async') mods.push('async');
  }
  return mods;
}

function extractTsParams(paramsNode: any): ParamInfo[] {
  if (!paramsNode) return [];
  const params: ParamInfo[] = [];
  for (const child of paramsNode.children) {
    if (child.type === 'required_parameter' || child.type === 'optional_parameter' || child.type === 'rest_pattern') {
      const nameNode = findFirst(child, 'identifier');
      const typeAnnotation = findFirst(child, 'type_annotation');
      if (nameNode) {
        params.push({
          name: nameNode.text,
          type: typeAnnotation?.text?.replace(/^:\s*/, ''),
        });
      }
    }
  }
  return params;
}

/** 从 TypeScript 方法/函数体中提取调用边 */
function extractTsCallEdges(
  bodyNode: any, callerQn: string, filePath: string, result: FileAnalysis,
): void {
  for (const call of findAll(bodyNode, 'call_expression')) {
    const fnNode = call.childForFieldName('function') ?? call.children[0];
    if (!fnNode) continue;

    let calleeRaw: string;
    let callee: string;
    let kind: CallEdge['kind'] = 'function_call';

    if (fnNode.type === 'member_expression') {
      const obj = fnNode.childForFieldName('object');
      const prop = fnNode.childForFieldName('property');
      if (obj && prop) {
        calleeRaw = `${obj.text}.${prop.text}`;
        callee = obj.text === 'this' ? prop.text : calleeRaw;
        kind = 'method_call';
      } else {
        calleeRaw = fnNode.text;
        callee = fnNode.text;
      }
    } else if (fnNode.type === 'identifier') {
      calleeRaw = fnNode.text;
      callee = fnNode.text;
      kind = 'function_call';
    } else {
      continue;
    }

    // 过滤常见内置函数
    if (['console', 'JSON', 'Math', 'Object', 'Array', 'Promise', 'Date', 'String', 'Number', 'Boolean', 'RegExp', 'Error', 'Map', 'Set'].some(b => calleeRaw.startsWith(`${b}.`))) continue;
    if (['require', 'import', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'parseInt', 'parseFloat'].includes(callee)) continue;

    result.callEdges.push({
      caller: callerQn,
      callee,
      calleeRaw,
      filePath,
      line: call.startPosition.row + 1,
      kind,
    });
  }

  // new Xxx() 构造函数
  for (const creation of findAll(bodyNode, 'new_expression')) {
    const ctorNode = creation.childForFieldName('constructor') ?? creation.children[1];
    if (!ctorNode) continue;
    const ctorName = ctorNode.text;
    if (ctorName && /^[A-Z]/.test(ctorName)) {
      result.callEdges.push({
        caller: callerQn,
        callee: ctorName,
        calleeRaw: `new ${ctorName}()`,
        filePath,
        line: creation.startPosition.row + 1,
        kind: 'constructor',
      });
    }
  }
}

// ─── 通用工具函数 ────────────────────────────────────────────

function findDirectChild(node: any, type: string): any | null {
  for (const child of node.children) {
    if (child.type === type) return child;
  }
  return null;
}

function findFirst(node: any, type: string): any | null {
  if (node.type === type) return node;
  for (const child of node.children) {
    const found = findFirst(child, type);
    if (found) return found;
  }
  return null;
}

function findAll(node: any, type: string): any[] {
  const results: any[] = [];
  if (node.type === type) {
    results.push(node);
  }
  for (const child of node.children) {
    results.push(...findAll(child, type));
  }
  return results;
}

function nodeTypeToKind(type: string): SymbolInfo['kind'] {
  switch (type) {
    case 'class_declaration': return 'class';
    case 'interface_declaration': return 'interface';
    case 'enum_declaration': return 'enum';
    case 'annotation_type_declaration': return 'annotation';
    default: return 'class';
  }
}

/** 从 body 起始位置向上搜索最近的 doc comment */
function extractPrecedingDoc(code: string, startIndex: number): string | undefined {
  const before = code.substring(Math.max(0, startIndex - 2000), startIndex);
  // Javadoc / PHPDoc / JSDoc 风格
  const docMatch = before.match(/\/\*\*[\s\S]*?\*\/\s*$/);
  if (docMatch) return docMatch[0].trim();

  // 连续的 // 注释行
  const lines = before.split('\n');
  const commentLines: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('//')) {
      commentLines.unshift(trimmed);
    } else {
      break;
    }
  }
  return commentLines.length >= 1 ? commentLines.join('\n') : undefined;
}

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/** 从方法体中提取含中文的行内注释（最多 maxLines 条），用于增强语义检索 */
function extractBodyChineseComments(bodyText: string | undefined, maxLines = 5): string | undefined {
  if (!bodyText) return undefined;
  const hits: string[] = [];
  for (const line of bodyText.split('\n')) {
    const m = line.match(/\/\/\s*(.+)/);
    if (m && CJK_RANGE.test(m[1])) {
      const cleaned = m[1].trim();
      if (cleaned.length >= 4 && cleaned.length <= 100) {
        hits.push(cleaned);
        if (hits.length >= maxLines) break;
      }
    }
  }
  return hits.length > 0 ? hits.join('\n') : undefined;
}

/** 将 preceding doc 和 body 中文注释合并 */
function mergeDocWithBodyComments(precedingDoc: string | undefined, bodyText: string | undefined): string | undefined {
  const bodyComments = extractBodyChineseComments(bodyText);
  if (!precedingDoc && !bodyComments) return undefined;
  if (!bodyComments) return precedingDoc;
  if (!precedingDoc) return bodyComments;
  return `${precedingDoc}\n${bodyComments}`;
}

/** 提取声明的第一行（签名行，不含 body） */
function extractSignatureLine(code: string, node: any): string {
  const text = node.text;
  // 找到第一个 { 的位置
  const braceIdx = text.indexOf('{');
  if (braceIdx > 0) {
    return text.substring(0, braceIdx).trim();
  }
  // 没有 body（接口方法等）
  const semicolonIdx = text.indexOf(';');
  if (semicolonIdx > 0) {
    return text.substring(0, semicolonIdx + 1).trim();
  }
  // 取第一行
  const firstLine = text.split('\n')[0];
  return firstLine.trim();
}

function extractTypeText(node: any): string {
  // 移除 extends/implements 关键字
  return node.text
    .replace(/^extends\s+/, '')
    .replace(/^implements\s+/, '')
    .trim();
}

function extractTypeListText(node: any): string[] {
  return node.text
    .replace(/^implements\s+/, '')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);
}

// ─── Kotlin 提取 ──────────────────────────────────────────

function extractKotlin(root: any, code: string, filePath: string, result: FileAnalysis): void {
  // package 声明
  const pkgNode = findFirst(root, 'package_header');
  if (pkgNode) {
    const identifier = findFirst(pkgNode, 'identifier');
    if (identifier) result.namespace = identifier.text;
  }

  // import 语句
  for (const imp of findAll(root, 'import_header')) {
    const id = findFirst(imp, 'identifier');
    if (id) result.imports.push(id.text);
  }

  // 类/接口/对象
  const typeDecls = [
    ...findAll(root, 'class_declaration'),
    ...findAll(root, 'object_declaration'),
  ];

  for (const decl of typeDecls) {
    const isObject = decl.type === 'object_declaration';
    const isInterface = !isObject && decl.children.some((c: any) => c.type === 'interface');
    const isEnum = !isObject && decl.children.some((c: any) => c.text === 'enum');
    const kind = isInterface ? 'interface' as const
      : isEnum ? 'enum' as const
      : isObject ? 'class' as const
      : 'class' as const;

    const nameNode = decl.childForFieldName('name') ?? findDirectChild(decl, 'type_identifier') ?? findDirectChild(decl, 'identifier');
    if (!nameNode) continue;

    const name = nameNode.text;
    const qn = result.namespace ? `${result.namespace}.${name}` : name;
    const annotations = extractKotlinAnnotations(decl);
    const modifiers = extractKotlinModifiers(decl);
    const doc = extractPrecedingDoc(code, decl.startIndex);

    const delegationSpecifier = findFirst(decl, 'delegation_specifier');
    const extendsType = delegationSpecifier ? delegationSpecifier.text.replace(/\(.*\)$/, '') : undefined;

    const symbol: SymbolInfo = {
      kind,
      name,
      qualifiedName: qn,
      filePath,
      startLine: decl.startPosition.row + 1,
      endLine: decl.endPosition.row + 1,
      signature: extractSignatureLine(code, decl),
      body: decl.text,
      annotations,
      modifiers,
      doc,
      extends: extendsType,
    };
    result.symbols.push(symbol);

    // 提取方法（fun 声明）
    const classBody = findFirst(decl, 'class_body') ?? findFirst(decl, 'enum_class_body');
    if (!classBody) continue;

    for (const func of findAll(classBody, 'function_declaration')) {
      const funcName = findDirectChild(func, 'simple_identifier');
      if (!funcName) continue;

      const funcModifiers = extractKotlinModifiers(func);
      if (funcModifiers.includes('private')) continue;

      const returnTypeNode = func.childForFieldName('type');
      const params = extractKotlinParams(func);
      const funcAnnotations = extractKotlinAnnotations(func);
      const funcDoc = extractPrecedingDoc(code, func.startIndex);

      const methodQn = `${qn}.${funcName.text}`;
      result.symbols.push({
        kind: 'method',
        name: funcName.text,
        qualifiedName: methodQn,
        filePath,
        startLine: func.startPosition.row + 1,
        endLine: func.endPosition.row + 1,
        signature: extractSignatureLine(code, func),
        body: func.text,
        returnType: returnTypeNode?.text,
        params,
        parent: name,
        annotations: funcAnnotations,
        modifiers: funcModifiers,
        doc: mergeDocWithBodyComments(funcDoc, func.text),
      });

      const funcBody = findFirst(func, 'function_body');
      if (funcBody) {
        extractKotlinCallEdges(funcBody, methodQn, filePath, result);
      }
    }
  }

  // 顶层函数（不在类内）
  for (const func of root.children) {
    if (func.type !== 'function_declaration') continue;
    const funcName = findDirectChild(func, 'simple_identifier');
    if (!funcName) continue;

    const qn = result.namespace ? `${result.namespace}.${funcName.text}` : funcName.text;
    const returnTypeNode = func.childForFieldName('type');
    const params = extractKotlinParams(func);
    const annotations = extractKotlinAnnotations(func);
    const doc = extractPrecedingDoc(code, func.startIndex);

    result.symbols.push({
      kind: 'function',
      name: funcName.text,
      qualifiedName: qn,
      filePath,
      startLine: func.startPosition.row + 1,
      endLine: func.endPosition.row + 1,
      signature: extractSignatureLine(code, func),
      body: func.text,
      returnType: returnTypeNode?.text,
      params,
      annotations,
      modifiers: extractKotlinModifiers(func),
      doc,
    });

    const funcBody = findFirst(func, 'function_body');
    if (funcBody) {
      extractKotlinCallEdges(funcBody, qn, filePath, result);
    }
  }
}

function extractKotlinCallEdges(
  bodyNode: any, callerQn: string, filePath: string, result: FileAnalysis,
): void {
  for (const call of findAll(bodyNode, 'call_expression')) {
    const firstChild = call.children[0];
    if (!firstChild) continue;

    let calleeRaw = firstChild.text;
    let callee: string;
    let kind: CallEdge['kind'] = 'function_call';

    if (firstChild.type === 'navigation_expression') {
      const parts = calleeRaw.split('.');
      const methodName = parts[parts.length - 1];
      callee = /^[A-Z]/.test(parts[0]) ? calleeRaw : methodName;
      kind = /^[A-Z]/.test(parts[0]) ? 'static_call' : 'method_call';
    } else if (/^[A-Z]/.test(calleeRaw)) {
      callee = calleeRaw;
      kind = 'constructor';
    } else {
      callee = calleeRaw;
    }

    result.callEdges.push({
      caller: callerQn,
      callee,
      calleeRaw,
      filePath,
      line: call.startPosition.row + 1,
      kind,
    });
  }
}

function extractKotlinAnnotations(node: any): string[] {
  const annotations: string[] = [];
  for (const child of node.children) {
    if (child.type === 'modifiers') {
      for (const mod of child.children) {
        if (mod.type === 'annotation') annotations.push(mod.text);
      }
    }
  }
  return annotations;
}

function extractKotlinModifiers(node: any): string[] {
  const mods: string[] = [];
  for (const child of node.children) {
    if (child.type === 'modifiers') {
      for (const mod of child.children) {
        if (mod.type === 'visibility_modifier' || mod.type === 'class_modifier'
          || mod.type === 'function_modifier' || mod.type === 'member_modifier'
          || mod.type === 'inheritance_modifier') {
          mods.push(mod.text);
        }
      }
    }
  }
  return mods;
}

function extractKotlinParams(funcNode: any): ParamInfo[] {
  const params: ParamInfo[] = [];
  const paramsNode = findFirst(funcNode, 'function_value_parameters');
  if (!paramsNode) return params;

  for (const param of paramsNode.children) {
    if (param.type !== 'parameter') continue;
    const nameNode = findDirectChild(param, 'simple_identifier');
    const typeNode = param.childForFieldName('type');
    if (nameNode) {
      params.push({
        name: nameNode.text,
        type: typeNode?.text,
      });
    }
  }
  return params;
}

/** 从 .vue 文件中提取 <script> 或 <script setup> 块的纯 JS/TS 内容 */
function extractVueScriptBlock(vueContent: string): string | null {
  // 优先匹配普通 <script>（包含 lang="ts" 等属性），再匹配 <script setup>
  const patterns = [
    /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/i,
  ];
  for (const pattern of patterns) {
    const match = vueContent.match(pattern);
    if (match?.[1]?.trim()) return match[1];
  }
  return null;
}
