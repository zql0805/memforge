-- 003: 为 memory.entries 添加 created_by 归属标记
-- 用于开发者画像等个人维度功能的按用户过滤，不影响 recall_memory 等知识共享读取路径

BEGIN;
ALTER TABLE memory.entries
  ADD COLUMN created_by TEXT;

CREATE INDEX idx_entries_created_by ON memory.entries(created_by)
  WHERE created_by IS NOT NULL;

COMMENT ON COLUMN memory.entries.created_by IS '创建该记忆的用户标识（归属标记，非访问控制）';

COMMIT;
