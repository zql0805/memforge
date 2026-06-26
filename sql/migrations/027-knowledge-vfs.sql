-- P5: knowledge VFS interface — 为知识条目添加文件系统语义
-- slug: 条目在分类内的唯一标识（如 redis-timeout）
-- full_path: 分类的完整路径（如 /faq/redis）

BEGIN;
SET search_path TO memory, public;

ALTER TABLE memory.knowledge_items
  ADD COLUMN IF NOT EXISTS slug TEXT;

ALTER TABLE memory.knowledge_categories
  ADD COLUMN IF NOT EXISTS full_path TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_slug_category
  ON memory.knowledge_items(category, slug) WHERE slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kb_category_path
  ON memory.knowledge_categories(full_path) WHERE full_path IS NOT NULL;

COMMENT ON COLUMN memory.knowledge_items.slug IS 'VFS 标识符，如 redis-timeout，分类内唯一';
COMMENT ON COLUMN memory.knowledge_categories.full_path IS '分类完整路径，如 /faq/redis，用于 VFS URI 解析';

COMMIT;
