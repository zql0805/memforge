-- ============================================================
-- Memforge 迁移 020: 修正 visibility 默认值
-- Created by dev on 2026/05/07
--
-- 修复问题：
--   1. 迁移 016 将 created_by IS NULL 的记忆一刀切设为 team（应为 personal）
--   2. 所有 rules 的 visibility 都是 global（应按 project_id 分级）
--   3. rules 表列默认值从 global 改为 personal
--   4. created_by IS NULL + personal 的记忆对所有人不可见（孤儿记忆问题）
--
-- 原则：
--   - 有创建者的记忆默认 personal，仅通过显式操作升级
--   - 无创建者的历史记忆设为 team（多租户前的数据，团队成员可见）
-- ============================================================

BEGIN;

-- ─── 1. 修复 entries visibility ──────────────────────────────
-- 迁移 016 将 created_by IS NULL 的记忆错误设为 team

-- 1a. 有创建者的 team 记忆 → personal（016 之前的旧数据被错误升级）
UPDATE memory.entries
SET visibility = 'personal',
    team_id = NULL
WHERE visibility = 'team'
  AND created_by IS NOT NULL
  AND created_at < '2026-05-06T00:00:00+08:00';

-- 1b. 无创建者的记忆 → team（历史数据，保持团队可见）
-- 这些记忆没有明确的创建者，设为 personal 会导致任何人都无法访问
-- 分配到默认团队 Default Team
UPDATE memory.entries
SET visibility = 'team',
    team_id = '13aa1c16-a346-44d4-92ad-a76f66f38a5e'
WHERE created_by IS NULL
  AND (visibility = 'personal' OR visibility = 'team');

-- ─── 2. 修复 rules visibility ────────────────────────────────

-- 2a. mediav 项目的规则降级为 product_line
UPDATE memory.rules
SET visibility = 'product_line'
WHERE project_id = 'mediav'
  AND visibility = 'global';

-- 2b. default 项目的规则降级为 product_line
UPDATE memory.rules
SET visibility = 'product_line'
WHERE project_id = 'default'
  AND visibility = 'global';

-- ─── 3. 修改 rules 表列默认值 ───────────────────────────────

ALTER TABLE memory.rules
    ALTER COLUMN visibility SET DEFAULT 'personal';

-- ─── 4. 验证数据 ────────────────────────────────────────────

DO $$
DECLARE
    v_entries_team INTEGER;
    v_entries_personal INTEGER;
    v_entries_orphaned INTEGER;
    v_rules_global INTEGER;
    v_rules_pl INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_entries_team FROM memory.entries WHERE visibility = 'team';
    SELECT COUNT(*) INTO v_entries_personal FROM memory.entries WHERE visibility = 'personal';
    SELECT COUNT(*) INTO v_entries_orphaned FROM memory.entries WHERE created_by IS NULL AND visibility = 'personal';
    SELECT COUNT(*) INTO v_rules_global FROM memory.rules WHERE visibility = 'global';
    SELECT COUNT(*) INTO v_rules_pl FROM memory.rules WHERE visibility = 'product_line';

    RAISE NOTICE '迁移 020 完成:';
    RAISE NOTICE '  entries: team=%, personal=%, orphaned=%', v_entries_team, v_entries_personal, v_entries_orphaned;
    RAISE NOTICE '  rules: global=%, product_line=%', v_rules_global, v_rules_pl;

    IF v_entries_orphaned > 0 THEN
        RAISE WARNING '仍有 % 条孤儿记忆（created_by IS NULL AND visibility=personal）', v_entries_orphaned;
    END IF;
END $$;

COMMIT;
