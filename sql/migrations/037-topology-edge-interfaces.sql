-- 037: 调用关系接口明细表 + topology_nodes.app_key 字段
-- Created on 2026/06/10

BEGIN;
ALTER TABLE memory.topology_nodes ADD COLUMN IF NOT EXISTS app_key TEXT;
CREATE INDEX IF NOT EXISTS idx_topology_nodes_appkey ON memory.topology_nodes (app_key) WHERE app_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory.topology_edge_interfaces (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    product_line        TEXT NOT NULL,
    edge_id             UUID REFERENCES memory.topology_edges(id) ON DELETE CASCADE,
    from_repo_id        TEXT NOT NULL,
    to_repo_id          TEXT NOT NULL,
    protocol            TEXT NOT NULL,
    interface_url       TEXT NOT NULL,
    method_name         TEXT,
    traffic_1d_avg      BIGINT DEFAULT 0,
    traffic_7d_avg      BIGINT DEFAULT 0,
    traffic_1d_peak     BIGINT DEFAULT 0,
    traffic_7d_peak     BIGINT DEFAULT 0,
    traffic_updated_at  TIMESTAMPTZ,
    source_file         TEXT,
    provider_file       TEXT,
    confidence          REAL NOT NULL DEFAULT 0.9,
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (product_line, from_repo_id, to_repo_id, protocol, interface_url, method_name)
);

CREATE INDEX IF NOT EXISTS idx_edge_interfaces_edge ON memory.topology_edge_interfaces (edge_id);
CREATE INDEX IF NOT EXISTS idx_edge_interfaces_url ON memory.topology_edge_interfaces USING gin (interface_url gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_edge_interfaces_pl_traffic ON memory.topology_edge_interfaces (product_line, traffic_7d_avg DESC);
CREATE INDEX IF NOT EXISTS idx_edge_interfaces_from_to ON memory.topology_edge_interfaces (product_line, from_repo_id, to_repo_id);

COMMIT;
