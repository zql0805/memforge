-- 034: 清理 knowledge_items 中的重复条目
-- 背景：cleanup API 之前未支持 source_ref_prefix，导致 deep-index 多次运行后可能产生重复
-- 策略：按 (project_id, title, source_type) 分组，保留 id 最大（最新）的那条，删除其余
-- Created: 2026-06-02

BEGIN;

DELETE FROM memory.knowledge_items
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY project_id, title, source_type
             ORDER BY created_at DESC, id DESC
           ) AS rn
    FROM memory.knowledge_items
  ) ranked
  WHERE rn > 1
);

COMMIT;
