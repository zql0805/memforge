-- 031-backfill-knowledge-categories.sql
-- 将 knowledge_items.category 中已有的分类回填到 knowledge_categories 表
-- 幂等执行：利用 ON CONFLICT DO NOTHING

BEGIN;
INSERT INTO memory.knowledge_categories (name, slug, product_line)
SELECT
  INITCAP(REPLACE(REPLACE(ki.category, '-', ' '), '_', ' ')) AS name,
  ki.category AS slug,
  ki.product_line
FROM (
  SELECT DISTINCT category, product_line
  FROM memory.knowledge_items
  WHERE category IS NOT NULL
) ki
ON CONFLICT (slug, COALESCE(product_line, '_global_')) DO NOTHING;

COMMIT;
