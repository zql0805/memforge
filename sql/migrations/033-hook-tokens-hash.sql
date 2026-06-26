-- 033: Hook Token 哈希存储（明文 token 列迁移为 SHA-256）

BEGIN;

ALTER TABLE memory.hook_tokens ADD COLUMN IF NOT EXISTS token_prefix VARCHAR(16);

UPDATE memory.hook_tokens
SET token_prefix = substring(token, 1, 10),
    token = encode(digest(token, 'sha256'), 'hex')
WHERE token LIKE 'mfh_%' AND length(token) <> 64;

CREATE INDEX IF NOT EXISTS idx_hook_tokens_prefix_hash
  ON memory.hook_tokens(token_prefix, token) WHERE is_active = TRUE;

COMMENT ON COLUMN memory.hook_tokens.token_prefix IS 'Token 前缀（mfh_ + 前 7 位 hex），用于哈希查找';

COMMIT;
