-- ============================================================
-- Memforge — B2: RLS 策略加固（从 USING(TRUE) 升级为实际租户隔离）
-- Created by dev on 2026/04/05
-- ============================================================
-- 执行前提：确保应用连接设置了 app.current_project_id

-- 1. 删除旧的宽松策略

BEGIN;
DROP POLICY IF EXISTS entries_isolation ON memory.entries;
DROP POLICY IF EXISTS rules_isolation ON memory.coding_rules;
DROP POLICY IF EXISTS skill_defs_isolation ON memory.skill_definitions;
DROP POLICY IF EXISTS auto_init_rls ON memory.auto_init_state;

-- 2. 记忆条目：按 project_id 隔离
-- 应用层在每个连接上设置 SET app.current_project_id = 'xxx'
CREATE POLICY entries_project_isolation ON memory.entries
    FOR ALL
    USING (
        current_setting('app.current_user_role', true) IN ('service', 'admin')
        OR (
            NULLIF(current_setting('app.current_project_id', true), '') IS NOT NULL
            AND project_id = current_setting('app.current_project_id', true)
        )
    )
    WITH CHECK (
        current_setting('app.current_user_role', true) IN ('service', 'admin')
        OR (
            NULLIF(current_setting('app.current_project_id', true), '') IS NOT NULL
            AND project_id = current_setting('app.current_project_id', true)
        )
    );

-- 3. 编码规则：同上
CREATE POLICY rules_project_isolation ON memory.coding_rules
    FOR ALL
    USING (
        current_setting('app.current_user_role', true) IN ('service', 'admin')
        OR (
            NULLIF(current_setting('app.current_project_id', true), '') IS NOT NULL
            AND project_id = current_setting('app.current_project_id', true)
        )
    )
    WITH CHECK (
        current_setting('app.current_user_role', true) IN ('service', 'admin')
        OR (
            NULLIF(current_setting('app.current_project_id', true), '') IS NOT NULL
            AND project_id = current_setting('app.current_project_id', true)
        )
    );

-- 4. 技能定义：保持组织级隔离
CREATE POLICY skill_defs_org_isolation ON memory.skill_definitions
    FOR ALL
    USING (
        current_setting('app.current_user_role', true) IN ('service', 'admin')
        OR (
            NULLIF(current_setting('app.current_org_id', true), '') IS NOT NULL
            AND org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        )
    )
    WITH CHECK (
        current_setting('app.current_user_role', true) IN ('service', 'admin')
        OR (
            NULLIF(current_setting('app.current_org_id', true), '') IS NOT NULL
            AND org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        )
    );

-- 5. 自动化状态：按 project_id 隔离
CREATE POLICY auto_init_project_isolation ON memory.auto_init_state
    FOR ALL
    USING (
        current_setting('app.current_user_role', true) IN ('service', 'admin')
        OR (
            NULLIF(current_setting('app.current_project_id', true), '') IS NOT NULL
            AND project_id = current_setting('app.current_project_id', true)
        )
    )
    WITH CHECK (
        current_setting('app.current_user_role', true) IN ('service', 'admin')
        OR (
            NULLIF(current_setting('app.current_project_id', true), '') IS NOT NULL
            AND project_id = current_setting('app.current_project_id', true)
        )
    );

-- 未设置 RLS context 时拒绝访问；service/admin 角色用于内部服务连接。
-- 多租户模式下，应用层（gateway/db.ts）需在 pool.on('connect') 中设置 SET app.current_project_id。

COMMIT;
