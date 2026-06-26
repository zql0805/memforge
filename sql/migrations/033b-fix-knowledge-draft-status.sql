-- 033: 修复 knowledge_items 的 status 默认值问题
-- 背景：store API 之前未传递 status 字段，所有条目默认为 draft，导致搜索不可见
-- 此迁移将所有 draft 条目批量更新为 published，并将表默认值改为 published
-- Created: 2026-06-02

BEGIN;

-- 1) 将已有 draft 条目全部改为 published
UPDATE memory.knowledge_items
SET status = 'published', updated_at = NOW()
WHERE status = 'draft';

-- 2) 修改表默认值，新插入的条目默认为 published
ALTER TABLE memory.knowledge_items
  ALTER COLUMN status SET DEFAULT 'published';

COMMIT;
