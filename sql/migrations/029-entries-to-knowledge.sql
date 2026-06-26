-- 029: 将适合知识库的记忆条目迁移到 knowledge_items
-- 依赖: 代码智能管道技术设计 §三.4
-- 迁移范围: domain_knowledge, api_reference, coding_standard, convention

BEGIN;
SET search_path TO memory, public;

INSERT INTO memory.knowledge_items (
  project_id, product_line, title, question, content, knowledge_type,
  source_type, source_ref, tags, visibility,
  status, created_at
)
SELECT
  e.project_id,
  e.metadata->>'product_line',
  e.title,
  e.title,
  e.content,
  CASE e.scope
    WHEN 'api_reference' THEN 'api_reference'
    ELSE 'technical'
  END,
  'document',
  e.id::text,
  e.tags,
  COALESCE(e.visibility, 'personal'),
  'published',
  e.created_at
FROM memory.entries e
WHERE e.scope IN ('domain_knowledge', 'api_reference', 'coding_standard', 'convention')
AND NOT EXISTS (
  SELECT 1 FROM memory.knowledge_items ki WHERE ki.source_ref = e.id::text
);

UPDATE memory.entries e
SET metadata = COALESCE(e.metadata, '{}'::jsonb) || '{"migrated_to_knowledge": true}'::jsonb
WHERE e.scope IN ('domain_knowledge', 'api_reference', 'coding_standard', 'convention')
AND EXISTS (
  SELECT 1 FROM memory.knowledge_items ki WHERE ki.source_ref = e.id::text
);

COMMIT;
