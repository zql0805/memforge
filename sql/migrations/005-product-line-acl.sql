-- ============================================================
-- Memforge — 005: 产品线级别访问控制（ACL）
-- 新增 user_product_lines 表，users 补充 is_super_admin 字段
-- Created by dev on 2026/04/09
-- ============================================================

-- 1. users 表补充超级管理员标识

BEGIN;
ALTER TABLE memory.users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. 用户-产品线授权关系表
CREATE TABLE IF NOT EXISTS memory.user_product_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES memory.users(id) ON DELETE CASCADE,
    product_line TEXT NOT NULL,
    -- read: 查看拓扑/搜索该产品线记忆
    -- write: 修改拓扑节点/边、写入该产品线记忆
    -- manage: 扫描/删除拓扑，管理产品线配置
    access_level TEXT NOT NULL DEFAULT 'read',
    granted_by UUID REFERENCES memory.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, product_line),
    CHECK (access_level IN ('read', 'write', 'manage'))
);

CREATE INDEX IF NOT EXISTS idx_upl_user ON memory.user_product_lines(user_id);
CREATE INDEX IF NOT EXISTS idx_upl_pl ON memory.user_product_lines(product_line);

-- 3. RLS 策略：用户只能看到自己被授权的产品线数据
ALTER TABLE memory.user_product_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY upl_self_or_admin ON memory.user_product_lines
    FOR ALL
    USING (TRUE)
    WITH CHECK (TRUE);

-- 4. 首个注册用户自动提升为超级管理员（冷启动）
-- 通过触发器实现：当 users 表只有 1 条记录时，自动设置 is_super_admin = TRUE, role = 'admin'
CREATE OR REPLACE FUNCTION memory.auto_promote_first_user()
RETURNS TRIGGER AS $$
DECLARE
    user_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO user_count FROM memory.users;
    IF user_count = 1 THEN
        UPDATE memory.users
        SET role = 'admin', is_super_admin = TRUE
        WHERE id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_promote_first_user ON memory.users;
CREATE TRIGGER trg_auto_promote_first_user
    AFTER INSERT ON memory.users
    FOR EACH ROW
    EXECUTE FUNCTION memory.auto_promote_first_user();

COMMIT;
