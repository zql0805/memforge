// Created by dev on 2026/06/02
// deep-index LLM 语义分析层 — 分层知识提取（小型全量 / 中大型概览+模块）

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger, loadLlmConfig } from '@memforgeai/shared';
import type { RepoAnalysis, ModuleInfo, SymbolInfo, InfraRef, CallEdge } from './types.js';

const logger = getLogger('deep-index:llm');

export type KnowledgeLevel = 'L0' | 'L1' | 'L2' | 'BIZ';

export interface KnowledgeItem {
  level: KnowledgeLevel;
  title: string;
  /** ≤500 字符的搜索友好摘要，用于 BM25/ILIKE 匹配和 embedding 向量化 */
  summary?: string;
  content: string;
  category: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

// ─── 分层配置 ──────────────────────────────────────────────────

const TIERING = {
  smallThreshold: 100,
  largeThreshold: 300,
  maxModulePassports: 10,
  maxCoreClassesPerModule: 10,
  maxMethodsPerClass: 8,
  overviewTopN: 20,
  maxContentChars: 8000,
  maxL2PerModule: 8,
  maxL2Total: 30,
  l2MinMethods: 3,
  l2MaxContentChars: 4000,
} as const;

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class DeepIndexAnalyzer {
  private config: LlmConfig | null;
  private callCount = 0;
  private budget: number;

  constructor(budget = 200) {
    this.config = loadLlmConfig();
    this.budget = budget;
    if (this.config) {
      logger.info({ model: this.config.model, budget }, 'deep-index LLM 分析器已初始化');
    } else {
      logger.warn('LLM 未配置，将跳过语义分析（仅生成结构化摘要）');
    }
  }

  get isAvailable(): boolean {
    return this.config !== null && this.callCount < this.budget;
  }

  get usedCalls(): number {
    return this.callCount;
  }

  /**
   * 分析整个仓库，所有项目统一走详细扫描：
   * - 1 概览 + N 模块档案（大型项目限制 Top N）
   * - L2（可选）：核心类/接口的独立知识条目
   * - BIZ（可选）：业务知识聚合条目
   */
  async analyzeAll(
    analysis: RepoAnalysis,
    repoId: string,
    opts?: { enableL2?: boolean; enableBusiness?: boolean },
  ): Promise<KnowledgeItem[]> {
    const totalSymbols = analysis.stats.totalSymbols;
    const category = `code-analysis/${repoId}`;

    const isLarge = totalSymbols > TIERING.largeThreshold;
    const ranked = rankModules(analysis);
    const moduleLimit = isLarge ? TIERING.maxModulePassports : ranked.length;
    const selectedModules = ranked.slice(0, moduleLimit);

    const sizeLabel = isLarge ? '大' : totalSymbols < TIERING.smallThreshold ? '小' : '中';
    logger.info(`[${repoId}] ${sizeLabel}型项目 (${totalSymbols} 符号) → 概览 + ${selectedModules.length} 模块档案`);

    const items: KnowledgeItem[] = [];

    // 1. 项目概览
    const overviewContent = buildProjectOverview(analysis, repoId);
    const overviewFinal = this.isAvailable
      ? (await this.callLlm(OVERVIEW_SYSTEM_PROMPT, `${overviewContent}\n\n请基于上述数据生成该服务的技术概览。保留所有统计、路由和基础设施信息。`)) ?? overviewContent
      : overviewContent;

    items.push({
      level: 'L0',
      title: `[项目概览] ${repoId}`,
      summary: buildL0Summary(analysis, repoId, selectedModules),
      content: adaptiveContentTrim(overviewFinal, TIERING.maxContentChars),
      category,
      tags: [`repo:${repoId}`, `lang:${analysis.lang}`, 'type:overview'],
      metadata: {
        level: 'L0', repoId, sourceType: 'deep_index', lang: analysis.lang,
        tier: isLarge ? 'large' : 'medium',
        stats: analysis.stats,
        moduleCount: selectedModules.length,
        llmAnalyzed: this.isAvailable,
      },
    });

    // 2. 模块档案
    for (const mod of selectedModules) {
      const modContent = buildModulePassport(mod, analysis, repoId);
      const modShortName = mod.path.split('.').pop() ?? mod.path.split('\\').pop() ?? mod.path;

      items.push({
        level: 'L1',
        title: `[模块] ${modShortName} (${repoId})`,
        summary: buildL1Summary(mod, analysis.callEdges, repoId),
        content: adaptiveContentTrim(modContent, TIERING.maxContentChars),
        category,
        tags: [`repo:${repoId}`, `module:${modShortName}`, 'type:module'],
        metadata: {
          level: 'L1', repoId, module: mod.path, sourceType: 'deep_index',
          stats: mod.stats,
        },
      });
    }

    // 3. L2 类级索引
    if (opts?.enableL2) {
      const l2Items = buildL2Items(analysis, repoId, category);
      items.push(...l2Items.slice(0, TIERING.maxL2Total));
      logger.info(`[${repoId}] L2 类级索引: ${Math.min(l2Items.length, TIERING.maxL2Total)} 条 (候选 ${l2Items.length})`);
    }

    // 4. 业务知识（BIZ）
    if (opts?.enableBusiness) {
      const bizItems = buildBusinessItems(analysis, repoId, category);
      items.push(...bizItems);
      logger.info(`[${repoId}] 业务知识: ${bizItems.length} 条`);
    }

    return items;
  }

  /** 小型项目：单条完整档案（保留原逻辑） */
  private async buildFullPassportItems(
    analysis: RepoAnalysis, repoId: string, category: string,
  ): Promise<KnowledgeItem[]> {
    const coreSymbols = selectCoreSymbols(analysis, 30, 8);
    const passport = buildFullPassport(analysis, repoId, coreSymbols);

    const content = this.isAvailable
      ? (await this.callLlm(OVERVIEW_SYSTEM_PROMPT, `${passport}\n\n请基于上述结构化信息，生成该服务的技术概览文档。保留所有核心类、方法签名和调用关系信息。`)) ?? passport
      : passport;

    logger.info(`[${repoId}] 完整档案生成: ${coreSymbols.length} 核心符号`);

    return [{
      level: 'L0',
      title: `[项目档案] ${repoId}`,
      summary: buildL0Summary(analysis, repoId, analysis.modules),
      content: adaptiveContentTrim(content, TIERING.maxContentChars),
      category,
      tags: [`repo:${repoId}`, `lang:${analysis.lang}`, 'type:full'],
      metadata: {
        level: 'L0', repoId, sourceType: 'deep_index', lang: analysis.lang,
        tier: 'small', stats: analysis.stats,
        coreSymbols: coreSymbols.map(s => s.qualifiedName),
        llmAnalyzed: this.isAvailable,
      },
    }];
  }

  private async callLlm(systemPrompt: string, userPrompt: string): Promise<string | null> {
    if (!this.config || this.callCount >= this.budget) return null;

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 2000,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'LLM API 调用失败');
        return null;
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };

      this.callCount++;
      return data.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'LLM 调用异常');
      return null;
    }
  }
}

// ─── 模块排序（加权评分，决定哪些模块生成档案） ──────────────

interface ModuleScore { mod: ModuleInfo; score: number; }

function rankModules(analysis: RepoAnalysis): ModuleInfo[] {
  const callEdges = analysis.callEdges;
  const scores: ModuleScore[] = [];

  for (const mod of analysis.modules) {
    const modFiles = new Set(mod.files.map(f => f.filePath));
    const modSymbols = new Set(mod.files.flatMap(f => f.symbols.map(s => s.qualifiedName)));

    let inboundCalls = 0;
    for (const edge of callEdges) {
      if (!modFiles.has(edge.filePath) && modSymbols.has(edge.callee)) inboundCalls++;
    }

    const infraCount = mod.files.reduce((sum, f) => sum + f.infraRefs.length, 0);
    const routeCount = mod.files.reduce((sum, f) =>
      sum + f.infraRefs.filter(r => r.type === 'route').length, 0);

    const score = mod.stats.methods * 0.3
      + inboundCalls * 0.3
      + infraCount * 0.2
      + routeCount * 0.2;

    scores.push({ mod, score });
  }

  return scores
    .sort((a, b) => b.score - a.score)
    .map(s => s.mod);
}

// ─── 核心符号选择 ────────────────────────────────────────────

function selectCoreSymbols(analysis: RepoAnalysis, limit: number, maxMethods: number): SymbolInfo[] {
  const topLevel = analysis.files.flatMap(f => f.symbols)
    .filter(s => !s.parent && (s.kind === 'class' || s.kind === 'interface'));

  const methodCounts = new Map<string, number>();
  for (const f of analysis.files) {
    for (const s of f.symbols) {
      if (s.kind === 'method' && s.parent) {
        const key = f.symbols.find(p => p.name === s.parent && !p.parent)?.qualifiedName ?? s.parent;
        methodCounts.set(key, (methodCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const IMPORTANT_ANNOTATIONS = ['@Controller', '@Service', '@Component', '@RestController',
    '@MoaProvider', '@MoaConsumer', '@KafkaListener', '@Configuration'];

  return topLevel.filter(s => {
    const mc = methodCounts.get(s.qualifiedName) ?? 0;
    if (mc >= 3) return true;
    if (s.annotations.some(a => IMPORTANT_ANNOTATIONS.some(ia => a.includes(ia)))) return true;
    return false;
  }).slice(0, limit);
}

/** 从模块内选择核心符号 */
function selectModuleCoreSymbols(mod: ModuleInfo, callEdges: CallEdge[]): SymbolInfo[] {
  const topLevel = mod.files.flatMap(f => f.symbols)
    .filter(s => !s.parent && (s.kind === 'class' || s.kind === 'interface'));

  const methodCounts = new Map<string, number>();
  const inboundCounts = new Map<string, number>();

  for (const f of mod.files) {
    for (const s of f.symbols) {
      if (s.kind === 'method' && s.parent) {
        const key = f.symbols.find(p => p.name === s.parent && !p.parent)?.qualifiedName ?? s.parent;
        methodCounts.set(key, (methodCounts.get(key) ?? 0) + 1);
      }
    }
  }

  for (const edge of callEdges) {
    for (const sym of topLevel) {
      if (edge.callee.startsWith(sym.qualifiedName + '.') || edge.callee === sym.qualifiedName) {
        inboundCounts.set(sym.qualifiedName, (inboundCounts.get(sym.qualifiedName) ?? 0) + 1);
      }
    }
  }

  return topLevel
    .map(s => ({
      sym: s,
      score: (methodCounts.get(s.qualifiedName) ?? 0) * 0.5
        + (inboundCounts.get(s.qualifiedName) ?? 0) * 0.5,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TIERING.maxCoreClassesPerModule)
    .map(s => s.sym);
}

// ─── Prompt 模板 ─────────────────────────────────────────────

const OVERVIEW_SYSTEM_PROMPT = `你是一个技术文档专家。根据提供的代码仓库结构化分析数据，生成一份清晰的**服务技术概览**。

输出格式（Markdown）：
## 服务定位
一句话描述该服务的核心职责。

## 技术栈
- 语言/框架
- 主要依赖

## 模块架构
按功能模块列出（表格：模块路径 | 职责 | 核心类/接口数）

## 对外接口
- API 路由（如有）
- RPC 服务（如有）
- 消息队列（如有）

## 基础设施依赖
- 数据库表（如有）
- Redis 集群/Key 模式（如有）
- 外部服务调用

## 设计亮点与注意事项

要求：简洁、准确、不编造信息。只基于提供的数据分析。`;

// ─── 项目概览构建器（紧凑，不含方法签名） ────────────────────

function buildProjectOverview(analysis: RepoAnalysis, repoId: string): string {
  const p: string[] = [];
  p.push(`# ${repoId} (${analysis.lang})`);
  p.push('');

  // README 首段
  const readmeSummary = extractReadmeSummary(analysis.repoPath);
  if (readmeSummary) {
    p.push(`> ${readmeSummary}`);
    p.push('');
  }

  p.push('## 统计');
  p.push(`${analysis.stats.filesScanned} 文件, ${analysis.stats.totalSymbols} 符号, ${analysis.stats.totalCallEdges} 调用关系, ${analysis.stats.totalInfraRefs} 基础设施引用`);
  p.push('');

  // 模块表格
  if (analysis.modules.length > 0) {
    p.push('## 模块结构');
    p.push('| 模块 | 类 | 接口 | 方法 | 文件 |');
    p.push('|---|---|---|---|---|');
    for (const mod of analysis.modules) {
      const shortName = mod.path.split('.').slice(-2).join('.') || mod.path;
      p.push(`| ${shortName} | ${mod.stats.classes} | ${mod.stats.interfaces} | ${mod.stats.methods} | ${mod.files.length} |`);
    }
    p.push('');
  }

  // API 路由
  const routes = analysis.infraRefs.filter(r => r.type === 'route');
  if (routes.length > 0) {
    p.push('## API 路由');
    for (const r of routes.slice(0, TIERING.overviewTopN)) {
      p.push(`- ${r.context ?? ''} ${r.value}`);
    }
    if (routes.length > TIERING.overviewTopN) p.push(`- ...及 ${routes.length - TIERING.overviewTopN} 个路由`);
    p.push('');
  }

  // 调用热点
  if (analysis.callEdges.length > 0) {
    p.push('## 调用热点');
    const calleeCount = new Map<string, number>();
    for (const edge of analysis.callEdges) {
      calleeCount.set(edge.callee, (calleeCount.get(edge.callee) ?? 0) + 1);
    }
    const topCallees = [...calleeCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [name, count] of topCallees) {
      p.push(`- ${name}: ${count}次`);
    }
    p.push('');
  }

  // 基础设施
  const nonRouteInfra = analysis.infraRefs.filter(r => r.type !== 'route');
  if (nonRouteInfra.length > 0) {
    p.push('## 基础设施');
    const grouped = groupByType(nonRouteInfra);
    for (const [type, refs] of grouped) {
      p.push(`- **${type}**: ${refs.map(r => r.value).join(', ')}`);
    }
    p.push('');
  }

  // 关键配置项
  const configKeys = analysis.infraRefs.filter(r => r.type === 'config_key');
  if (configKeys.length > 0) {
    p.push('## 关键配置');
    for (const c of configKeys.slice(0, 10)) {
      p.push(`- ${c.value}`);
    }
  }

  return p.join('\n');
}

// ─── 模块档案构建器（含方法签名和调用关系） ────────────────

function buildModulePassport(mod: ModuleInfo, analysis: RepoAnalysis, repoId: string): string {
  const p: string[] = [];
  const modShortName = mod.path.split('.').pop() ?? mod.path.split('\\').pop() ?? mod.path;
  p.push(`# [${repoId}] 模块: ${modShortName}`);
  p.push(`完整路径: ${mod.path}`);
  p.push(`统计: ${mod.stats.classes}类 ${mod.stats.interfaces}接口 ${mod.stats.methods}方法 (${mod.files.length}文件)`);
  p.push('');

  // 核心类详情
  const coreSymbols = selectModuleCoreSymbols(mod, analysis.callEdges);
  const allModSymbols = mod.files.flatMap(f => f.symbols);

  if (coreSymbols.length > 0) {
    p.push('## 核心类/接口');

    for (const sym of coreSymbols) {
      const methods = allModSymbols.filter(s => s.parent === sym.name && s.kind === 'method');
      const methodSigs = methods.slice(0, TIERING.maxMethodsPerClass).map(m => {
        const params = (m.params ?? []).map(pm => `${pm.type ?? '?'} ${pm.name}`).join(', ');
        const sig = `${m.returnType ?? 'void'} ${m.name}(${params})`;
        const docHint = extractDocFirstLine(m.doc);
        return docHint ? `${sig} // ${docHint}` : sig;
      });

      p.push(`### ${sym.name} (${sym.kind})`);
      if (sym.annotations?.length) p.push(`注解: ${sym.annotations.join(', ')}`);
      if (sym.extends) p.push(`继承: ${sym.extends}`);
      if (sym.implements?.length) p.push(`实现: ${sym.implements.join(', ')}`);
      if (sym.doc) p.push(`说明: ${compactDoc(sym.doc, 3)}`);

      if (methodSigs.length > 0) {
        p.push('方法:');
        for (const sig of methodSigs) p.push(`  - ${sig}`);
        if (methods.length > TIERING.maxMethodsPerClass) {
          p.push(`  - ...及 ${methods.length - TIERING.maxMethodsPerClass} 个方法`);
        }
      }

      // 调用上下文
      const callees = new Set<string>();
      const callers = new Set<string>();
      for (const edge of analysis.callEdges) {
        if (edge.caller.startsWith(sym.qualifiedName + '.') || edge.caller === sym.qualifiedName) {
          callees.add(edge.calleeRaw);
        }
        if (edge.callee.startsWith(sym.qualifiedName + '.') || edge.callee === sym.qualifiedName) {
          callers.add(edge.caller.split('.').slice(-2).join('.'));
        }
      }
      if (callees.size > 0) p.push(`调用→ ${[...callees].slice(0, 8).join(', ')}`);
      if (callers.size > 0) p.push(`被调用← ${[...callers].slice(0, 8).join(', ')}`);
      p.push('');
    }
  }

  // 模块间调用关系汇总
  const modFiles = new Set(mod.files.map(f => f.filePath));
  const modSymbolSet = new Set(allModSymbols.map(s => s.qualifiedName));
  const outbound = new Set<string>();
  let inboundCount = 0;

  for (const edge of analysis.callEdges) {
    const callerInMod = modFiles.has(edge.filePath);
    const calleeInMod = modSymbolSet.has(edge.callee);
    if (!callerInMod && calleeInMod) inboundCount++;
    if (callerInMod && !calleeInMod && edge.callee.includes('.')) outbound.add(edge.calleeRaw);
  }

  if (inboundCount > 0 || outbound.size > 0) {
    p.push('## 模块间调用');
    if (inboundCount > 0) p.push(`- 被外部调用 ${inboundCount} 次`);
    if (outbound.size > 0) {
      p.push(`- 外部依赖 ${outbound.size} 个:`);
      for (const c of [...outbound].slice(0, 10)) p.push(`  - ${c}`);
    }
    p.push('');
  }

  // 基础设施
  const infraRefs = mod.files.flatMap(f => f.infraRefs);
  if (infraRefs.length > 0) {
    p.push('## 基础设施');
    const grouped = groupByType(infraRefs);
    for (const [type, refs] of grouped) {
      p.push(`- **${type}**: ${refs.map(r => r.value).join(', ')}`);
    }
  }

  return p.join('\n');
}

// ─── 完整档案构建器（小型项目，合并所有信息） ───────────────

function buildFullPassport(analysis: RepoAnalysis, repoId: string, coreSymbols: SymbolInfo[]): string {
  const p: string[] = [];
  p.push(`# ${repoId} (${analysis.lang})`);
  p.push('');

  const readmeSummary = extractReadmeSummary(analysis.repoPath);
  if (readmeSummary) {
    p.push(`> ${readmeSummary}`);
    p.push('');
  }

  p.push('## 概览');
  p.push(`${analysis.stats.filesScanned} 文件, ${analysis.stats.totalSymbols} 符号, ${analysis.stats.totalCallEdges} 调用关系, ${analysis.stats.totalInfraRefs} 基础设施引用`);
  p.push('');

  if (analysis.modules.length > 0) {
    p.push('## 模块结构');
    for (const mod of analysis.modules) {
      p.push(`- **${mod.path}**: ${mod.stats.classes}类 ${mod.stats.interfaces}接口 ${mod.stats.methods}方法 (${mod.files.length}文件)`);
    }
    p.push('');
  }

  if (coreSymbols.length > 0) {
    p.push('## 核心类/接口');
    const allSymbols = analysis.files.flatMap(f => f.symbols);
    for (const sym of coreSymbols) {
      const methods = allSymbols.filter(s => s.parent === sym.name && s.kind === 'method');
      const methodSigs = methods.slice(0, 8).map(m => {
        const params = (m.params ?? []).map(pm => `${pm.type ?? '?'} ${pm.name}`).join(', ');
        const sig = `${m.returnType ?? 'void'} ${m.name}(${params})`;
        const docHint = extractDocFirstLine(m.doc);
        return docHint ? `${sig} // ${docHint}` : sig;
      });

      p.push(`### ${sym.name} (${sym.kind})`);
      if (sym.annotations?.length) p.push(`注解: ${sym.annotations.join(', ')}`);
      if (sym.extends) p.push(`继承: ${sym.extends}`);
      if (sym.implements?.length) p.push(`实现: ${sym.implements.join(', ')}`);
      if (sym.doc) p.push(`说明: ${compactDoc(sym.doc, 3)}`);
      p.push(`qualifiedName: ${sym.qualifiedName}`);
      if (methodSigs.length > 0) {
        p.push('方法:');
        for (const sig of methodSigs) p.push(`  - ${sig}`);
        if (methods.length > 8) p.push(`  - ...及 ${methods.length - 8} 个方法`);
      }

      if (analysis.callEdges.length > 0) {
        const callees = new Set<string>();
        const callers = new Set<string>();
        for (const edge of analysis.callEdges) {
          if (edge.caller.startsWith(sym.qualifiedName + '.') || edge.caller === sym.qualifiedName) callees.add(edge.calleeRaw);
          if (edge.callee.startsWith(sym.qualifiedName + '.') || edge.callee === sym.qualifiedName) callers.add(edge.caller.split('.').slice(-2).join('.'));
        }
        if (callees.size > 0) p.push(`调用→ ${[...callees].slice(0, 10).join(', ')}`);
        if (callers.size > 0) p.push(`被调用← ${[...callers].slice(0, 10).join(', ')}`);
      }
      p.push('');
    }
  }

  if (analysis.callEdges.length > 0) {
    p.push('## 调用热点');
    const calleeCount = new Map<string, number>();
    for (const edge of analysis.callEdges) {
      calleeCount.set(edge.callee, (calleeCount.get(edge.callee) ?? 0) + 1);
    }
    for (const [name, count] of [...calleeCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      p.push(`- ${name}: ${count}次`);
    }
    p.push('');
  }

  if (analysis.infraRefs.length > 0) {
    p.push('## 基础设施');
    const grouped = groupByType(analysis.infraRefs);
    for (const [type, refs] of grouped) {
      p.push(`- **${type}**: ${refs.map(r => r.value).join(', ')}`);
    }
  }

  return p.join('\n');
}

// ─── 内容自适应截断 ─────────────────────────────────────────

function adaptiveContentTrim(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  const lines = content.split('\n');
  const sections: { header: string; start: number; end: number }[] = [];
  let current = { header: '(top)', start: 0, end: 0 };

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      current.end = i;
      sections.push({ ...current });
      current = { header: lines[i], start: i, end: i };
    }
  }
  current.end = lines.length;
  sections.push(current);

  // 按优先级保留段落：标题/概览 > 核心类 > 路由/基础设施 > 调用热点 > 模块间调用
  const priorityKeywords = ['概览', '统计', '定位', '核心', '路由', 'API', '基础设施', '调用热点', '模块'];
  const prioritized = sections
    .map((s, idx) => {
      const text = lines.slice(s.start, s.end).join('\n');
      const priority = idx === 0 ? 100 : // 顶部段落最高优先
        priorityKeywords.findIndex(kw => s.header.includes(kw));
      return { ...s, text, priority: priority >= 0 ? 10 - priority : -1 };
    })
    .sort((a, b) => b.priority - a.priority);

  let result = '';
  for (const sec of prioritized) {
    if (result.length + sec.text.length + 1 > maxChars) {
      if (result.length < maxChars * 0.5) {
        const remaining = maxChars - result.length - 50;
        if (remaining > 200) {
          result += '\n' + sec.text.slice(0, remaining) + '\n...（内容已截断）';
        }
      }
      break;
    }
    result += (result ? '\n' : '') + sec.text;
  }

  return result || content.slice(0, maxChars);
}

// ─── 工具 ────────────────────────────────────────────────────

function groupByType(refs: InfraRef[]): Map<string, InfraRef[]> {
  const map = new Map<string, InfraRef[]>();
  for (const ref of refs) {
    if (!map.has(ref.type)) map.set(ref.type, []);
    map.get(ref.type)!.push(ref);
  }
  return map;
}

function extractReadmeSummary(repoPath: string): string | null {
  for (const name of ['README.md', 'readme.md', 'README.MD']) {
    const p = join(repoPath, name);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('!'));
        const first = lines[0]?.trim();
        if (first && first.length > 10 && first.length < 200 && !isGarbageReadmeLine(first)) return first;
      } catch { /* skip */ }
    }
  }
  return null;
}

const GARBAGE_CAPABILITY_ITEM = /^[A-Z][a-z]{1,5}\s+(\d{4}\b|[a-z])/;

function isGarbageReadmeLine(line: string): boolean {
  if (/核心能力包括[：:]/.test(line)) {
    const items = line.replace(/^.*核心能力包括[：:]\s*/, '').split(/[；;,，]/);
    const garbageCount = items.filter(s => {
      const t = s.trim();
      return !t || GARBAGE_CAPABILITY_ITEM.test(t) || (t.length < 20 && !/[\u4e00-\u9fff]/.test(t));
    }).length;
    if (garbageCount > items.length * 0.5) return true;
  }
  if (/^(Product|Platform|App)\s+(PHP|Java|Node)\s+服务[，,。.]?\s*$/.test(line)) return true;
  if (/^A vue admin template with Element UI/i.test(line)) return true;
  return false;
}

/** 压缩 doc comment，保留最多 maxLines 行有效内容，去除 Javadoc 标记噪声 */
function compactDoc(doc: string, maxLines: number): string {
  const lines = doc
    .split('\n')
    .map(l => l.replace(/^\s*\*\s?/, '').replace(/^\/\*\*\s*/, '').replace(/\s*\*\/\s*$/, '').trim())
    .filter(l => l && !l.startsWith('@param') && !l.startsWith('@throws') && !l.startsWith('@see'));
  return lines.slice(0, maxLines).join(' | ');
}

/** IDE 模板噪声词，匹配到则视为无效 doc */
const IDE_BOILERPLATE = /^(created by (phpstorm|intellij|webstorm|vscode)|auto[- ]?generated|todo|fixme|hack)/i;

/** 提取 doc comment 的第一行有效文本（去除 Javadoc 格式标记和 IDE 模板噪声） */
function extractDocFirstLine(doc: string | undefined): string | null {
  if (!doc) return null;
  const lines = doc
    .split('\n')
    .map(l => l.replace(/^\s*\/\/+\s?/, '').replace(/^\s*\*\s?/, '').replace(/^\/\*\*\s*/, '').replace(/\s*\*\/\s*$/, '').trim())
    .filter(l => l && !l.startsWith('@'));
  const first = lines[0];
  if (!first || first.length < 2) return null;
  if (IDE_BOILERPLATE.test(first)) return null;
  return first.length > 60 ? first.slice(0, 57) + '...' : first;
}

/** 从 PHP 下划线类名推断业务含义 (Pay_Firstcharge → 首充支付) */
function inferPhpClassName(name: string): string | null {
  const TERM_MAP: Record<string, string> = {
    firstcharge: '首充', charge: '充值', recharge: '充值', pay: '支付', payment: '支付',
    room: '房间', user: '用户', gift: '礼物', wallet: '钱包', diamond: '钻石',
    activity: '活动', rebate: '返利', reward: '奖励', task: '任务', family: '家族',
    guild: '工会', salary: '薪资', pk: 'PK', game: '游戏', lottery: '抽奖',
    rank: '排行', level: '档位', vip: 'VIP', stat: '统计', editor: '编辑器',
    dao: '数据访问', controller: '控制器', service: '服务', model: '模型',
    admin: '管理', config: '配置', msg: '消息', im: '消息', login: '登录',
    ban: '封禁', report: '举报', audit: '审核', feed: '动态', profile: '资料',
    follow: '关注', invite: '邀请', share: '分享', push: '推送', notice: '通知',
    order: '订单', subsidy: '补贴', coupon: '优惠券', exchange: '兑换',
  };

  const segments = name.split('_').map(s => s.toLowerCase());
  const translated: string[] = [];
  for (const seg of segments) {
    if (TERM_MAP[seg]) translated.push(TERM_MAP[seg]);
    else if (seg.length > 2) {
      for (const [key, val] of Object.entries(TERM_MAP)) {
        if (seg.includes(key)) { translated.push(val); break; }
      }
    }
  }
  return translated.length > 0 ? [...new Set(translated)].join('') : null;
}

/** 从方法名列表推断业务含义 */
function inferBusinessFromMethods(methods: SymbolInfo[]): string | null {
  const METHOD_HINTS: Record<string, string> = {
    firstcharge: '首充', charge: '充值', recharge: '充值', pay: '支付',
    reward: '奖励', gift: '礼物', diamond: '钻石', rebate: '返利',
    lottery: '抽奖', rank: '排行', level: '档位',
  };
  const found = new Set<string>();
  for (const m of methods) {
    const lower = m.name.toLowerCase();
    for (const [key, val] of Object.entries(METHOD_HINTS)) {
      if (lower.includes(key)) found.add(val);
    }
  }
  return found.size > 0 ? [...found].join('/') : null;
}

// ─── L2 类级索引构建 ────────────────────────────────────────

const L2_IMPORTANT_SUFFIXES = [
  'Controller', 'Service', 'ServiceImpl', 'Dao', 'DaoImpl', 'Repository', 'Mapper',
  'Orchestrator', 'Handler', 'Validator', 'Calculator', 'Processor', 'Provider',
];

const L2_IMPORTANT_ANNOTATIONS = [
  '@Service', '@MoaProvider', '@MoaConsumer', '@Controller', '@RestController',
  '@Repository', '@Component', '@KafkaListener', '@Configuration',
];

const CJK_PATTERN = /[\u4e00-\u9fff]{2,}/;

interface L2Candidate {
  sym: SymbolInfo;
  score: number;
  methods: SymbolInfo[];
  inboundCount: number;
  modulePath: string;
}

function buildL2Items(analysis: RepoAnalysis, repoId: string, category: string): KnowledgeItem[] {
  const allSymbols = analysis.files.flatMap(f => f.symbols);
  const topLevel = allSymbols.filter(s => !s.parent && (s.kind === 'class' || s.kind === 'interface'));

  const methodMap = new Map<string, SymbolInfo[]>();
  for (const sym of allSymbols) {
    if (sym.kind === 'method' && sym.parent) {
      const parentQN = topLevel.find(p => p.name === sym.parent)?.qualifiedName ?? sym.parent;
      if (!methodMap.has(parentQN)) methodMap.set(parentQN, []);
      methodMap.get(parentQN)!.push(sym);
    }
  }

  const inboundCounts = new Map<string, number>();
  for (const edge of analysis.callEdges) {
    for (const sym of topLevel) {
      if (edge.callee.startsWith(sym.qualifiedName + '.') || edge.callee === sym.qualifiedName) {
        inboundCounts.set(sym.qualifiedName, (inboundCounts.get(sym.qualifiedName) ?? 0) + 1);
      }
    }
  }

  const symToModule = new Map<string, string>();
  for (const mod of analysis.modules) {
    const modFiles = new Set(mod.files.map(f => f.filePath));
    for (const sym of topLevel) {
      if (modFiles.has(sym.filePath)) symToModule.set(sym.qualifiedName, mod.path);
    }
  }

  const candidates: L2Candidate[] = [];

  for (const sym of topLevel) {
    const methods = methodMap.get(sym.qualifiedName) ?? [];
    const inbound = inboundCounts.get(sym.qualifiedName) ?? 0;
    const hasSuffix = L2_IMPORTANT_SUFFIXES.some(s => sym.name.endsWith(s));
    const hasAnnotation = sym.annotations.some(a => L2_IMPORTANT_ANNOTATIONS.some(ia => a.includes(ia)));
    const hasChinese = sym.doc ? CJK_PATTERN.test(sym.doc) : false;
    const isMoaProvider = sym.annotations.some(a => a.includes('MoaProvider') || a.includes('MoaConsumer'));

    // PHP 类无注解，通过类名业务推断补偿
    const hasPhpBusinessName = !hasAnnotation && inferPhpClassName(sym.name) !== null;

    const eligible =
      (methods.length >= 5 && (hasAnnotation || hasSuffix)) ||
      inbound >= 3 ||
      hasChinese ||
      isMoaProvider ||
      (hasSuffix && methods.length >= TIERING.l2MinMethods) ||
      (hasPhpBusinessName && methods.length >= TIERING.l2MinMethods);

    if (!eligible) continue;

    const score = methods.length * 0.3
      + inbound * 0.3
      + (hasAnnotation ? 2 : 0)
      + (hasChinese ? 1.5 : 0)
      + (isMoaProvider ? 2 : 0)
      + (hasPhpBusinessName ? 1 : 0);

    candidates.push({
      sym, score, methods, inboundCount: inbound,
      modulePath: symToModule.get(sym.qualifiedName) ?? '',
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  // 按模块限流
  const moduleCount = new Map<string, number>();
  const selected: L2Candidate[] = [];

  for (const c of candidates) {
    const modCount = moduleCount.get(c.modulePath) ?? 0;
    if (modCount >= TIERING.maxL2PerModule) continue;
    moduleCount.set(c.modulePath, modCount + 1);
    selected.push(c);
    if (selected.length >= TIERING.maxL2Total) break;
  }

  return selected.map(c => {
    const content = buildL2Content(c, analysis, repoId);
    const docFirst = extractDocFirstLine(c.sym.doc);
    const phpInfer = !docFirst ? inferPhpClassName(c.sym.name) : null;
    const methodInfer = !docFirst && !phpInfer ? inferBusinessFromMethods(c.methods) : null;
    const classDesc = docFirst ?? phpInfer ?? methodInfer ?? c.sym.kind;
    const methodNames = c.methods.slice(0, 5).map(m => m.name);

    return {
      level: 'L2' as KnowledgeLevel,
      title: `[类] ${c.sym.name} (${repoId})`,
      summary: [
        `${c.sym.name}: ${classDesc}`,
        methodNames.length > 0 ? `方法: ${methodNames.join(', ')}` : '',
        c.sym.annotations.length > 0 ? c.sym.annotations.slice(0, 3).join(', ') : '',
      ].filter(Boolean).join('。').slice(0, 500),
      content: adaptiveContentTrim(content, TIERING.l2MaxContentChars),
      category,
      tags: [
        `repo:${repoId}`,
        `class:${c.sym.name}`,
        'type:class',
        ...(c.sym.doc && CJK_PATTERN.test(c.sym.doc) ? ['has-chinese-doc'] : []),
      ],
      metadata: {
        level: 'L2', repoId, sourceType: 'deep_index',
        className: c.sym.name,
        qualifiedName: c.sym.qualifiedName,
        methodCount: c.methods.length,
        inboundCalls: c.inboundCount,
        module: c.modulePath,
      },
    };
  });
}

function buildL2Content(candidate: L2Candidate, analysis: RepoAnalysis, repoId: string): string {
  const { sym, methods } = candidate;
  const p: string[] = [];

  p.push(`# ${sym.name} (${repoId})`);
  const docFirst = extractDocFirstLine(sym.doc) ?? inferPhpClassName(sym.name);
  if (docFirst) p.push(`> ${docFirst}`);
  p.push('');

  p.push('## 基本信息');
  p.push(`- 包路径: ${sym.qualifiedName}`);
  if (sym.annotations.length > 0) p.push(`- 注解: ${sym.annotations.join(', ')}`);
  if (sym.extends) p.push(`- 继承: ${sym.extends}`);
  if (sym.implements?.length) p.push(`- 实现: ${sym.implements.join(', ')}`);
  if (candidate.modulePath) p.push(`- 所属模块: ${candidate.modulePath}`);
  p.push('');

  if (methods.length > 0) {
    p.push(`## 方法列表（${methods.length} 个）`);
    for (const m of methods.slice(0, TIERING.maxMethodsPerClass)) {
      const params = (m.params ?? []).map(pm => `${pm.type ?? '?'} ${pm.name}`).join(', ');
      const sig = `${m.returnType ?? 'void'} ${m.name}(${params})`;
      const hint = extractDocFirstLine(m.doc);
      p.push(hint ? `- ${sig} // ${hint}` : `- ${sig}`);
    }
    if (methods.length > TIERING.maxMethodsPerClass) {
      p.push(`- ...及 ${methods.length - TIERING.maxMethodsPerClass} 个方法`);
    }
    p.push('');
  }

  // 调用关系
  const callees = new Set<string>();
  const callers = new Set<string>();
  for (const edge of analysis.callEdges) {
    if (edge.caller.startsWith(sym.qualifiedName + '.') || edge.caller === sym.qualifiedName) {
      callees.add(edge.calleeRaw);
    }
    if (edge.callee.startsWith(sym.qualifiedName + '.') || edge.callee === sym.qualifiedName) {
      callers.add(edge.caller.split('.').slice(-2).join('.'));
    }
  }
  if (callees.size > 0 || callers.size > 0) {
    p.push('## 调用关系');
    if (callees.size > 0) p.push(`- 调用→: ${[...callees].slice(0, 8).join(', ')}`);
    if (callers.size > 0) p.push(`- 被调用←: ${[...callers].slice(0, 8).join(', ')}`);
    p.push('');
  }

  // 基础设施
  const fileInfra = analysis.files
    .filter(f => f.filePath === sym.filePath)
    .flatMap(f => f.infraRefs);
  if (fileInfra.length > 0) {
    p.push('## 基础设施');
    const grouped = new Map<string, string[]>();
    for (const ref of fileInfra) {
      if (!grouped.has(ref.type)) grouped.set(ref.type, []);
      grouped.get(ref.type)!.push(ref.value);
    }
    for (const [type, values] of grouped) {
      p.push(`- ${type}: ${[...new Set(values)].join(', ')}`);
    }
  }

  return p.join('\n');
}

// ─── Business 业务知识构建 ──────────────────────────────────

interface BusinessFeature {
  name: string;
  description: string;
  classes: Array<{ name: string; doc: string; methods: string[] }>;
  infra: InfraRef[];
  docs: string[];
}

function buildBusinessItems(analysis: RepoAnalysis, repoId: string, category: string): KnowledgeItem[] {
  const features = extractBusinessFeatures(analysis, repoId);
  return features.map(feat => {
    const content = buildBusinessContent(feat, repoId);
    const classList = feat.classes.map(c => c.name).join(', ');

    return {
      level: 'BIZ' as KnowledgeLevel,
      title: `[业务] ${feat.name} (${repoId})`,
      summary: `${feat.name}: ${feat.description}。核心类: ${classList}`.slice(0, 500),
      content,
      category,
      tags: [
        `repo:${repoId}`,
        'business-feature',
        `biz:${feat.name.replace(/\s+/g, '-').toLowerCase()}`,
      ],
      metadata: {
        level: 'BIZ', repoId, sourceType: 'deep_index',
        featureName: feat.name,
        classCount: feat.classes.length,
      },
    };
  });
}

function extractBusinessFeatures(analysis: RepoAnalysis, repoId: string): BusinessFeature[] {
  const allSymbols = analysis.files.flatMap(f => f.symbols);
  const topLevel = allSymbols.filter(s => !s.parent && (s.kind === 'class' || s.kind === 'interface'));

  // 按中文关键词聚类
  const keywordMap = new Map<string, SymbolInfo[]>();

  for (const sym of topLevel) {
    if (!sym.doc) continue;
    const matches = sym.doc.match(/[\u4e00-\u9fff]{2,}/g);
    if (!matches) continue;

    // 取最有意义的中文短语（>= 3 字符，排除常见噪声词）
    const NOISE = ['注解', '实现', '接口', '抽象', '基类', '工具', '常量', '枚举', '配置', '日期', '作者'];
    const keywords = matches
      .filter(kw => kw.length >= 3 && !NOISE.includes(kw))
      .slice(0, 3);

    for (const kw of keywords) {
      if (!keywordMap.has(kw)) keywordMap.set(kw, []);
      keywordMap.get(kw)!.push(sym);
    }
  }

  // 按类名词根聚类
  const stemGroups = new Map<string, SymbolInfo[]>();
  for (const sym of topLevel) {
    const stem = extractNameStem(sym.name);
    if (stem && stem.length >= 5) {
      if (!stemGroups.has(stem)) stemGroups.set(stem, []);
      stemGroups.get(stem)!.push(sym);
    }
  }

  // 合并: 中文关键词组 + 类名词根组
  const features: BusinessFeature[] = [];
  const usedSymbols = new Set<string>();

  // 优先处理中文关键词聚类（更具业务语义）
  for (const [keyword, syms] of keywordMap) {
    if (syms.length < 2) continue;
    const unused = syms.filter(s => !usedSymbols.has(s.qualifiedName));
    if (unused.length < 2) continue;

    const methods = allSymbols.filter(s => s.kind === 'method' && unused.some(u => u.name === s.parent));
    const infraRefs = analysis.files
      .filter(f => unused.some(s => s.filePath === f.filePath))
      .flatMap(f => f.infraRefs);

    features.push({
      name: keyword,
      description: unused.map(s => extractDocFirstLine(s.doc)).filter(Boolean).join('；'),
      classes: unused.map(s => ({
        name: s.name,
        doc: extractDocFirstLine(s.doc) ?? '',
        methods: methods.filter(m => m.parent === s.name).map(m => m.name).slice(0, 5),
      })),
      infra: infraRefs,
      docs: findRelatedDocs(analysis.repoPath, keyword),
    });

    for (const s of unused) usedSymbols.add(s.qualifiedName);
  }

  // 补充类名词根聚类（增强：PHP 项目 doc 为空时用类名/方法名推断）
  for (const [stem, syms] of stemGroups) {
    if (syms.length < 2) continue;
    const unused = syms.filter(s => !usedSymbols.has(s.qualifiedName));
    if (unused.length < 2) continue;

    const methods = allSymbols.filter(s => s.kind === 'method' && unused.some(u => u.name === s.parent));

    // 多层描述推断：doc → PHP类名翻译 → 方法名推断
    const descParts: string[] = [];
    for (const s of unused) {
      const docLine = extractDocFirstLine(s.doc);
      if (docLine) { descParts.push(docLine); continue; }
      const phpInfer = inferPhpClassName(s.name);
      if (phpInfer) { descParts.push(phpInfer); continue; }
      const methodInfer = inferBusinessFromMethods(methods.filter(m => m.parent === s.name));
      if (methodInfer) descParts.push(`${s.name}(${methodInfer})`);
    }
    if (descParts.length === 0) continue;

    const infraRefs = analysis.files
      .filter(f => unused.some(s => s.filePath === f.filePath))
      .flatMap(f => f.infraRefs);

    // BIZ 名称优化：优先用中文翻译
    const phpName = inferPhpClassName(stem) ?? camelToReadable(stem);

    features.push({
      name: phpName,
      description: [...new Set(descParts)].join('；'),
      classes: unused.map(s => ({
        name: s.name,
        doc: extractDocFirstLine(s.doc) ?? inferPhpClassName(s.name) ?? '',
        methods: methods.filter(m => m.parent === s.name).map(m => m.name).slice(0, 5),
      })),
      infra: infraRefs,
      docs: findRelatedDocs(analysis.repoPath, stem),
    });

    for (const s of unused) usedSymbols.add(s.qualifiedName);
  }

  return features;
}

function buildBusinessContent(feat: BusinessFeature, repoId: string): string {
  const p: string[] = [];

  p.push(`# ${feat.name}（${repoId}）`);
  p.push(`> ${feat.description}`);
  p.push('');

  p.push('## 核心类');
  for (const cls of feat.classes) {
    p.push(`- **${cls.name}**: ${cls.doc}`);
    if (cls.methods.length > 0) p.push(`  - 关键方法: ${cls.methods.join(', ')}`);
  }
  p.push('');

  if (feat.infra.length > 0) {
    p.push('## 基础设施');
    const grouped = new Map<string, string[]>();
    for (const ref of feat.infra) {
      if (!grouped.has(ref.type)) grouped.set(ref.type, []);
      grouped.get(ref.type)!.push(ref.value);
    }
    for (const [type, values] of grouped) {
      p.push(`- ${type}: ${[...new Set(values)].join(', ')}`);
    }
    p.push('');
  }

  if (feat.docs.length > 0) {
    p.push('## 关联文档');
    for (const doc of feat.docs) p.push(`- ${doc}`);
  }

  return p.join('\n');
}

function extractNameStem(name: string): string {
  const SUFFIX_WORDS = new Set(['Service', 'Impl', 'Controller', 'Dao', 'Repository', 'Mapper',
    'Handler', 'Validator', 'Calculator', 'Processor', 'Orchestrator', 'Provider', 'Consumer',
    'Editor', 'Stat', 'Api', 'Moa', 'Act', 'Model']);

  // PHP 下划线命名: Pay_Charge, Api_Live_Room_Controller
  if (name.includes('_')) {
    const segments = name.split('_');
    const meaningful = segments.filter(s => !SUFFIX_WORDS.has(s));
    return meaningful.join('');
  }

  // Java CamelCase: ChargeLevelOrchestrator
  const parts = name.replace(/([A-Z])/g, ' $1').trim().split(/\s+/);
  const meaningful = parts.filter(p => !SUFFIX_WORDS.has(p));
  return meaningful.join('');
}

function camelToReadable(stem: string): string {
  return stem.replace(/([A-Z])/g, ' $1').trim();
}

function findRelatedDocs(repoPath: string, keyword: string): string[] {
  const docsDir = join(repoPath, 'docs', 'feature');
  const results: string[] = [];
  try {
    if (!existsSync(docsDir)) return results;
    const files = readdirSync(docsDir);
    for (const f of files) {
      if (f.endsWith('.md') && f.toLowerCase().includes(keyword.toLowerCase())) {
        results.push(`docs/feature/${f}`);
      }
    }
  } catch { /* skip */ }
  return results;
}

// ─── Summary 生成器 ──────────────────────────────────────────

const MAX_SUMMARY = 500;

function buildL0Summary(analysis: RepoAnalysis, repoId: string, modules: ModuleInfo[]): string {
  const parts: string[] = [];

  const readmeSummary = extractReadmeSummary(analysis.repoPath);
  if (readmeSummary) parts.push(readmeSummary);

  parts.push(`${analysis.lang} 项目，${analysis.stats.totalSymbols} 符号，${modules.length} 模块`);

  const topModules = modules.slice(0, 5).map(m => {
    const name = m.path.split('.').pop() ?? m.path;
    return `${name}(${m.stats.classes}类${m.stats.methods}方法)`;
  });
  if (topModules.length > 0) parts.push(`核心模块: ${topModules.join(', ')}`);

  const routes = analysis.infraRefs.filter(r => r.type === 'route');
  const rpcProviders = analysis.infraRefs.filter(r => r.type === 'rpc_provider');
  if (routes.length > 0) parts.push(`${routes.length} 个 API 路由`);
  if (rpcProviders.length > 0) parts.push(`${rpcProviders.length} 个 RPC Provider`);

  const infraTypes = new Set(analysis.infraRefs.filter(r => r.type !== 'route').map(r => r.type));
  if (infraTypes.size > 0) parts.push(`基础设施: ${[...infraTypes].join(', ')}`);

  return parts.join('。').slice(0, MAX_SUMMARY);
}

function buildL1Summary(mod: ModuleInfo, callEdges: CallEdge[], repoId: string): string {
  const parts: string[] = [];
  const modName = mod.path.split('.').pop() ?? mod.path;

  parts.push(`${modName} 模块: ${mod.stats.classes}类 ${mod.stats.interfaces}接口 ${mod.stats.methods}方法`);

  const coreClasses = mod.files.flatMap(f => f.symbols)
    .filter(s => !s.parent && (s.kind === 'class' || s.kind === 'interface'))
    .slice(0, 8);

  const classDescs = coreClasses.map(s => {
    const docLine = extractDocFirstLine(s.doc) ?? inferPhpClassName(s.name);
    return docLine ? `${s.name}(${docLine})` : s.name;
  });
  if (classDescs.length > 0) parts.push(`核心类: ${classDescs.join(', ')}`);

  const infraRefs = mod.files.flatMap(f => f.infraRefs);
  const redisClusters = infraRefs.filter(r => r.type === 'redis_cluster').map(r => r.value);
  const kafkaTopics = infraRefs.filter(r => r.type === 'kafka_topic').map(r => r.value);
  if (redisClusters.length > 0) parts.push(`Redis: ${[...new Set(redisClusters)].join(', ')}`);
  if (kafkaTopics.length > 0) parts.push(`Kafka: ${[...new Set(kafkaTopics)].join(', ')}`);

  return parts.join('。').slice(0, MAX_SUMMARY);
}
