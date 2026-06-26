-- 008: entries 表增加 is_verified 列（知识质量门控）
-- Created by dev on 2026/04/09

ALTER TABLE memory.entries
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entries_is_verified
  ON memory.entries(is_verified)
  WHERE is_verified = TRUE;

COMMENT ON COLUMN memory.entries.is_verified IS '是否经过 lead/admin 审核确认（verified 记忆在 recall 时获得排序加权）';
