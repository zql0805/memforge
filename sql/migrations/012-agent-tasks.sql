-- Memforge Agent Task System — 数据库迁移
-- Created by dev on 2026/04/12

BEGIN;
SET search_path TO memory, public;

-- ─── 任务主表 ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory.agent_tasks (
    id              SERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES memory.users(id),
    title           VARCHAR(500) NOT NULL,
    description     TEXT,
    category        VARCHAR(100) NOT NULL DEFAULT 'general',
    priority        VARCHAR(10)  DEFAULT 'P2'
                    CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
    status          VARCHAR(20)  DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
    product_line    VARCHAR(100),
    project         VARCHAR(200),
    tags            TEXT[]       DEFAULT '{}',
    related_items   JSONB        DEFAULT '[]',

    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    execution_summary   TEXT,
    execution_issues    TEXT,
    conversation_id     VARCHAR(200),
    history_file_path   VARCHAR(500),
    last_heartbeat      TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      VARCHAR(100) DEFAULT 'user',
    sort_order      INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_status
    ON memory.agent_tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_category
    ON memory.agent_tasks(category);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_product_line
    ON memory.agent_tasks(product_line);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_priority
    ON memory.agent_tasks(priority);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_created_at
    ON memory.agent_tasks(created_at DESC);

ALTER TABLE memory.agent_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_tasks_rls ON memory.agent_tasks USING (TRUE) WITH CHECK (TRUE);

-- ─── 任务执行日志表 ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory.agent_task_logs (
    id         SERIAL PRIMARY KEY,
    task_id    INT NOT NULL REFERENCES memory.agent_tasks(id) ON DELETE CASCADE,
    level      VARCHAR(10) DEFAULT 'info'
               CHECK (level IN ('info', 'warn', 'error', 'debug')),
    message    TEXT NOT NULL,
    metadata   JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_task_logs_task_id
    ON memory.agent_task_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_task_logs_level
    ON memory.agent_task_logs(level);

ALTER TABLE memory.agent_task_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_task_logs_rls ON memory.agent_task_logs USING (TRUE) WITH CHECK (TRUE);

-- ─── 自动更新 updated_at ──────────────────────────────────

CREATE OR REPLACE FUNCTION memory.update_agent_task_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_task_updated_at
    BEFORE UPDATE ON memory.agent_tasks
    FOR EACH ROW
    EXECUTE FUNCTION memory.update_agent_task_timestamp();

COMMIT;
