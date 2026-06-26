-- ============================================================
-- Memforge 迁移 016: 多租户数据分级隔离
-- Created by dev on 2026/05/06
-- 新增团队体系（org_members / teams / team_members / team_product_lines）
-- entries 新增 org_id / team_id / visibility 实现分级可见性
-- ============================================================

BEGIN;

-- ─── 1. 组织成员表 ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory.org_members (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES memory.organizations(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES memory.users(id) ON DELETE CASCADE,
    org_role    VARCHAR(20) NOT NULL DEFAULT 'member'
                CHECK (org_role IN ('owner', 'admin', 'member')),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, user_id)
);

CREATE INDEX idx_org_members_user ON memory.org_members(user_id);

-- 将现有 users 回填到 org_members（用户已有 org_id 外键）
INSERT INTO memory.org_members (org_id, user_id, org_role, joined_at)
SELECT u.org_id, u.id,
       CASE WHEN u.is_super_admin = TRUE THEN 'owner' ELSE 'member' END,
       u.created_at
FROM memory.users u
WHERE NOT EXISTS (
    SELECT 1 FROM memory.org_members om WHERE om.org_id = u.org_id AND om.user_id = u.id
);

-- ─── 2. 团队表 ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory.teams (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES memory.organizations(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    slug        VARCHAR(100) NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, slug)
);

-- ─── 3. 团队成员表 ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory.team_members (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     UUID NOT NULL REFERENCES memory.teams(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES memory.users(id) ON DELETE CASCADE,
    role        VARCHAR(20) NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(team_id, user_id)
);

CREATE INDEX idx_team_members_user ON memory.team_members(user_id);
CREATE INDEX idx_team_members_primary ON memory.team_members(user_id, is_primary) WHERE is_primary = TRUE;

-- ─── 4. 团队产品线关联表 ────────────────────────────────

CREATE TABLE IF NOT EXISTS memory.team_product_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id         UUID NOT NULL REFERENCES memory.teams(id) ON DELETE CASCADE,
    product_line    TEXT NOT NULL,
    access_level    TEXT NOT NULL DEFAULT 'read'
                    CHECK (access_level IN ('read', 'write', 'manage')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(team_id, product_line)
);

-- ─── 5. entries 表新增多租户字段 ─────────────────────────

ALTER TABLE memory.entries
    ADD COLUMN IF NOT EXISTS org_id      UUID REFERENCES memory.organizations(id),
    ADD COLUMN IF NOT EXISTS team_id     UUID REFERENCES memory.teams(id),
    ADD COLUMN IF NOT EXISTS visibility  VARCHAR(20) NOT NULL DEFAULT 'personal'
                            CHECK (visibility IN ('personal', 'team', 'product_line', 'global'));

CREATE INDEX IF NOT EXISTS idx_entries_org_id ON memory.entries(org_id);
CREATE INDEX IF NOT EXISTS idx_entries_team_id ON memory.entries(team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_visibility ON memory.entries(visibility);

-- 复合索引：org 硬隔离 + visibility 分级查询
CREATE INDEX IF NOT EXISTS idx_entries_org_visibility
    ON memory.entries(org_id, visibility)
    WHERE is_archived = FALSE;

COMMENT ON COLUMN memory.entries.org_id IS '所属组织（org 级硬隔离，不可跨越）';
COMMENT ON COLUMN memory.entries.team_id IS '所属团队（team 级软隔离，personal 级数据为 NULL）';
COMMENT ON COLUMN memory.entries.visibility IS '可见性级别：personal（仅创建者）/ team（同团队）/ product_line（产品线）/ global（全局）';

-- ─── 6. 创建默认团队并迁移现有数据 ────────────────────────

DO $$
DECLARE
    v_default_org_id UUID;
    v_default_team_id UUID;
BEGIN
    SELECT id INTO v_default_org_id FROM memory.organizations LIMIT 1;

    IF v_default_org_id IS NULL THEN
        RAISE NOTICE '无默认组织，跳过数据迁移';
        RETURN;
    END IF;

    -- 创建默认团队
    INSERT INTO memory.teams (id, org_id, name, slug, description)
    VALUES (
        gen_random_uuid(),
        v_default_org_id,
        'Default Team',
        'default-team',
        '默认团队（多租户迁移自动创建）'
    )
    ON CONFLICT (org_id, slug) DO NOTHING
    RETURNING id INTO v_default_team_id;

    IF v_default_team_id IS NULL THEN
        SELECT id INTO v_default_team_id
        FROM memory.teams
        WHERE org_id = v_default_org_id AND slug = 'default-team';
    END IF;

    -- 将所有现有用户加入默认团队（设为主团队）
    INSERT INTO memory.team_members (team_id, user_id, role, is_primary)
    SELECT v_default_team_id, u.id,
           CASE WHEN u.is_super_admin = TRUE THEN 'owner' ELSE 'member' END,
           TRUE
    FROM memory.users u
    WHERE u.org_id = v_default_org_id
      AND NOT EXISTS (
          SELECT 1 FROM memory.team_members tm
          WHERE tm.team_id = v_default_team_id AND tm.user_id = u.id
      );

    -- 回填 entries 的 org_id
    UPDATE memory.entries
    SET org_id = v_default_org_id
    WHERE org_id IS NULL;

    -- 有 created_by 的记忆 → personal
    UPDATE memory.entries
    SET visibility = 'personal'
    WHERE created_by IS NOT NULL AND visibility = 'personal';

    -- 无归属的记忆 → team
    UPDATE memory.entries
    SET visibility = 'team',
        team_id = v_default_team_id
    WHERE created_by IS NULL;

    -- _global_ 项目的记忆设为 global visibility
    UPDATE memory.entries
    SET visibility = 'global'
    WHERE project_id = '_global_';

    -- 产品线级记忆（metadata 中标记了 visibility=product_line 的）
    UPDATE memory.entries
    SET visibility = 'product_line'
    WHERE metadata->>'visibility' = 'product_line';

    -- team 级记忆关联到默认团队
    UPDATE memory.entries
    SET team_id = v_default_team_id
    WHERE visibility = 'team' AND team_id IS NULL;

    RAISE NOTICE '多租户迁移完成: org=%, team=%', v_default_org_id, v_default_team_id;
END $$;

-- ─── 7. 将现有产品线关联到默认团队 ──────────────────────

INSERT INTO memory.team_product_lines (team_id, product_line, access_level)
SELECT t.id, pl.name, 'manage'
FROM memory.teams t
CROSS JOIN memory.product_lines pl
WHERE t.slug = 'default-team'
  AND NOT EXISTS (
      SELECT 1 FROM memory.team_product_lines tpl
      WHERE tpl.team_id = t.id AND tpl.product_line = pl.name
  );

COMMIT;
