-- 010: 拓扑用户路径隔离
-- 将 local_path 从 topology_nodes（共享）拆分到 per-user 表，
-- 解决多用户扫描时路径覆盖和数据丢失问题。
-- 创建时间: 2026-04-10

-- 新表：每个用户对每个仓库的本地路径映射

BEGIN;
CREATE TABLE IF NOT EXISTS memory.topology_user_paths (
  user_id      TEXT NOT NULL,
  product_line TEXT NOT NULL,
  repo_id      TEXT NOT NULL,
  local_path   TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, product_line, repo_id)
);

CREATE INDEX IF NOT EXISTS idx_tup_product_line
  ON memory.topology_user_paths (product_line);

CREATE INDEX IF NOT EXISTS idx_tup_user_product
  ON memory.topology_user_paths (user_id, product_line);

-- 迁移现有数据：将 topology_nodes.local_path 复制到 user_paths
-- 使用 '_system_' 作为占位用户（旧数据无 user 归属）
INSERT INTO memory.topology_user_paths (user_id, product_line, repo_id, local_path, updated_at)
SELECT '_system_', product_line, repo_id, local_path, updated_at
FROM memory.topology_nodes
WHERE local_path IS NOT NULL AND local_path != ''
ON CONFLICT DO NOTHING;

-- topology_nodes.local_path 保留为"参考路径"，不删除列
COMMENT ON COLUMN memory.topology_nodes.local_path IS '参考路径（deprecated）。实际路径请查 topology_user_paths 表按用户过滤。';

COMMIT;
