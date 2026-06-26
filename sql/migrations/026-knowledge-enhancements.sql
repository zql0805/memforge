-- P0.5: knowledge_items 多维度隔离 — 对齐 entries 表的 team_id/org_id 隔离模型
-- P1: entries 分层摘要 — 新增 abstract 字段用于 recall_memory 轻量返回

BEGIN;
SET search_path TO memory, public;

-- P0.5: knowledge_items team_id + org_id
ALTER TABLE memory.knowledge_items
  ADD COLUMN IF NOT EXISTS team_id TEXT,
  ADD COLUMN IF NOT EXISTS org_id TEXT;

CREATE INDEX IF NOT EXISTS idx_kb_team ON memory.knowledge_items(team_id)
  WHERE team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kb_org ON memory.knowledge_items(org_id)
  WHERE org_id IS NOT NULL;

COMMENT ON COLUMN memory.knowledge_items.team_id IS '团队标识，对齐 entries 表隔离模型';
COMMENT ON COLUMN memory.knowledge_items.org_id IS '组织标识，对齐 entries 表隔离模型';

-- P1: entries abstract
ALTER TABLE memory.entries
  ADD COLUMN IF NOT EXISTS abstract TEXT;

COMMENT ON COLUMN memory.entries.abstract
  IS '一句话摘要（<200字符），recall_memory 轻量返回时使用';

COMMIT;
