-- Created by dev on 2026/06/12
-- 补齐 knowledge_type CHECK 约束：shared KnowledgeType 含 project，025 迁移误删

BEGIN;

ALTER TABLE memory.knowledge_items
  DROP CONSTRAINT IF EXISTS knowledge_items_knowledge_type_check;

ALTER TABLE memory.knowledge_items
  ADD CONSTRAINT knowledge_items_knowledge_type_check
  CHECK (knowledge_type IN (
    'faq', 'how_to', 'troubleshooting', 'technical', 'project',
    'incident', 'runbook', 'api_reference'
  ));

COMMIT;
