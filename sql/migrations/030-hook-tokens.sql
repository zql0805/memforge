-- 030: Hook Token 存储表
-- 用于 Git Hook API 的 Token 验证（替代简单的长度检查）

BEGIN;
CREATE TABLE IF NOT EXISTS memory.hook_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token       VARCHAR(255) NOT NULL UNIQUE,
    user_id     VARCHAR(255),
    project_id  VARCHAR(255),
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    last_used   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hook_tokens_token ON memory.hook_tokens(token) WHERE is_active = TRUE;

COMMIT;
