-- 028: 自动 Code Review 结果表 + 通知日志表
-- 依赖: 代码智能管道技术设计 §九

BEGIN;
SET search_path TO memory, public;

CREATE TABLE IF NOT EXISTS memory.code_reviews (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      VARCHAR(255) NOT NULL,
    product_line    VARCHAR(255),
    commit_hash     VARCHAR(64) NOT NULL,
    repo_id         VARCHAR(255) NOT NULL,
    branch          VARCHAR(255),
    author          VARCHAR(255),
    classification  VARCHAR(50) NOT NULL,
    findings        JSONB NOT NULL DEFAULT '[]',
    summary         TEXT,
    diff_preview    TEXT,
    context_used    JSONB DEFAULT '{}',
    notified        BOOLEAN NOT NULL DEFAULT FALSE,
    notified_at     TIMESTAMPTZ,
    llm_skipped     BOOLEAN NOT NULL DEFAULT FALSE,
    diff_truncated  BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata        JSONB DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_code_reviews_repo_commit
    ON memory.code_reviews(repo_id, commit_hash);
CREATE INDEX IF NOT EXISTS idx_code_reviews_repo
    ON memory.code_reviews(repo_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_code_reviews_severity
    ON memory.code_reviews USING GIN (findings jsonb_path_ops);

CREATE TABLE IF NOT EXISTS memory.notification_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel         VARCHAR(50) NOT NULL,
    event_type      VARCHAR(50) NOT NULL,
    event_ref       VARCHAR(255),
    payload         JSONB NOT NULL,
    status          VARCHAR(20) NOT NULL,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_log_event_ref
    ON memory.notification_log(event_ref);
CREATE INDEX IF NOT EXISTS idx_notification_log_created
    ON memory.notification_log(created_at);

COMMIT;
