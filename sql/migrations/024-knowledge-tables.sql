-- 024: Memforge Knowledge Base — 知识库核心表
-- Created by dev on 2026/05/21

BEGIN;
SET search_path TO memory, public;

-- zhparser 中文分词（创建到 public schema 确保全局可见）
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS zhparser;
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'zhcfg' AND cfgnamespace = 'public'::regnamespace) THEN
    CREATE TEXT SEARCH CONFIGURATION public.zhcfg (PARSER = zhparser);
    ALTER TEXT SEARCH CONFIGURATION public.zhcfg ADD MAPPING FOR n,v,a,i,e,l WITH simple;
  END IF;
  RAISE NOTICE 'zhparser loaded, public.zhcfg ready';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'zhparser not available (%), fallback to simple', SQLERRM;
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'zhcfg' AND cfgnamespace = 'public'::regnamespace) THEN
    CREATE TEXT SEARCH CONFIGURATION public.zhcfg (COPY = simple);
  END IF;
END$$;

-- 双语 FTS 包装函数
-- 1) plpgsql 阻止内联，使 IMMUTABLE 声明被信任
-- 2) 接收 text[] 避免 STABLE 的 array_to_string 出现在 GENERATED 表达式中
CREATE OR REPLACE FUNCTION memory.kb_fts(
  p_title text, p_question text, p_answer text, p_tags text[], p_media text
) RETURNS tsvector
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  combined text;
BEGIN
  combined := coalesce(p_title, '') || ' ' || coalesce(p_question, '') || ' ' ||
              coalesce(p_answer, '') || ' ' || coalesce(array_to_string(p_tags, ' '), '') || ' ' ||
              coalesce(p_media, '');
  RETURN to_tsvector('english', combined) || to_tsvector('zhcfg'::regconfig, combined);
END;
$$;

-- knowledge_items 主表
CREATE TABLE IF NOT EXISTS memory.knowledge_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL,
  product_line TEXT,
  knowledge_type TEXT NOT NULL DEFAULT 'faq'
    CHECK (knowledge_type IN ('faq', 'technical', 'project', 'incident', 'api_reference')),
  category TEXT,
  subcategory TEXT,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  answer_type TEXT DEFAULT 'direct'
    CHECK (answer_type IN ('direct', 'guide', 'escalate')),
  embedding vector(1024),
  media_text TEXT DEFAULT '',
  fts_vector tsvector GENERATED ALWAYS AS (
    memory.kb_fts(title, question, answer, tags, media_text)
  ) STORED,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  version INT DEFAULT 1,
  verified_by TEXT,
  verified_at TIMESTAMPTZ,
  helpful_count INT DEFAULT 0,
  unhelpful_count INT DEFAULT 0,
  query_count INT DEFAULT 0,
  media JSONB DEFAULT '[]',
  source_type TEXT CHECK (source_type IN ('manual', 'ticket', 'document', 'api_scan')),
  source_ref TEXT,
  visibility TEXT DEFAULT 'product_line'
    CHECK (visibility IN ('personal', 'team', 'product_line', 'global')),
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE memory.knowledge_items IS 'Memforge 知识库条目';
COMMENT ON COLUMN memory.knowledge_items.media_text IS 'Vision 提取的图片描述文本，参与 fts_vector 索引';
COMMENT ON COLUMN memory.knowledge_items.fts_vector IS '双语全文索引（english 词干 + zhcfg 中文分词）';

CREATE INDEX IF NOT EXISTS idx_kb_embedding ON memory.knowledge_items
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_kb_fts ON memory.knowledge_items
  USING gin (fts_vector) WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_kb_project_type ON memory.knowledge_items
  (project_id, knowledge_type, category) WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_kb_tags ON memory.knowledge_items
  USING gin (tags) WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_kb_product_line ON memory.knowledge_items
  (product_line, status);

ALTER TABLE memory.knowledge_items ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kb_items_all') THEN
    CREATE POLICY kb_items_all ON memory.knowledge_items FOR ALL USING (TRUE);
  END IF;
END$$;

CREATE OR REPLACE FUNCTION memory.update_kb_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kb_updated_at ON memory.knowledge_items;
CREATE TRIGGER trg_kb_updated_at
  BEFORE UPDATE ON memory.knowledge_items
  FOR EACH ROW EXECUTE FUNCTION memory.update_kb_timestamp();

-- knowledge_feedback 反馈表
CREATE TABLE IF NOT EXISTS memory.knowledge_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_id UUID NOT NULL
    REFERENCES memory.knowledge_items(id) ON DELETE CASCADE,
  ticket_id TEXT,
  helpful BOOLEAN NOT NULL,
  comment TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE memory.knowledge_feedback IS '知识条目反馈（有用/无用）';

CREATE INDEX IF NOT EXISTS idx_kf_knowledge ON memory.knowledge_feedback(knowledge_id);
CREATE INDEX IF NOT EXISTS idx_kf_ticket ON memory.knowledge_feedback(ticket_id);

ALTER TABLE memory.knowledge_feedback ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kb_feedback_all') THEN
    CREATE POLICY kb_feedback_all ON memory.knowledge_feedback FOR ALL USING (TRUE);
  END IF;
END$$;

COMMIT;
