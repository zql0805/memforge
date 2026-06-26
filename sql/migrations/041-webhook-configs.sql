-- 041: GitLab Webhook 配置管理表

BEGIN;
SET search_path TO memory, public;

CREATE TABLE IF NOT EXISTS memory.webhook_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform VARCHAR(20) NOT NULL DEFAULT 'gitlab',
  instance_url TEXT NOT NULL,
  project_path TEXT NOT NULL,
  product_line VARCHAR(100),
  webhook_id INTEGER,
  webhook_secret TEXT NOT NULL DEFAULT '***',
  webhook_secret_hash VARCHAR(64),
  is_active BOOLEAN DEFAULT TRUE,
  events TEXT[] DEFAULT '{"push_events","merge_requests_events"}',
  created_by VARCHAR(255),
  user_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (platform, instance_url, project_path)
);

CREATE INDEX IF NOT EXISTS idx_webhook_configs_product_line
  ON memory.webhook_configs (product_line) WHERE is_active = TRUE;

COMMENT ON COLUMN memory.webhook_configs.webhook_secret IS 'Webhook 验证密钥（每个项目唯一）';
COMMENT ON COLUMN memory.webhook_configs.created_by IS '创建人 ID（审计用）';

COMMIT;
