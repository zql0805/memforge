-- ============================================================
-- Memforge — 022: Git 历史知识引擎基础表
-- Created by dev on 2026/05/09
-- 新增 project_git_stats 表，扩展 auto_init_state 的 init_type
-- ============================================================

BEGIN;

-- ═══════════════════════════════════════════════════
-- 1. project_git_stats — 每仓库的 Git 活跃度指标
-- ═══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS memory.project_git_stats (
    id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    product_line            TEXT NOT NULL,
    repo_id                 TEXT NOT NULL,

    -- 本地/远程 HEAD 状态
    latest_local_hash       TEXT,
    latest_remote_hash      TEXT,
    local_behind_count      INTEGER NOT NULL DEFAULT 0,
    default_branch          TEXT NOT NULL DEFAULT 'main',

    -- 活跃度指标（由聚合器定期更新）
    commits_last_7d         INTEGER NOT NULL DEFAULT 0,
    commits_last_30d        INTEGER NOT NULL DEFAULT 0,
    active_contributors_7d  INTEGER NOT NULL DEFAULT 0,
    active_contributors_30d INTEGER NOT NULL DEFAULT 0,

    -- 变更热力 Top N（JSONB 数组 [{file, count, lastModified}]）
    hot_files_30d           JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- 里程碑
    first_commit_at         TIMESTAMPTZ,
    last_commit_at          TIMESTAMPTZ,
    total_commits           INTEGER NOT NULL DEFAULT 0,

    -- 贡献者摘要 [{name, commits, lastActive}]
    top_contributors        JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- 调度状态
    last_fetched_at         TIMESTAMPTZ,
    last_analyzed_at        TIMESTAMPTZ,

    -- 扩展字段
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (product_line, repo_id)
);

CREATE INDEX IF NOT EXISTS idx_pgs_pl ON memory.project_git_stats(product_line);
CREATE INDEX IF NOT EXISTS idx_pgs_last_commit ON memory.project_git_stats(last_commit_at DESC NULLS LAST);

COMMENT ON TABLE memory.project_git_stats IS '每仓库 Git 活跃度指标，由 GitChangeEngine 定期聚合更新';

-- ═══════════════════════════════════════════════════
-- 2. 扩展 auto_init_state.init_type 约束
--    新增 git_watch / project_bootstrap
-- ═══════════════════════════════════════════════════

ALTER TABLE memory.auto_init_state
  DROP CONSTRAINT IF EXISTS chk_init_type;

ALTER TABLE memory.auto_init_state
  ADD CONSTRAINT chk_init_type
  CHECK (init_type IN (
    'doc_index', 'topology_import', 'commit_learn',
    'prdocs_watch', 'docs_watch', 'doc_sync',
    'git_watch', 'project_bootstrap'
  ));

-- ═══════════════════════════════════════════════════
-- 3. RLS 策略（与 topology 表保持一致）
-- ═══════════════════════════════════════════════════

ALTER TABLE memory.project_git_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory.project_git_stats FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pgs_isolation ON memory.project_git_stats;
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

COMMIT;
