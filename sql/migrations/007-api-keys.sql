-- 007: API Key 支持（长期认证令牌，供 MCP 客户端使用）
-- Created by dev on 2026/04/09

BEGIN;
CREATE TABLE IF NOT EXISTS memory.api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES memory.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT 'default',
  key_prefix  TEXT NOT NULL,
  key_hash    TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON memory.api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON memory.api_keys(key_prefix);

COMMENT ON TABLE memory.api_keys IS '用户 API 密钥，用于 MCP 客户端长期认证';
COMMENT ON COLUMN memory.api_keys.key_prefix IS '密钥前 8 字符，用于快速查找（如 mfk_abc1）';
COMMENT ON COLUMN memory.api_keys.key_hash IS 'SHA-256 哈希，验证时比对';
COMMENT ON COLUMN memory.api_keys.expires_at IS 'NULL 表示永不过期';

COMMIT;
