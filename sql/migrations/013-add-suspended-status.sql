-- Memforge Agent Task System — 增加 suspended 状态
-- Created by dev on 2026/04/12

BEGIN;
SET search_path TO memory, public;

ALTER TABLE memory.agent_tasks
    DROP CONSTRAINT IF EXISTS agent_tasks_status_check;

ALTER TABLE memory.agent_tasks
    ADD CONSTRAINT agent_tasks_status_check
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled', 'suspended'));

COMMIT;
