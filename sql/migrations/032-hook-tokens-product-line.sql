-- 032: Hook Token 绑定产品线
-- 每个 token 绑定 product_line，Gateway 通过 token 反查归属，实现写入隔离

BEGIN;
ALTER TABLE memory.hook_tokens ADD COLUMN IF NOT EXISTS product_line VARCHAR(255);
ALTER TABLE memory.hook_tokens ADD COLUMN IF NOT EXISTS repo_path TEXT;
ALTER TABLE memory.hook_tokens ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);

COMMENT ON COLUMN memory.hook_tokens.product_line IS 'Token 绑定的产品线，Gateway 验证时反查';
COMMENT ON COLUMN memory.hook_tokens.repo_path IS '安装 hook 时的仓库路径（审计用）';
COMMENT ON COLUMN memory.hook_tokens.created_by IS '创建 token 的用户 ID';

CREATE INDEX IF NOT EXISTS idx_hook_tokens_product_line
  ON memory.hook_tokens(product_line) WHERE is_active = TRUE;

COMMIT;
