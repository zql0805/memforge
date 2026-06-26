-- ============================================================
-- Memforge — PostgreSQL 初始化脚本
-- Created by dev on 2026/04/04
-- Copyright © 2026
-- ============================================================
-- 默认 embedding 维度 1024（L3 bge-m3 模型）。
-- 如使用 L1(384) 或 L2(768)，首次启动前需修改 vector(1024)。

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS memory;
SET search_path TO memory, public;

-- ─── 组织与项目（M3c 多租户启用） ───────────────────────────

CREATE TABLE memory.organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(100) NOT NULL UNIQUE,
    settings        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE memory.projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES memory.organizations(id),
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(100) NOT NULL,
    repo_url        VARCHAR(500),
    default_branch  VARCHAR(100) DEFAULT 'main',
    settings        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, slug)
);

CREATE TABLE memory.branches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES memory.projects(id),
    name            VARCHAR(255) NOT NULL,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    is_archived     BOOLEAN NOT NULL DEFAULT FALSE,
    last_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, name)
);

CREATE INDEX idx_branches_project_active
    ON memory.branches(project_id, is_archived, last_active_at DESC);

-- ─── 用户（M3c SSO 集成启用） ───────────────────────────────

CREATE TABLE memory.users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES memory.organizations(id),
    external_id     VARCHAR(255) NOT NULL,
    email           VARCHAR(255),
    display_name    VARCHAR(255),
    role            VARCHAR(50) NOT NULL DEFAULT 'developer',
    password_hash   TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, external_id)
);

-- ─── Embedding 元数据 ────────────────────────────────────────

CREATE TABLE memory.embedding_meta (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 记忆条目 ────────────────────────────────────────────────

CREATE TABLE memory.entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      TEXT NOT NULL DEFAULT 'default',
    branch_id       TEXT,
    title           VARCHAR(500) NOT NULL,
    content         TEXT NOT NULL,
    scope           TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'manual',
    tags            TEXT[] NOT NULL DEFAULT '{}',
    embedding       vector(1024),
    metadata        JSONB NOT NULL DEFAULT '{}',
    is_archived     BOOLEAN NOT NULL DEFAULT FALSE,
    archived_reason VARCHAR(255),
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ
);

CREATE INDEX idx_entries_embedding_hnsw
    ON memory.entries
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

CREATE INDEX idx_entries_project_branch_scope
    ON memory.entries(project_id, branch_id, scope)
    WHERE is_archived = FALSE;

CREATE INDEX idx_entries_tags
    ON memory.entries USING gin(tags);

CREATE INDEX idx_entries_content_fts
    ON memory.entries
    USING gin(to_tsvector('simple', title || ' ' || content));

-- pg_trgm: 支持 ILIKE/word_similarity 的中英文子串匹配
CREATE INDEX idx_entries_title_trgm
    ON memory.entries USING gin(title gin_trgm_ops);
CREATE INDEX idx_entries_content_trgm
    ON memory.entries USING gin(content gin_trgm_ops);

CREATE INDEX idx_entries_created_at
    ON memory.entries(project_id, created_at DESC)
    WHERE is_archived = FALSE;

CREATE INDEX idx_entries_created_by
    ON memory.entries(created_by)
    WHERE created_by IS NOT NULL;

COMMENT ON COLUMN memory.entries.created_by IS '创建该记忆的用户标识（归属标记，非访问控制）';

-- ─── 规则（多类型：coding / ai_agent / workflow / business / infra）────────

CREATE TABLE memory.rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      TEXT NOT NULL DEFAULT 'default',
    rule_type       VARCHAR(50) NOT NULL DEFAULT 'coding',
    title           VARCHAR(500) NOT NULL,
    description     TEXT NOT NULL,
    rationale       TEXT,
    example_good    TEXT,
    example_bad     TEXT,
    auto_fix        TEXT,
    category        VARCHAR(100) NOT NULL,
    language        VARCHAR(50),
    severity        VARCHAR(20) NOT NULL DEFAULT 'warning' CHECK (severity IN ('critical', 'error', 'warning', 'info')),
    status          VARCHAR(20) NOT NULL DEFAULT 'candidate',
    source          VARCHAR(50) NOT NULL DEFAULT 'manual',
    source_ref      JSONB,
    embedding       vector(1024),
    applied_count   INTEGER NOT NULL DEFAULT 0,
    violated_count  INTEGER NOT NULL DEFAULT 0,
    accepted_count  INTEGER NOT NULL DEFAULT 0,
    rejected_count  INTEGER NOT NULL DEFAULT 0,
    activated_at    TIMESTAMPTZ,
    deprecated_at   TIMESTAMPTZ,
    created_by      TEXT,
    team_id         UUID REFERENCES memory.teams(id),
    visibility      VARCHAR(20) NOT NULL DEFAULT 'personal'
                    CHECK (visibility IN ('personal', 'team', 'product_line', 'global')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rules_team_id ON memory.rules(team_id) WHERE team_id IS NOT NULL;
CREATE INDEX idx_rules_visibility ON memory.rules(visibility);
CREATE INDEX idx_rules_team_visibility ON memory.rules(team_id, visibility) WHERE status = 'active';
CREATE INDEX idx_rules_status_category
    ON memory.rules(status, category);

CREATE INDEX idx_rules_project_status
    ON memory.rules(project_id, status);

CREATE INDEX idx_rules_rule_type
    ON memory.rules(rule_type);

CREATE INDEX idx_rules_type_status
    ON memory.rules(rule_type, status);

CREATE INDEX idx_rules_language
    ON memory.rules(language) WHERE status = 'active';

CREATE INDEX idx_rules_embedding_hnsw
    ON memory.rules
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

-- ─── 规则投票 ────────────────────────────────────────────────

CREATE TABLE memory.rule_votes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id         UUID NOT NULL REFERENCES memory.rules(id),
    user_id         TEXT NOT NULL,
    role            VARCHAR(20) NOT NULL DEFAULT 'developer',
    vote            SMALLINT NOT NULL CHECK (vote IN (-1, 0, 1)),
    comment         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(rule_id, user_id)
);

CREATE INDEX idx_votes_rule
    ON memory.rule_votes(rule_id);

-- ─── 规则事件 ────────────────────────────────────────────────

CREATE TABLE memory.rule_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id         UUID NOT NULL REFERENCES memory.rules(id),
    event_type      VARCHAR(20) NOT NULL,
    file_path       TEXT,
    code_snippet    TEXT,
    user_id         TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_rule_type
    ON memory.rule_events(rule_id, event_type);

CREATE INDEX idx_events_created
    ON memory.rule_events(created_at DESC);

-- ─── 审计日志（M3b Gateway 使用） ───────────────────────────

CREATE TABLE memory.audit_logs (
    id              BIGSERIAL PRIMARY KEY,
    org_id          UUID,
    user_id         UUID,
    action          VARCHAR(50) NOT NULL,
    resource_type   VARCHAR(50) NOT NULL,
    resource_id     UUID,
    details         JSONB,
    ip_address      INET,
    user_agent      VARCHAR(500),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_org_time
    ON memory.audit_logs(org_id, created_at DESC);

CREATE INDEX idx_audit_resource
    ON memory.audit_logs(resource_type, resource_id, created_at DESC);

-- ─── RLS 行级安全策略（M3c 多租户隔离）──────────────────────
-- 通过连接级变量 app.current_org_id 实现租户隔离

ALTER TABLE memory.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory.rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory.users ENABLE ROW LEVEL SECURITY;

-- 记忆条目：按 project_id 隔离（当前简化模式，M3c+ 升级为 org_id）
-- 应用角色可以 SELECT/INSERT/UPDATE 自己项目的数据
CREATE POLICY entries_isolation ON memory.entries
    FOR ALL
    USING (TRUE)
    WITH CHECK (TRUE);

-- 编码规则：同上
CREATE POLICY rules_isolation ON memory.rules
    FOR ALL
    USING (TRUE)
    WITH CHECK (TRUE);

-- 用户表：按 org_id 隔离
CREATE POLICY users_org_isolation ON memory.users
    FOR ALL
    USING (
        org_id = COALESCE(
            NULLIF(current_setting('app.current_org_id', true), '')::uuid,
            '00000000-0000-0000-0000-000000000001'::uuid
        )
    );

-- 审计日志：仅 admin 角色可查看（应用层控制）
ALTER TABLE memory.audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read_all ON memory.audit_logs
    FOR SELECT USING (TRUE);
CREATE POLICY audit_insert ON memory.audit_logs
    FOR INSERT WITH CHECK (TRUE);

-- ─── OAuth 客户端注册（M3b Gateway） ─────────────────────────

CREATE TABLE memory.oauth_clients (
    client_id       VARCHAR(100) PRIMARY KEY,
    client_name     VARCHAR(255) NOT NULL,
    redirect_uris   TEXT[] NOT NULL DEFAULT '{}',
    is_public       BOOLEAN NOT NULL DEFAULT TRUE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 默认组织（开发环境种子数据） ───────────────────────────

INSERT INTO memory.organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default', 'default')
ON CONFLICT (slug) DO NOTHING;

-- 默认 OAuth 客户端
INSERT INTO memory.oauth_clients (client_id, client_name, redirect_uris, is_public)
VALUES
  ('cursor-ide', 'Cursor IDE', ARRAY['http://localhost:0/callback'], TRUE),
  ('claude-code', 'Claude Code', ARRAY['http://localhost:0/callback'], TRUE),
  ('vscode-ext', 'VS Code Extension', ARRAY['http://localhost:0/callback'], TRUE),
  ('memforge-cli', 'Memforge CLI', ARRAY['http://localhost:0/callback'], TRUE),
  ('memforge-web', 'Memforge Web Dashboard', ARRAY['http://localhost:5173/callback', 'http://localhost:3000/callback'], TRUE)
ON CONFLICT (client_id) DO NOTHING;

-- ─── M6: 技能树与知识图谱 ─────────────────────────────────

-- 技能定义表（组织级，定义技能树结构）
CREATE TABLE memory.skill_definitions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES memory.organizations(id),
    parent_id       UUID REFERENCES memory.skill_definitions(id),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    category        VARCHAR(100) NOT NULL,
    max_level       SMALLINT NOT NULL DEFAULT 5,
    level_criteria  JSONB NOT NULL DEFAULT '[]',
    embedding       vector(1024),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_skill_defs_parent
    ON memory.skill_definitions(org_id, parent_id);

CREATE INDEX idx_skill_defs_category
    ON memory.skill_definitions(org_id, category);

ALTER TABLE memory.skill_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY skill_defs_isolation ON memory.skill_definitions
    FOR ALL USING (TRUE) WITH CHECK (TRUE);

-- 用户技能状态表
CREATE TABLE memory.user_skills (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES memory.users(id),
    skill_id        UUID NOT NULL REFERENCES memory.skill_definitions(id),
    current_level   SMALLINT NOT NULL DEFAULT 1 CHECK (current_level BETWEEN 1 AND 5),
    confidence      REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
    evidence        JSONB NOT NULL DEFAULT '[]',
    assessed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, skill_id)
);

CREATE INDEX idx_user_skills_user
    ON memory.user_skills(user_id);

-- 技能成长事件表
CREATE TABLE memory.skill_events (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES memory.users(id),
    skill_id        UUID NOT NULL REFERENCES memory.skill_definitions(id),
    event_type      VARCHAR(50) NOT NULL,
    old_level       SMALLINT,
    new_level       SMALLINT,
    details         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_skill_events_user_time
    ON memory.skill_events(user_id, created_at DESC);

-- 知识图谱关系表
CREATE TABLE memory.knowledge_relations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       UUID NOT NULL,
    source_type     VARCHAR(50) NOT NULL,
    target_id       UUID NOT NULL,
    target_type     VARCHAR(50) NOT NULL,
    relation_type   VARCHAR(50) NOT NULL,
    confidence      REAL NOT NULL DEFAULT 0.8,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_by      VARCHAR(50) NOT NULL DEFAULT 'system',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kr_source
    ON memory.knowledge_relations(source_id, source_type);
CREATE INDEX idx_kr_target
    ON memory.knowledge_relations(target_id, target_type);
CREATE INDEX idx_kr_relation_type
    ON memory.knowledge_relations(relation_type);

-- 插入默认技能树模板（后端工程师）
INSERT INTO memory.skill_definitions (org_id, name, description, category, level_criteria, sort_order)
VALUES
  ('00000000-0000-0000-0000-000000000001', '编程语言', '编程语言基础能力', 'backend', '[]', 1),
  ('00000000-0000-0000-0000-000000000001', '数据库', '数据库设计与优化', 'backend', '[{"level":1,"criteria":"了解 SQL 基本语法"},{"level":2,"criteria":"能写复杂 JOIN，理解索引"},{"level":3,"criteria":"能优化慢查询，设计合理表结构"},{"level":4,"criteria":"能设计分库分表方案"},{"level":5,"criteria":"能设计跨库分布式查询方案"}]', 2),
  ('00000000-0000-0000-0000-000000000001', '缓存', 'Redis/Memcached 缓存设计', 'backend', '[{"level":1,"criteria":"会用 GET/SET"},{"level":2,"criteria":"理解缓存失效策略"},{"level":3,"criteria":"能设计缓存方案防穿透/雪崩"},{"level":4,"criteria":"能设计分布式缓存架构"},{"level":5,"criteria":"能优化缓存系统性能"}]', 3),
  ('00000000-0000-0000-0000-000000000001', '系统架构', '系统设计与架构决策', 'architecture', '[{"level":1,"criteria":"了解常见架构模式"},{"level":2,"criteria":"能参与架构讨论"},{"level":3,"criteria":"能独立设计中等复杂系统"},{"level":4,"criteria":"能主导跨服务架构设计"},{"level":5,"criteria":"能推动组织级架构演进"}]', 4),
  ('00000000-0000-0000-0000-000000000001', '分布式系统', '分布式一致性、容错、扩展', 'architecture', '[]', 5),
  ('00000000-0000-0000-0000-000000000001', '安全', '应用安全、认证授权', 'backend', '[]', 6),
  ('00000000-0000-0000-0000-000000000001', 'Code Review', '代码评审能力', 'engineering', '[]', 7),
  ('00000000-0000-0000-0000-000000000001', '测试策略', '测试设计与质量保障', 'engineering', '[]', 8),
  ('00000000-0000-0000-0000-000000000001', 'CI/CD', '持续集成/部署', 'devops', '[]', 9),
  ('00000000-0000-0000-0000-000000000001', '监控告警', '可观测性与故障响应', 'devops', '[]', 10);

-- ═══════════════════════════════════════════════════════════════
-- 自动化状态追踪（Smart Semi-Auto 模式）
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS memory.auto_init_state (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    project_id    TEXT NOT NULL,
    init_type     TEXT NOT NULL,
    last_run_at   TIMESTAMPTZ,
    last_status   TEXT NOT NULL DEFAULT 'pending',
    last_result   JSONB NOT NULL DEFAULT '{}',
    run_count     INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (project_id, init_type),
    CONSTRAINT chk_init_type CHECK (init_type IN ('doc_index', 'topology_import', 'commit_learn', 'prdocs_watch', 'docs_watch', 'doc_sync', 'git_watch', 'project_bootstrap')),
    CONSTRAINT chk_last_status CHECK (last_status IN ('pending', 'running', 'success', 'failed', 'skipped'))
);

ALTER TABLE memory.auto_init_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY auto_init_rls ON memory.auto_init_state
    USING (TRUE) WITH CHECK (TRUE);

-- ═══════════════════════════════════════════════════════════════
-- Git 活跃度指标（由 GitChangeEngine 定期聚合更新）
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS memory.project_git_stats (
    id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    product_line            TEXT NOT NULL,
    repo_id                 TEXT NOT NULL,

    latest_local_hash       TEXT,
    latest_remote_hash      TEXT,
    local_behind_count      INTEGER NOT NULL DEFAULT 0,
    default_branch          TEXT NOT NULL DEFAULT 'main',

    commits_last_7d         INTEGER NOT NULL DEFAULT 0,
    commits_last_30d        INTEGER NOT NULL DEFAULT 0,
    active_contributors_7d  INTEGER NOT NULL DEFAULT 0,
    active_contributors_30d INTEGER NOT NULL DEFAULT 0,

    hot_files_30d           JSONB NOT NULL DEFAULT '[]'::jsonb,

    first_commit_at         TIMESTAMPTZ,
    last_commit_at          TIMESTAMPTZ,
    total_commits           INTEGER NOT NULL DEFAULT 0,

    top_contributors        JSONB NOT NULL DEFAULT '[]'::jsonb,

    last_fetched_at         TIMESTAMPTZ,
    last_analyzed_at        TIMESTAMPTZ,

    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (product_line, repo_id)
);

CREATE INDEX IF NOT EXISTS idx_pgs_pl ON memory.project_git_stats(product_line);
CREATE INDEX IF NOT EXISTS idx_pgs_last_commit ON memory.project_git_stats(last_commit_at DESC NULLS LAST);

ALTER TABLE memory.project_git_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY pgs_isolation ON memory.project_git_stats
  USING (
    memory.current_user_id() IS NULL
    OR memory.is_admin()
    OR product_line IN (
      SELECT tpl.product_line
      FROM memory.team_product_lines tpl
      JOIN memory.team_members tm ON tm.team_id = tpl.team_id
      WHERE tm.user_id = memory.current_user_id()
    )
  );

-- ═══════════════════════════════════════════════════════════════
-- 拓扑结构化存储（支持 WebUI 编辑）
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE memory.topology_nodes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_line    TEXT NOT NULL,
    repo_id         TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    tech_stack      TEXT,
    layer_name      TEXT,
    layer_index     INT DEFAULT 8,
    description     TEXT DEFAULT '',
    local_path      TEXT,
    is_manual       BOOLEAN NOT NULL DEFAULT FALSE,
    is_hidden       BOOLEAN NOT NULL DEFAULT FALSE,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    git_remote_url  TEXT,
    git_host        TEXT,
    git_group       TEXT,
    dependencies    JSONB DEFAULT '[]',
    signals         JSONB DEFAULT '{}',
    scanned_by      TEXT,
    last_scanned_at TIMESTAMPTZ,
    UNIQUE(product_line, repo_id)
);
CREATE INDEX idx_topo_nodes_pl ON memory.topology_nodes(product_line);
CREATE INDEX idx_topo_nodes_layer ON memory.topology_nodes(product_line, layer_index);
ALTER TABLE memory.topology_nodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY topo_nodes_rls ON memory.topology_nodes USING (TRUE) WITH CHECK (TRUE);

CREATE TABLE memory.topology_edges (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_line    TEXT NOT NULL,
    from_repo_id    TEXT NOT NULL,
    to_repo_id      TEXT NOT NULL,
    protocol        TEXT NOT NULL DEFAULT 'unknown',
    source_file     TEXT,
    confidence      REAL NOT NULL DEFAULT 0.9,
    is_manual       BOOLEAN NOT NULL DEFAULT FALSE,
    is_hidden       BOOLEAN NOT NULL DEFAULT FALSE,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(product_line, from_repo_id, to_repo_id, protocol)
);
CREATE INDEX idx_topo_edges_pl ON memory.topology_edges(product_line);
CREATE INDEX idx_topo_edges_from ON memory.topology_edges(product_line, from_repo_id);
CREATE INDEX idx_topo_edges_to ON memory.topology_edges(product_line, to_repo_id);
ALTER TABLE memory.topology_edges ENABLE ROW LEVEL SECURITY;
CREATE POLICY topo_edges_rls ON memory.topology_edges USING (TRUE) WITH CHECK (TRUE);

CREATE TABLE memory.topology_layers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_line    TEXT NOT NULL,
    layer_index     INT NOT NULL,
    name            TEXT NOT NULL,
    color           TEXT NOT NULL DEFAULT '#909399',
    is_custom       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(product_line, layer_index)
);
ALTER TABLE memory.topology_layers ENABLE ROW LEVEL SECURITY;
CREATE POLICY topo_layers_rls ON memory.topology_layers USING (TRUE) WITH CHECK (TRUE);

INSERT INTO memory.topology_layers (product_line, layer_index, name, color) VALUES
    ('_default_', 0, 'App客户端 / 前端 / 管理后台前端', '#409eff'),
    ('_default_', 1, '接口网关 / Web接口层', '#67c23a'),
    ('_default_', 2, '管理后台 Web', '#5dade2'),
    ('_default_', 3, '管理后台RPC', '#e6a23c'),
    ('_default_', 4, '微服务', '#f56c6c'),
    ('_default_', 5, '支付/充值', '#909399'),
    ('_default_', 6, '公共库/协议 / 基础设施', '#b37feb'),
    ('_default_', 7, '工具', '#708090'),
    ('_default_', 8, '待归类', '#c0c4cc');

-- ═══════════════════════════════════════════════
--  产品线访问控制（ACL）
-- ═══════════════════════════════════════════════

ALTER TABLE memory.users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE memory.user_product_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES memory.users(id) ON DELETE CASCADE,
    product_line    TEXT NOT NULL,
    access_level    TEXT NOT NULL DEFAULT 'read',
    granted_by      UUID REFERENCES memory.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, product_line),
    CHECK (access_level IN ('read', 'write', 'manage'))
);

CREATE INDEX idx_upl_user ON memory.user_product_lines(user_id);
CREATE INDEX idx_upl_pl ON memory.user_product_lines(product_line);

ALTER TABLE memory.user_product_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY upl_rls ON memory.user_product_lines USING (TRUE) WITH CHECK (TRUE);

CREATE OR REPLACE FUNCTION memory.auto_promote_first_user()
RETURNS TRIGGER AS $$
DECLARE
    user_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO user_count FROM memory.users;
    IF user_count = 1 THEN
        UPDATE memory.users
        SET role = 'admin', is_super_admin = TRUE
        WHERE id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_auto_promote_first_user
    AFTER INSERT ON memory.users
    FOR EACH ROW
    EXECUTE FUNCTION memory.auto_promote_first_user();

-- ═══════════════════════════════════════════════════════════════
-- API Key 管理
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE memory.api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES memory.users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    key_prefix      TEXT NOT NULL,
    key_hash        TEXT NOT NULL,
    scope           VARCHAR(20) NOT NULL DEFAULT 'readwrite'
                    CHECK (scope IN ('read', 'readwrite', 'admin')),
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_user ON memory.api_keys(user_id);
CREATE INDEX idx_api_keys_prefix_hash
    ON memory.api_keys(key_prefix, key_hash) WHERE is_active = TRUE;

-- ═══════════════════════════════════════════════════════════════
-- 受信任设备（登录设备审批）
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE memory.trusted_devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES memory.users(id) ON DELETE CASCADE,
    device_id       VARCHAR(255) NOT NULL,
    device_name     VARCHAR(255),
    device_type     VARCHAR(50) NOT NULL DEFAULT 'web',
    user_agent      TEXT,
    last_ip         VARCHAR(45),
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    approved_by     UUID REFERENCES memory.users(id),
    approved_at     TIMESTAMPTZ,
    last_seen_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, device_id),
    CHECK (status IN ('pending', 'approved', 'revoked'))
);

CREATE INDEX idx_trusted_devices_user ON memory.trusted_devices(user_id);
CREATE INDEX idx_trusted_devices_status ON memory.trusted_devices(status);
ALTER TABLE memory.trusted_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY trusted_devices_rls ON memory.trusted_devices USING (TRUE) WITH CHECK (TRUE);

-- ═══════════════════════════════════════════════════════════════
-- 产品线注册
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE memory.product_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            VARCHAR(100) NOT NULL UNIQUE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    scan_roots      TEXT[] NOT NULL DEFAULT '{}',
    git_patterns    TEXT[] NOT NULL DEFAULT '{}',
    settings        JSONB NOT NULL DEFAULT '{}',
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- 拓扑用户路径映射（多设备本地路径）
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE memory.topology_user_paths (
    user_id         TEXT NOT NULL,
    device_id       TEXT NOT NULL DEFAULT '_default_',
    product_line    TEXT NOT NULL,
    repo_id         TEXT NOT NULL,
    local_path      TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, device_id, product_line, repo_id)
);
CREATE INDEX idx_tup_user_device ON memory.topology_user_paths(user_id, device_id, product_line);
CREATE INDEX idx_tup_user_product ON memory.topology_user_paths(user_id, product_line);
CREATE INDEX idx_tup_product_line ON memory.topology_user_paths(product_line);

-- ═══════════════════════════════════════════════════════════════
-- Agent 任务看板
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION memory.update_agent_task_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE memory.agent_tasks (
    id              SERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES memory.users(id),
    title           VARCHAR(500) NOT NULL,
    description     TEXT,
    category        VARCHAR(100) NOT NULL DEFAULT 'general',
    priority        VARCHAR(10) DEFAULT 'P2',
    status          VARCHAR(20) DEFAULT 'pending',
    product_line    VARCHAR(100),
    project         VARCHAR(200),
    tags            TEXT[] DEFAULT '{}',
    related_items   JSONB DEFAULT '[]',
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    execution_summary TEXT,
    execution_issues  TEXT,
    conversation_id VARCHAR(200),
    history_file_path VARCHAR(500),
    last_heartbeat  TIMESTAMPTZ,
    created_by      VARCHAR(100) DEFAULT 'user',
    sort_order      INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled', 'suspended'))
);

CREATE INDEX idx_agent_tasks_user_status ON memory.agent_tasks(user_id, status);
CREATE INDEX idx_agent_tasks_created_at ON memory.agent_tasks(created_at DESC);
CREATE INDEX idx_agent_tasks_priority ON memory.agent_tasks(priority);
CREATE INDEX idx_agent_tasks_category ON memory.agent_tasks(category);
CREATE INDEX idx_agent_tasks_product_line ON memory.agent_tasks(product_line);

ALTER TABLE memory.agent_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_tasks_rls ON memory.agent_tasks USING (TRUE) WITH CHECK (TRUE);

CREATE TRIGGER trg_agent_task_updated_at
    BEFORE UPDATE ON memory.agent_tasks
    FOR EACH ROW EXECUTE FUNCTION memory.update_agent_task_timestamp();

CREATE TABLE memory.agent_task_logs (
    id              SERIAL PRIMARY KEY,
    task_id         INTEGER NOT NULL REFERENCES memory.agent_tasks(id) ON DELETE CASCADE,
    level           VARCHAR(10) DEFAULT 'info',
    message         TEXT NOT NULL,
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (level IN ('info', 'warn', 'error', 'debug'))
);

CREATE INDEX idx_agent_task_logs_task_id ON memory.agent_task_logs(task_id);
CREATE INDEX idx_agent_task_logs_level ON memory.agent_task_logs(level);

ALTER TABLE memory.agent_task_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_task_logs_rls ON memory.agent_task_logs USING (TRUE) WITH CHECK (TRUE);

-- ═══════════════════════════════════════════════════════════════
-- 工作上下文追踪（需求/Bug/重构全生命周期）
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION memory.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE memory.work_contexts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES memory.organizations(id),
    title           VARCHAR(500) NOT NULL,
    type            VARCHAR(50) NOT NULL DEFAULT 'requirement',
    description     TEXT,
    priority        VARCHAR(10) DEFAULT 'P2',
    status          VARCHAR(20) NOT NULL DEFAULT 'in_progress',
    product_line    VARCHAR(100),
    estimated_hours DOUBLE PRECISION,
    actual_hours    DOUBLE PRECISION,
    outcome         VARCHAR(20),
    summary         TEXT,
    related_doc_urls TEXT[] NOT NULL DEFAULT '{}',
    metadata        JSONB NOT NULL DEFAULT '{}',
    tags            TEXT[] NOT NULL DEFAULT '{}',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wkctx_status ON memory.work_contexts(status);
CREATE INDEX idx_wkctx_pl ON memory.work_contexts(product_line);

CREATE TRIGGER trg_wkctx_updated
    BEFORE UPDATE ON memory.work_contexts
    FOR EACH ROW EXECUTE FUNCTION memory.update_updated_at();

CREATE TABLE memory.work_context_projects (
    context_id      UUID NOT NULL REFERENCES memory.work_contexts(id) ON DELETE CASCADE,
    project_name    VARCHAR(255) NOT NULL,
    branch          VARCHAR(255),
    project_root    VARCHAR(500),
    git_stats       JSONB,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (context_id, project_name)
);

CREATE TABLE memory.work_context_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    context_id      UUID NOT NULL REFERENCES memory.work_contexts(id) ON DELETE CASCADE,
    note            TEXT NOT NULL,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
