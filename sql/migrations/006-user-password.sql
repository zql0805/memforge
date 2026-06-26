-- 006: 为用户添加密码认证支持
-- Created by dev on 2026/04/09

BEGIN;
ALTER TABLE memory.users ADD COLUMN IF NOT EXISTS password_hash TEXT;

COMMENT ON COLUMN memory.users.password_hash IS 'bcrypt 哈希密码，NULL 表示尚未设置（需要首次登录时设置）';

COMMIT;
