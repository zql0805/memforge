-- 025: Knowledge Base V4 Redesign — Q&A model → Unified Knowledge Entry
-- Created by dev on 2026/05/21

BEGIN;
SET search_path TO memory, public;

-- ─── 1. Drop FTS generated column (depends on old kb_fts signature) ───
DROP INDEX IF EXISTS memory.idx_kb_fts;

ALTER TABLE memory.knowledge_items
  DROP COLUMN IF EXISTS fts_vector;

-- ─── 2. Drop old kb_fts function ───
DROP FUNCTION IF EXISTS memory.kb_fts(text, text, text, text[], text);

-- ─── 3–7. V3 → V4 column changes ───
ALTER TABLE memory.knowledge_items
  RENAME COLUMN answer TO content;

ALTER TABLE memory.knowledge_items
  ALTER COLUMN question DROP NOT NULL;

ALTER TABLE memory.knowledge_items
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

ALTER TABLE memory.knowledge_items
  DROP COLUMN IF EXISTS subcategory;

-- ─── 8. Extend knowledge_type enum values ───
ALTER TABLE memory.knowledge_items
  DROP CONSTRAINT IF EXISTS knowledge_items_knowledge_type_check;

ALTER TABLE memory.knowledge_items
  ADD CONSTRAINT knowledge_items_knowledge_type_check
  CHECK (knowledge_type IN (
    'faq', 'how_to', 'troubleshooting', 'technical',
    'incident', 'runbook', 'api_reference'
  ));

-- ─── 14. answer_type CHECK unchanged (direct / guide / escalate) ───
-- content retains NOT NULL from former answer column; no DB-level length CHECK

-- ─── 9. New bilingual FTS function (title, question, content, summary, tags, media_text) ───
CREATE OR REPLACE FUNCTION memory.kb_fts(
  p_title text, p_question text, p_content text,
  p_summary text, p_tags text[], p_media text
) RETURNS tsvector
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  combined text;
BEGIN
  combined := coalesce(p_title, '') || ' ' || coalesce(p_question, '') || ' ' ||
              coalesce(p_content, '') || ' ' || coalesce(p_summary, '') || ' ' ||
              coalesce(array_to_string(p_tags, ' '), '') || ' ' ||
              coalesce(p_media, '');
  RETURN to_tsvector('english', combined) || to_tsvector('zhcfg'::regconfig, combined);
END;
$$;

-- ─── 10. Re-add FTS generated column ───
ALTER TABLE memory.knowledge_items
  ADD COLUMN fts_vector tsvector GENERATED ALWAYS AS (
    memory.kb_fts(title, question, content, summary, tags, media_text)
  ) STORED;

COMMENT ON COLUMN memory.knowledge_items.content IS '知识正文（V4 统一内容字段，原 answer）';
COMMENT ON COLUMN memory.knowledge_items.summary IS '可选摘要，用于列表展示与 FTS';
COMMENT ON COLUMN memory.knowledge_items.metadata IS '类型特定的结构化扩展数据（JSONB）';
COMMENT ON COLUMN memory.knowledge_items.fts_vector IS '双语全文索引（english 词干 + zhcfg 中文分词）';

-- ─── 11. Re-create GIN index on fts_vector ───
CREATE INDEX IF NOT EXISTS idx_kb_fts ON memory.knowledge_items
  USING gin (fts_vector) WHERE status = 'published';

-- ─── 12. knowledge_categories 分类表 ───
CREATE TABLE IF NOT EXISTS memory.knowledge_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  parent_id UUID REFERENCES memory.knowledge_categories(id) ON DELETE SET NULL,
  description TEXT,
  product_line TEXT,
  icon TEXT,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- UNIQUE(slug, COALESCE(product_line, '_global_')) — expression unique via index
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_categories_slug_pl
  ON memory.knowledge_categories (slug, COALESCE(product_line, '_global_'));

COMMENT ON TABLE memory.knowledge_categories IS '知识库分类树（WebUI 下拉选择，替代手动输入 category）';

-- ─── 13. Indexes and RLS for categories ───
CREATE INDEX IF NOT EXISTS idx_kb_cat_parent ON memory.knowledge_categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_kb_cat_product_line ON memory.knowledge_categories(product_line);
CREATE INDEX IF NOT EXISTS idx_kb_cat_sort ON memory.knowledge_categories(product_line, sort_order);

ALTER TABLE memory.knowledge_categories ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kb_categories_all') THEN
    CREATE POLICY kb_categories_all ON memory.knowledge_categories FOR ALL USING (TRUE);
  END IF;
END$$;

COMMIT;
