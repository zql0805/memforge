-- 011: 拓扑用户路径增加设备维度
-- 解决同一账户在多台电脑（目录不同）扫描拓扑时路径互相覆盖的问题。
-- 创建时间: 2026-04-10

-- 1. 新增 device_id 列（默认 '_default_' 兼容旧数据）

BEGIN;
ALTER TABLE memory.topology_user_paths
  ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT '_default_';

-- 2. 重建主键：从 (user_id, product_line, repo_id) → (user_id, device_id, product_line, repo_id)
ALTER TABLE memory.topology_user_paths DROP CONSTRAINT IF EXISTS topology_user_paths_pkey;
ALTER TABLE memory.topology_user_paths
  ADD PRIMARY KEY (user_id, device_id, product_line, repo_id);

-- 3. 新增索引
CREATE INDEX IF NOT EXISTS idx_tup_user_device
  ON memory.topology_user_paths (user_id, device_id, product_line);

COMMIT;
