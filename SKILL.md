# Memforge — AI 记忆平台使用指南

> 版本: 1.11.0 | 最后更新: 2026-06-11

## 概述

Memforge 是一个 MCP 记忆平台，让 AI 编程助手拥有跨会话的持久记忆、编码规范意识和产品线架构认知。基于 PostgreSQL + pgvector + API Embedding（兼容 OpenAI 协议，推荐 BGE-M3）。

## 何时使用

- 在修改代码前，先用 `recall_memory` 检索相关记忆和规范
- 修复 Bug 后，用 `store_memory` 记录错误模式和解决方案
- 架构决策后，用 `store_session_summary` 保存决策记录
- 排查问题后，用 `store_troubleshoot` 积累排查手册
- ES 日志定位问题后，用 `store_log_insight` 记录日志洞察
- 首次使用时，运行 `bootstrap` 一键导入现有知识资产
- 对话结束时，提取关键经验用 `store_session_summary` 存储
- 发现通用编码模式时，用 `propose_rule` 提议为正式编码规范
- 新会话自动检测产品线并导入拓扑（无需手动操作）
- 开始做需求/Bug 修复时，用 `start_work_context` 建立工作上下文
- 进度更新时，用 `update_work_context` 追加项目/文档/笔记
- 完成工作后，用 `evaluate_work_context` 自动沉淀经验教训

## 核心工具

### 记忆存取（Memory Service）

| 工具 | 用途 |
|---|---|
| `store_memory` | 存储一条记忆（自动向量化 + 去重 + 脱敏） |
| `recall_memory` | 语义检索记忆（支持 `format: "prompt"` 和 `product_line` / `tags_filter` / `scope_filter` 过滤） |
| `list_memories` | 列表浏览记忆（支持分页、筛选） |
| `update_memory` | 更新已有记忆 |
| `archive_memory` | 归档不再需要的记忆 |
| `verify_memory` | lead/admin 标记记忆为已验证（verified 记忆在 recall 中获 15% 排序加权） |
| `store_structured_memory` | 统一结构化存储入口（路由到 code_review/session_summary/log_insight 等） |
| `extract_session_memories` | 从会话内容自动提取架构决策/Bug 模式/经验教训 |

### 知识导入

| 工具 | 用途 |
|---|---|
| `bootstrap` | 一键冷启动：导入 Rules + Skills + 拓扑 + 文档 |
| `index_documents` | 扫描目录批量索引文档 |
| `import_topology` | 导入产品线拓扑架构（支持 `force` 强制覆盖） |
| `scan_topology` | 触发拓扑技能执行仓库扫描 |
| `import_memories` | 从备份 JSON 恢复记忆 |
| `export_memories` | 导出记忆为 JSON |

### 自动学习

| 工具 | 用途 |
|---|---|
| `learn_from_review` | 从 Code Review 中提取规范 |
| `learn_from_commits` | 从 Git 提交中学习模式 |
| `sync_documents` | 增量同步文档变更 |
| `watch_docs` | 监控 docs/ 文档目录变更并自动索引 |
| `store_session_summary` | 会话结束时保存决策摘要 |
| `store_log_insight` | ES 日志排查结论存储 |
| `store_troubleshoot` | 排查流程积累为知识库（支持 `product_line` 跨项目共享） |
| `store_incident` | 线上故障报告结构化录入（影响等级/时间线/根因/修复/改进措施） |

### 工作追踪

| 工具 | 用途 |
|---|---|
| `start_work_context` | 开始工作上下文（需求/Bug/重构），自动搜索相关经验和规则 |
| `update_work_context` | 更新进度，新增项目/文档，自动收集 Git diff 统计 |
| `evaluate_work_context` | 完成评价：AI 分析产出经验教训，自动沉淀 + 建立知识关联 |

### 开发者画像与系统规则

| 工具 | 用途 |
|---|---|
| `get_developer_profile` | 生成开发者技能画像（按 scope/tags/月度活跃度/代码审查模式分析） |
| `get_system_rules` | 加载团队编码规范和 AI 行为规则（支持按语言/类型过滤） |
| `store_code_review` | Code Review 结果结构化存储（P0/P1 分级 + 自动匹配已有规则） |
| `index_api_docs` | 索引仓库 API 文档（自动提取函数签名） |

### Agent 任务管理

| 工具 | 用途 |
|---|---|
| `get_agent_tasks` | 查询任务列表（支持状态/优先级/产品线过滤） |
| `manage_agent_tasks` | 任务写操作统一入口（create/update/batch_update/log/import_plan） |
| `create_agent_task` / `update_agent_task` | 创建/更新单个任务 |
| `batch_update_tasks` | 批量更新任务状态 |
| `log_task_progress` | 记录任务执行日志 |
| `import_tasks_from_plan` | 从 plan 文件导入任务 |

### Git 历史知识引擎

| 工具 | 用途 |
|---|---|
| `bootstrap_project_history` | 一键导入 Git 历史知识 |
| `check_stale_code` | 检测长期未变更模块 |
| `check_conflict_risk` | 评估并发修改冲突风险 |
| `get_project_context` | 获取项目上下文（贡献者/活跃度/技术栈） |
| `check_related_activity` | 检查上下游仓库近期变更 |
| `extract_coding_standards` | 从 Git 历史批量提取编码规范候选 |
| `review_commit` | 单 commit 自动 Code Review 管道 |
| `install_git_hooks` | 安装 post-commit / post-merge hooks |

### 编码规范引擎（Rules Engine）

| 工具 | 用途 |
|---|---|
| `propose_rule` | 提议新编码规范（支持 `auto_activate` 直接激活） |
| `list_rules` | 列出编码规范（按状态/分类/语言过滤） |
| `get_rule` | 获取规范详情（含投票和度量） |
| `vote_rule` | 对候选规范进行加权投票 |
| `enforce_rules` | 对代码片段执行规范检查 |
| `discover_rules` | 从内容中发现规范候选 |
| `measure_rules` | 获取规范效果度量 |
| `update_rule` | 更新候选/投票中规则 |
| `activate_rule` | 直接激活规则（admin/lead） |
| `deprecate_rule` | 废弃 active 规则 |
| `delete_rule` | 永久删除已废弃规则 |
| `record_rule_event` | 记录规则应用/违反事件 |

### 知识库（Knowledge Service）

| 工具 | 用途 |
|---|---|
| `search_knowledge` | 混合检索（BM25 + 向量 + RRF 融合） |
| `store_knowledge` | 存储 FAQ/操作指南/故障案例等 |
| `browse_knowledge` | 按 VFS URI 浏览知识库目录 |
| `read_knowledge_item` / `write_knowledge_item` | 读取/写入单条知识 |
| `code_context` | 自然语言查询，返回组装好的代码知识上下文 |
| `import_dingtalk_docs` | 从钉钉知识库导入文档 |
| `list_knowledge` / `knowledge_stats` | 分页列表 / 统计概览 |
| `knowledge_feedback` | 提交有用/无用反馈 |

### recall_memory 使用技巧

```
recall_memory({
  query: "与当前任务相关的关键词",
  limit: 5,
  format: "prompt",            // 输出对 AI 友好的格式
  product_line: "your-product",   // 跨项目检索时指定产品线
  tags_filter: ["pl:your-product"], // 按标签精确过滤
  scope_filter: "architecture"   // 按范围过滤
})
```

**检索关键词策略：**
- 修改代码前 → 用文件路径 + 业务域搜索编码规范
- 问题排查时 → 用错误信息 + 服务名搜索历史 Bug
- 方案讨论时 → 用技术点搜索架构决策
- Code Review 时 → 用被审查代码的关键模式搜索
- 拓扑查询 → 用服务名 + `tags_filter: ["pl:产品线"]` 检索架构记忆

### 存储工具选择

| 场景 | 推荐工具 |
|---|---|
| 通用记忆（规范、决策、笔记） | `store_memory` |
| 对话结束有重要决策/教训 | `store_session_summary` |
| 通过 ES 日志定位了问题原因 | `store_log_insight` |
| 完成了一次问题排查流程 | `store_troubleshoot` |
| 发现通用编码模式 | `propose_rule`（录入编码规范引擎） |

### scope 类型说明

| scope | 用途 |
|---|---|
| `coding_standard` | 编码规范 |
| `architecture` | 架构决策 |
| `lesson_learned` | 经验教训 |
| `bug_pattern` | Bug 模式 |
| `performance_insight` | 性能洞察 |
| `debugging_strategy` | 排查策略 |
| `convention` | 团队约定 |
| `domain_knowledge` | 领域知识 |
| `tool_usage` | 工具使用 |

## 快速开始

### 1. 本地安装

```bash
# macOS
brew install postgresql@17 pgvector redis
createuser memforge && createdb -O memforge memforge
psql -U memforge -d memforge -f sql/init.sql
npm install && npm run build
```

### 2. 一键启动全套服务

```bash
bash scripts/start-all.sh    # 启动 Memory + Rules + Gateway + WebUI
bash scripts/stop-all.sh     # 停止全部
```

启动后访问：
- **Web UI**: http://localhost（Nginx 反代，端口 80）；开发模式 http://localhost:5173
- **Gateway**: http://localhost:3000
- **Memory Service**: http://localhost:3001（通常由 Gateway 内部调用）
- **Rules Engine**: http://localhost:3002（通常由 Gateway 内部调用）

### 3. 在 Cursor 中配置

在 Cursor MCP 设置中添加 `memforge` 和 `memforge-rules` 两个 MCP Server（stdio 模式），详见 README.md。

### 4. 冷启动

首次使用时运行 `bootstrap` 工具，一键导入 Cursor Rules、Skills、产品线拓扑和项目文档。

### 5. macOS 开机自启

```bash
bash scripts/install-launchd.sh   # 安装 launchd 服务
```

## 拓扑自动同步

新会话首次交互时，AI 会自动：
1. 从工作区路径推断当前产品线
2. 检查记忆库中是否已有该产品线的拓扑数据
3. 如果缺失或过期，自动调用 `import_topology` 导入

支持的产品线检测规则在 `memforge-auto-recall.mdc` 中配置。

## Web UI 功能

| 页面 | 功能 |
|---|---|
| 仪表盘 | 统计概览、最近记忆 |
| 记忆管理 | 搜索/浏览/管理记忆条目 |
| 编码规范 | 查看/投票/管理编码规范（支持生命周期管理） |
| 拓扑可视化 | 产品线服务架构图 + 动态调用关系过滤 |
| 知识图谱 | 知识实体关系可视化 |
| 工作追踪 | 看板/列表视图、进度管理、评价沉淀 |
| 文档索引 | 批量索引、Git 同步 |

## 相关文档

- [用户指南](docs/user-guide.md) — 完整使用说明
- [环境变量配置](docs/configuration.md) — 全部环境变量清单
- [MCP 工具参考](docs/api/mcp-tools.md) — 77 个工具参数速查
- [部署指南](docs/deployment-guide.md) — 单机/PM2 快速部署
- [部署指南（MCI）](docs/deployment-mci.md) — 生产环境部署
