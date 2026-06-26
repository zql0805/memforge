-- ============================================================
-- Memforge 迁移 002: 拓扑结构化存储表
-- Created by dev on 2026/04/07
-- 支持 WebUI 拓扑编辑（节点分组/描述/调用链增删）
-- ============================================================

BEGIN;
SET search_path TO memory, public;

-- ─── 拓扑节点（服务/仓库） ─────────────────────────────────
CREATE TABLE IF NOT EXISTS memory.topology_nodes (
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
    UNIQUE(product_line, repo_id)
);

CREATE INDEX IF NOT EXISTS idx_topo_nodes_pl ON memory.topology_nodes(product_line);
CREATE INDEX IF NOT EXISTS idx_topo_nodes_layer ON memory.topology_nodes(product_line, layer_index);

ALTER TABLE memory.topology_nodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY topo_nodes_rls ON memory.topology_nodes USING (TRUE) WITH CHECK (TRUE);

-- ─── 拓扑调用边 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory.topology_edges (
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

CREATE INDEX IF NOT EXISTS idx_topo_edges_pl ON memory.topology_edges(product_line);
CREATE INDEX IF NOT EXISTS idx_topo_edges_from ON memory.topology_edges(product_line, from_repo_id);
CREATE INDEX IF NOT EXISTS idx_topo_edges_to ON memory.topology_edges(product_line, to_repo_id);

ALTER TABLE memory.topology_edges ENABLE ROW LEVEL SECURITY;
CREATE POLICY topo_edges_rls ON memory.topology_edges USING (TRUE) WITH CHECK (TRUE);

-- ─── 拓扑层级定义 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory.topology_layers (
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

-- ─── 插入默认层级定义 ─────────────────────────────────────
INSERT INTO memory.topology_layers (product_line, layer_index, name, color) VALUES
    ('_default_', 0, 'App客户端 / 前端 / 管理后台前端', '#409eff'),
    ('_default_', 1, '接口网关 / Web接口层', '#67c23a'),
    ('_default_', 2, '管理后台 Web', '#5dade2'),
    ('_default_', 3, '管理后台RPC', '#e6a23c'),
    ('_default_', 4, '微服务', '#f56c6c'),
    ('_default_', 5, '支付/充值', '#909399'),
    ('_default_', 6, '公共库/协议 / 基础设施', '#b37feb'),
    ('_default_', 7, '工具', '#708090'),
    ('_default_', 8, '待归类', '#c0c4cc')
ON CONFLICT DO NOTHING;

COMMIT;
