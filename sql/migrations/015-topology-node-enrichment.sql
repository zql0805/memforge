-- ============================================================
-- Memforge 迁移 015: 拓扑节点元信息增强
-- Created by dev on 2026/04/08
-- 将 topology_nodes 从"只存名字和分层"升级为"项目全量元信息中心"
-- 新增 Git 地址、依赖列表、仓库特征信号等字段
-- ============================================================

BEGIN;
SET search_path TO memory, public;

-- ─── 新增列 ──────────────────────────────────────────────

ALTER TABLE memory.topology_nodes
  ADD COLUMN IF NOT EXISTS git_remote_url TEXT,
  ADD COLUMN IF NOT EXISTS git_host TEXT,
  ADD COLUMN IF NOT EXISTS git_group TEXT,
  ADD COLUMN IF NOT EXISTS dependencies JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS signals JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS scanned_by TEXT,
  ADD COLUMN IF NOT EXISTS last_scanned_at TIMESTAMPTZ;

-- ─── 注释说明 ────────────────────────────────────────────

COMMENT ON COLUMN memory.topology_nodes.local_path IS
  '已弃用。实际路径请查 topology_user_paths 表按用户过滤。';
COMMENT ON COLUMN memory.topology_nodes.git_remote_url IS
  'Git 远程仓库地址（已脱敏，去除 userinfo），如 git@git.example.com:live/myteam/user-service.git';
COMMENT ON COLUMN memory.topology_nodes.git_host IS
  'Git 服务器主机名，如 git.example.com';
COMMENT ON COLUMN memory.topology_nodes.git_group IS
  'Git 仓库组/命名空间，如 live/myteam';
COMMENT ON COLUMN memory.topology_nodes.dependencies IS
  '检测到的依赖列表 [{type, serviceUri, groupId, artifactId, ...}]';
COMMENT ON COLUMN memory.topology_nodes.signals IS
  '仓库特征信号 {has_kafka, has_spring_web, uses_mysql, provides_moa, ...}';
COMMENT ON COLUMN memory.topology_nodes.scanned_by IS
  '最后一次扫描此节点的用户 ID';
COMMENT ON COLUMN memory.topology_nodes.last_scanned_at IS
  '最后一次扫描时间';

-- ─── 索引 ────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_topo_nodes_git_host ON memory.topology_nodes(git_host)
  WHERE git_host IS NOT NULL;

COMMIT;
