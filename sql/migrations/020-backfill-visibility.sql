-- 020-backfill-visibility.sql
-- 为 visibility IS NULL 的记忆条目补设合理默认值
-- 创建日期：2026-05-07
-- 修正日期：2026-05-13 —— 将 'project' 改为 'personal'（与 CHECK 约束一致）

BEGIN;

-- 有创建者的条目：默认为 personal 级别（仅创建者可见）
UPDATE memory.entries
SET visibility = 'personal'
WHERE visibility IS NULL
  AND created_by IS NOT NULL;

-- 无创建者的系统条目（bootstrap/自动索引）：默认为 global
UPDATE memory.entries
SET visibility = 'global'
WHERE visibility IS NULL
  AND created_by IS NULL;

-- 设置列默认值，确保后续插入不会产生 NULL
ALTER TABLE memory.entries ALTER COLUMN visibility SET DEFAULT 'personal';

COMMIT;
