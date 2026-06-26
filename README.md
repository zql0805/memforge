<div align="center">

# Memforge

**让 AI 编程助手拥有团队记忆 — 代码越写越好，团队越用越强**

> **Disclaimer**: This project is released for learning and reference purposes only. It does not represent any company's production system. Use at your own risk.

*Engineering Intelligence Platform for AI-Powered Development*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-blue.svg)](https://postgresql.org)
[![pgvector](https://img.shields.io/badge/pgvector-0.7+-orange.svg)](https://github.com/pgvector/pgvector)

[快速开始](#快速开始) · [功能特性](#功能特性) · [架构](#架构) · [MCP 工具](#mcp-工具) · [部署指南](docs/deployment-guide.md) · [MCI 部署](docs/deployment-mci.md) · [用户指南](docs/user-guide.md) · [环境变量](docs/configuration.md)

</div>

---

## 是什么

Memforge 是一个基于 MCP（Model Context Protocol）的工程师智能记忆平台。它让 Cursor、Claude Code 等 AI 编程助手具备**跨会话持久记忆**、**团队编码规范感知**和**微服务架构认知**能力。

**没有 Memforge 的 AI：**
- 每次对话从零开始，不记得上次的架构决策
- 不了解团队的编码规范和禁用写法
- 不知道这个服务调用了哪些下游

**有了 Memforge 的 AI：**
- 修改代码前自动检索相关历史经验和规范
- Bug 修复后自动沉淀到团队知识库
- 理解服务拓扑，修改接口时主动提醒上游影响

### 工作流演示

```
# 1. 修复了一个 Bug —— AI 自动记住
store_memory({
  title: "Redis 连接池耗尽：maxConnections 默认值过小",
  content: "现象: TimeoutError after 5000ms...",
  scope: "bug_pattern",
  visibility: "product_line"
})
→ ✓ 已存储，自动向量化，已检测重复，已关联规则候选

# 2. 下次遇到类似问题 —— AI 自动召回
recall_memory({ query: "Redis 连接超时", product_line: "myteam" })
→ [1] Redis 连接池耗尽：maxConnections 默认值过小  (相似度 0.94)
   修复方案：将 DB_POOL_MAX 从默认 10 改为 50...

# 3. 规律提升为团队规范
propose_rule({
  title: "外部连接必须显式设置连接池上限",
  rule_type: "infra",
  severity: "error"
})
→ ✓ 规则候选已创建，等待 lead/admin 投票激活
→ ✓ 激活后自动同步为 .cursor/rules/memforge-rules.mdc
```

---

## 功能特性

### 记忆系统
- **语义检索**：基于 pgvector HNSW 索引，毫秒级语义召回
- **四层可见性**：personal → team → product_line → global 级联查询
- **分支守卫**：批量索引和 Code Review 自动过滤非默认分支，确保知识库只包含 master/main 代码
- **敏感防护**：入库前自动检测并拒绝 API Key / Token / PII

### 自动学习
- **文档索引**：扫描 `docs/` 目录，将文档拆分为语义段落批量入库
- **Commit 学习**：分析 Git 历史，提取 Bug 修复/重构/性能优化知识
- **Code Review 提取**：从 Review 评论中自动归纳团队编码规范
- **实时监控**：文件变更时自动触发增量索引

### 规范引擎
- **规则提议**：AI 自动发现并提议候选规范，支持冲突检测
- **加权投票**：admin / lead / developer 三级投票权重
- **自动同步**：激活的规范自动同步为 Cursor `.mdc` 规则文件
- **效果度量**：追踪规范应用次数和违反事件

### 拓扑感知
- **自动扫描**：内置扫描引擎，支持 15+ 语言/框架的依赖检测
- **调用链查询**：查询服务的上下游调用关系
- **变更影响分析**：修改接口前自动分析上游影响范围
- **发布顺序推导**：拓扑排序生成正确的多服务发布顺序

### 知识库管理
- **结构化知识**：7 种知识类型（FAQ/操作指南/排障指南/技术文档/故障案例/SOP/API参考）
- **混合搜索**：BM25 + 向量检索 + RRF 融合排序，双语全文索引（英文词干 + 中文分词）
- **置信度评分**：融合检索分数、用户反馈、专家审核的四因子置信度
- **编审工作流**：draft → published → archived 状态管理，支持审核追溯
- **工单导入**：批量导入客服工单/Ticket，自动转为知识条目
- **反馈闭环**：helpful/unhelpful 反馈直接影响搜索排序

### 团队协作
- **MCP Gateway**：OAuth 2.1 + PKCE + RBAC，支持多用户
- **产品线隔离**：多团队/多产品线数据隔离，按权限过滤
- **Web UI**：Vue 3 管理面板，可视化记忆、规范、拓扑、知识库
- **审计日志**：所有操作可追溯

---

## 快速开始

### 前置依赖

- Node.js 20+
- PostgreSQL 15+ with [pgvector](https://github.com/pgvector/pgvector)
- 兼容 OpenAI `/v1/embeddings` 协议的 Embedding 服务（推荐 [SiliconFlow](https://siliconflow.cn) + BGE-M3，免费额度够用）

### 一、安装

```bash
# macOS 安装依赖
brew install postgresql@17 pgvector redis ripgrep

# 初始化数据库
createuser memforge && createdb -O memforge memforge
psql -U memforge -d memforge -f sql/init.sql

# 安装依赖 & 构建
git clone https://github.com/zql0805/memforge.git
cd memforge
npm install && npm run build
```

> **关于 ripgrep**：`scan_topology` 拓扑扫描引擎的运行时依赖。未安装时仍可正常使用记忆和规范功能，但无法发现 RPC 调用链（仅能检测 Maven/npm 级 SDK 依赖）。

### 二、配置 Embedding

在 `.env` 中配置（复制 `.env.example` 修改）：

```bash
DATABASE_URL=postgresql://memforge:memforge_dev@localhost:5432/memforge
OPENAI_BASE_URL=https://api.siliconflow.cn/v1
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
OPENAI_EMBEDDING_MODEL=BAAI/bge-m3
```

### 三、配置 Cursor MCP

在 `~/.cursor/mcp.json` 中添加：

```json
{
  "mcpServers": {
    "memforge": {
      "command": "node",
      "args": ["/path/to/memforge/packages/memory-service/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://memforge:memforge_dev@localhost:5432/memforge",
        "OPENAI_BASE_URL": "https://api.siliconflow.cn/v1",
        "OPENAI_API_KEY": "sk-xxxxxxxxxxxxxxxx",
        "OPENAI_EMBEDDING_MODEL": "BAAI/bge-m3"
      }
    },
    "memforge-rules": {
      "command": "node",
      "args": ["/path/to/memforge/packages/rules-engine/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://memforge:memforge_dev@localhost:5432/memforge",
        "OPENAI_BASE_URL": "https://api.siliconflow.cn/v1",
        "OPENAI_API_KEY": "sk-xxxxxxxxxxxxxxxx",
        "OPENAI_EMBEDDING_MODEL": "BAAI/bge-m3"
      }
    }
  }
}
```

### 四、冷启动

重启 Cursor 后，在对话框中执行：

```
帮我执行 bootstrap，导入现有知识资产
```

Memforge 会自动安装 Cursor Rules，并引导完成首次初始化。

---

## Docker Compose 快速启动（团队模式）

```bash
# 复制配置
cp .env.example .env
# 编辑 .env，填写 JWT_SECRET 和 Embedding 配置

# 启动完整服务栈（PostgreSQL + Redis + Gateway + Memory + Rules + Web UI）
docker compose --profile gateway up -d

# 查看状态
docker compose ps
```

Web UI 默认访问地址：`http://localhost`（Nginx 端口 80）

---

## 架构

```
┌─────────────────────────────────────────────────────┐
│                   AI 编程助手                         │
│          (Cursor / Claude Code / VS Code)            │
└──────────────────┬──────────────────────────────────┘
                   │ MCP Protocol
         ┌─────────┴──────────┐
         │   Memforge Gateway  │  OAuth 2.1 + RBAC + 审计
         │   (Port 3000)       │
         └──┬──────────┬────┬─┘
            │          │    │
  ┌─────────┴──┐  ┌───┴────┴────┐  ┌──────────────┐
  │  Memory    │  │   Rules     │  │  Knowledge   │
  │  Service   │  │   Engine    │  │  Service     │
  │ (Port 3001)│  │ (Port 3002) │  │ (Port 3003)  │
  └────┬───────┘  └──────┬──────┘  └──────┬───────┘
       │                 │                 │
  ┌────┴─────────────────┴─────────────────┴──┐
  │         PostgreSQL + pgvector              │
  │  (记忆 / 规范 / 知识库 / 拓扑 / 审计)       │
  └────────────────────────────────────────────┘
       │
  ┌────┴──────┐
  │   Redis   │  L2 缓存（可选）
  └───────────┘
```

**单机模式**（个人开发者）：Memory Service + Rules Engine 直接以 stdio 接入 Cursor，无需 Gateway。Knowledge Service 仅支持 HTTP 模式，单机使用时在本地启动后通过 Gateway 或直连访问。

**团队模式**：通过 Gateway 统一认证，多用户共享记忆库，产品线数据隔离。

---

## Web UI 预览

> 部署完成后访问 `http://localhost`（或你的服务地址，默认端口 80）

| 记忆管理 | 规范管理 | 拓扑可视化 |
|---|---|---|
| 搜索、筛选、审核全量记忆 | 提议/投票/激活编码规范 | 服务调用链可视化 |

---

## MCP 工具

<details>
<summary><b>Memory Service（48 个工具）</b></summary>

**记忆存取**

| 工具 | 说明 |
|---|---|
| `store_memory` | 存储记忆（自动向量化 + 去重 + 脱敏） |
| `recall_memory` | 语义检索（支持 `product_line` 三层级联） |
| `list_memories` | 分页列出（多维筛选） |
| `update_memory` | 更新记忆 |
| `archive_memory` | 归档 |

**自动学习**

| 工具 | 说明 |
|---|---|
| `index_documents` | 批量索引目录文档 |
| `sync_documents` | 基于 git diff 增量同步 |
| `learn_from_commits` | 从 Git 历史提取知识 |
| `learn_from_review` | 从 Code Review 提取规范 |
| `watch_docs` | 实时监控文档变更 |

**拓扑**

| 工具 | 说明 |
|---|---|
| `scan_topology` | 自动扫描仓库，检测 15+ 语言依赖 |
| `import_topology` | 从注册表导入服务架构 |
| `query_topology` | 查询服务调用关系 |
| `get_topology_release_order` | 生成发布顺序 |
| `get_topology_change_impact` | 分析变更影响范围 |
| `resolve_service_path` | 模糊匹配服务路径 |

**知识积累**

| 工具 | 说明 |
|---|---|
| `bootstrap` | 一键冷启动 |
| `store_session_summary` | 存储会话决策摘要 |
| `store_log_insight` | 日志排查结论入库 |
| `store_troubleshoot` | 排查流程知识化 |
| `store_incident` | 线上故障结构化录入 |
| `store_code_review` | Code Review 结果存储 |

**工作追踪**

| 工具 | 说明 |
|---|---|
| `start_work_context` | 开始工作上下文 |
| `update_work_context` | 更新进度 |
| `evaluate_work_context` | 完成评价，自动沉淀经验 |

**其他**

| 工具 | 说明 |
|---|---|
| `get_developer_profile` | 开发者技能画像 |
| `get_system_rules` | 加载团队规范（非 Cursor IDE 适用） |
| `verify_memory` | 标记记忆为已验证（+15% 排序权重） |
| `export_memories` / `import_memories` | 数据导入导出 |
| `store_structured_memory` | 统一结构化存储入口（路由到 code_review/session_summary/log_insight 等） |
| `extract_session_memories` | 从会话内容自动提取有价值记忆（架构决策/Bug 模式/经验教训） |
| `index_api_docs` | 索引仓库 API 文档（自动提取函数签名和用法） |

**Git 历史知识引擎**

| 工具 | 说明 |
|---|---|
| `bootstrap_project_history` | 一键导入 Git 历史知识（分析提交/PR/Review） |
| `check_stale_code` | 检测代码腐化风险（长期未变更模块） |
| `check_conflict_risk` | 评估并发修改冲突风险 |
| `get_project_context` | 获取项目上下文（贡献者/活跃度/技术栈） |
| `check_related_activity` | 检查上下游仓库近期变更影响 |
| `extract_coding_standards` | 从 Git 历史批量提取编码规范候选 |
| `review_commit` | 对单个 Git commit 执行自动 Code Review 管道（上下文收集 → 静态扫描 → LLM 审查 → 钉钉通知） |
| `install_git_hooks` | 为 Git 仓库安装 Memforge post-commit & post-merge hooks |

**Agent 任务管理**

| 工具 | 说明 |
|---|---|
| `get_agent_tasks` | 获取任务列表 |
| `create_agent_task` | 创建任务 |
| `update_agent_task` | 更新任务状态 |
| `batch_update_tasks` | 批量更新任务 |
| `log_task_progress` | 记录任务进度 |
| `import_tasks_from_plan` | 从计划导入任务 |
| `manage_agent_tasks` | 任务管理（多操作合一） |

</details>

<details>
<summary><b>Rules Engine（19 个工具）</b></summary>

| 工具 | 说明 |
|---|---|
| `propose_rule` | 提议规则（自动冲突检测） |
| `list_rules` | 列出规则 |
| `get_rule` | 获取详情（含投票和度量） |
| `vote_rule` | 加权投票 |
| `update_rule` | 更新候选规则 |
| `activate_rule` | 激活候选规则 |
| `delete_rule` | 删除规则 |
| `deprecate_rule` | 废弃规则 |
| `enforce_rules` | 对代码执行规则检查 |
| `discover_rules` | 分析内容发现规则候选 |
| `measure_rules` | 规则效果度量 |
| `record_rule_event` | 记录应用/违反事件 |
| `assess_skill` | 技能评估 |
| `get_growth_path` | 成长路径推荐 |
| `record_milestone` | 记录成长里程碑 |
| `get_skill_radar` | 技能雷达图数据 |
| `get_team_matrix` | 团队技能矩阵 |
| `add_knowledge_relation` | 建立知识图谱关系 |
| `get_knowledge_graph` | 查询知识图谱 |

</details>

<details>
<summary><b>Knowledge Service（10 个 MCP 工具 + REST API）</b></summary>

**MCP 工具**

| 工具 | 说明 |
|---|---|
| `search_knowledge` | 混合检索（BM25 + 向量 + RRF 融合 + 置信度评分） |
| `store_knowledge` | 存储知识条目（FAQ/操作指南/故障案例等 7 种类型） |
| `browse_knowledge` | 按文件系统语义浏览知识库目录（VFS URI） |
| `read_knowledge_item` | 读取单条知识条目，返回 Markdown 格式（支持 ID 或 VFS URI） |
| `write_knowledge_item` | 以文件系统语义创建或更新知识条目，自动生成 slug 和 VFS URI |
| `import_dingtalk_docs` | 从钉钉知识库导入文档（遍历文件夹树，转换为知识条目） |
| `code_context` | 自然语言查询，一次返回组装好的代码知识上下文（项目概览 + 相关模块） |
| `knowledge_feedback` | 对知识条目提交反馈（有用/无用），驱动置信度排序优化 |
| `list_knowledge` | 分页列出知识条目（支持类型/分类/产品线过滤） |
| `knowledge_stats` | 知识库统计数据（条目总数、分类分布等） |

**REST API（WebUI 使用）**

| 端点 | 说明 |
|---|---|
| `POST /api/knowledge/search` | 混合搜索 |
| `POST /api/knowledge/store` | 创建知识 |
| `GET /api/knowledge/list` | 分页列表 |
| `GET /api/knowledge/:id` | 详情 |
| `PUT /api/knowledge/:id` | 更新知识条目 |
| `DELETE /api/knowledge/:id` | 删除知识条目 |
| `POST /api/knowledge/:id/publish` | 发布（draft → published） |
| `POST /api/knowledge/:id/archive` | 归档（published → archived） |
| `POST /api/knowledge/feedback` | 反馈（helpful/unhelpful） |
| `POST /api/knowledge/import-tickets` | 批量导入工单 |
| `GET /api/knowledge/browse` | 按分类路径浏览（带子分类和条目） |
| `GET/POST /api/knowledge/categories` | 分类管理（层级分类树） |
| `PUT /api/knowledge/categories/:id` | 更新分类 |
| `DELETE /api/knowledge/categories/:id` | 删除分类 |
| `GET /api/knowledge/stats` | 统计（按状态/类型分布） |
| `POST /api/knowledge/cleanup` | 按来源批量清理条目 |
| `POST /api/knowledge/mark-stale` | 标记过期条目（基于文件变更） |
| `GET /api/knowledge/stale-stats` | 过期条目统计 |
| `POST /api/knowledge/code-context` | 代码知识上下文组装（REST 版 code_context） |
| `POST /api/memory/recall` | 语义检索记忆（REST 版 recall_memory，含 RLS） |

</details>

---

## 项目结构

```
memforge/
├── packages/
│   ├── memory-service/       # 核心记忆 MCP 服务（48 个工具）
│   ├── rules-engine/         # 编码规范引擎（19 个工具）
│   ├── knowledge-service/    # 知识库服务（10 个 MCP 工具 + 混合搜索 + 编审工作流）
│   ├── gateway/              # MCP Gateway（OAuth 2.1 + RBAC + 审计）
│   ├── web-ui/               # Vue 3 + Element Plus 管理面板
│   └── shared/               # 共享类型、PG 连接池、缓存
├── sql/
│   ├── init.sql           # 初始化 Schema
│   └── migrations/        # 增量迁移脚本
├── scripts/
│   ├── cursor-hooks/      # Cursor Agent Hooks（自动 recall/规范注入/文档同步）
│   ├── batch-index-api.ts    # 批量 API 文档索引（含分支守卫）
│   ├── batch-deep-index.ts   # 深度代码知识索引（含分支守卫）
│   └── mcp-remote-proxy.mjs  # MCP 远程代理客户端
├── deploy/
│   └── k8s/               # Kubernetes Helm Chart
├── docs/                  # 项目文档（按需创建）
├── .github/workflows/     # CI/CD（GitHub Actions）
└── docker-compose.yml
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TRANSPORT_MODE` | `stdio` | 传输模式（`stdio` / `http`） |
| `DATABASE_URL` | — | PostgreSQL 连接串 |
| `OPENAI_BASE_URL` | — | Embedding API 地址 |
| `OPENAI_API_KEY` | — | Embedding API 密钥 |
| `OPENAI_EMBEDDING_MODEL` | — | 模型名称（推荐 `BAAI/bge-m3`） |
| `MEMFORGE_GATEWAY_URL` | — | Gateway 地址（Git Hook 共享配置 + MCP 代理使用） |
| `MEMFORGE_REVIEW_BRANCHES` | `master,main` | 触发 Code Review 的分支白名单（逗号分隔） |
| `MEMFORGE_AUTO_MODE` | `smart` | 自动化模式（`smart` / `full` / `silent`） |
| `MEMFORGE_RULES_SCOPE` | `global` | Rules 安装位置（`global` / `workspace`） |
| `REDIS_URL` | — | Redis 连接串（L2 缓存，可选） |

---

## Cursor Rules 自动安装

首次启动时自动安装两条规则到 `~/.cursor/rules/`：

- `memforge-auto-recall.mdc` — AI 交互时自动检索/存储记忆
- `memforge-human-confirm.mdc` — AI 执行变更前征求人工确认

设置 `MEMFORGE_RULES_SCOPE=workspace` 可切换为工作区级安装。

## Git Hook 自动安装

MCP 连接 Git 仓库时自动安装 `post-commit` / `post-merge` hooks，提交代码后自动触发知识学习和 Code Review。

**共享配置机制**：Hook 脚本运行时从 `~/.memforge/config` 读取 Gateway URL（每次 MCP 连接自动刷新），服务器迁移只需更新 `MEMFORGE_GATEWAY_URL` 环境变量，任意仓库下次 MCP 连接即可自动传播新地址到所有仓库的 hook。

---

## 路线图

<details>
<summary>查看完整里程碑历史</summary>

- [x] M1: 核心记忆服务（SQLite + 本地向量化）
- [x] M2: 编码规范引擎（Rules Engine — 投票 + 冲突检测 + 度量）
- [x] M3a: PostgreSQL 迁移（pgvector + FTS + Docker Compose）
- [x] M3b: MCP Gateway（OAuth 2.1 + PKCE + RBAC + 审计）
- [x] M3c: 多租户（RLS + Redis 缓存 + Prometheus 可观测性）
- [x] M4: Web UI（Vue 3 + Element Plus）
- [x] M5: 生产就绪（备份恢复 + Helm Chart + 部署手册）
- [x] M6: 技能树与成长体系
- [x] M7: 自动知识获取（文档索引 + Commit 学习 + Review 提取）
- [x] M8: 工程化补全（Dockerfile + CI 加固 + E2E 覆盖）
- [x] M9: Smart Semi-Auto（Auto-Init Hook）
- [x] M10: Web UI 实战化（拓扑可视化）
- [x] M11: Cursor Rules 自动安装
- [x] M12: 知识闭环（bootstrap + 双向规范同步）
- [x] M13: 四层可见性（personal → team → product_line → global）
- [x] M14: 工作上下文追踪
- [x] M15: 规范治理增强（rule-bridge + store_code_review）
- [x] M16: 拓扑查询 MCP 化（4 个只读查询工具）
- [x] M17: 运维工具链（watchdog + log-rotate + backup）
- [x] M18: 开发者画像
- [x] T1: 团队化改造（RBAC + 产品线 ACL + Gateway 原生 MCP）
- [x] M19: 智能体任务中心（Agent Task + Kanban）
- [x] M20: Cursor Hooks 系统级强制保障（recall/规范注入/文档同步/GATE 0）
- [x] M21: Git 历史知识引擎（6 个工具）

</details>

---

## 迁移

如果你之前使用了基于 SQLite 的旧版本：

```bash
node scripts/migrate-sqlite-to-pg.mjs \
  --memory-db ~/.memforge/data/memforge.db \
  --rules-db ~/.memforge/data/rules.db
```

---

## 贡献

欢迎 PR 和 Issue！请阅读 [用户指南](docs/user-guide.md) 了解项目架构。

```bash
# 本地开发
npm install
docker compose up -d          # 启动 PostgreSQL + Redis
npm run build                 # 编译所有包
npm run test -w packages/memory-service   # 运行测试
```

---

## License

[MIT](LICENSE) © 2026 Memforge Contributors

---

<div align="center">

[![Star History Chart](https://api.star-history.com/svg?repos=zql0805/memforge&type=Date)](https://star-history.com/#zql0805/memforge)

</div>
