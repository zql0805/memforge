-- 039: API Key scope 持久化
-- Created by dev on 2026/06/12

BEGIN;

ALTER TABLE memory.api_keys
  ADD COLUMN IF NOT EXISTS scope VARCHAR(20) NOT NULL DEFAULT 'readwrite';

ALTER TABLE memory.api_keys
  DROP CONSTRAINT IF EXISTS chk_api_key_scope;
ALTER TABLE memory.api_keys
  ADD CONSTRAINT chk_api_key_scope CHECK (scope IN ('read', 'readwrite', 'admin'));

COMMENT ON COLUMN memory.api_keys.scope IS '权限范围: read / readwrite / admin';

COMMIT;
