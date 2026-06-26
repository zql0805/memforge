-- 036: MOA 服务注册表 — 记录 serviceUri → repo 的映射关系
-- Created on 2026/06/10

BEGIN;
CREATE TABLE IF NOT EXISTS memory.topology_moa_registry (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    product_line    TEXT NOT NULL,
    service_uri     TEXT NOT NULL,
    repo_id         TEXT NOT NULL,
    git_remote_url  TEXT,
    provider_file   TEXT,
    confidence      REAL NOT NULL DEFAULT 0.95,
    last_scanned_at TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (product_line, service_uri)
);

CREATE INDEX IF NOT EXISTS idx_moa_registry_uri ON memory.topology_moa_registry (service_uri);
CREATE INDEX IF NOT EXISTS idx_moa_registry_repo ON memory.topology_moa_registry (product_line, repo_id);
CREATE INDEX IF NOT EXISTS idx_moa_registry_uri_trgm ON memory.topology_moa_registry USING gin (service_uri gin_trgm_ops);

COMMIT;
