-- ============================================================
-- Memforge — 004: 规则体系重构
-- coding_rules → rules，新增 rule_type 列，支持多类型规范管理
-- Created by dev on 2026/04/08
-- ============================================================

-- 1. 重命名表

BEGIN;
ALTER TABLE memory.coding_rules RENAME TO rules;

-- 2. 新增 rule_type 列（一级分类）
ALTER TABLE memory.rules ADD COLUMN rule_type VARCHAR(50) NOT NULL DEFAULT 'coding';

-- 3. 创建索引
CREATE INDEX idx_rules_rule_type ON memory.rules(rule_type);
CREATE INDEX idx_rules_type_status ON memory.rules(rule_type, status);

-- 4. 对现有规则补标 rule_type
-- 4a. AI 代理行为规范
UPDATE memory.rules SET rule_type = 'ai_agent'
WHERE title IN (
    'AI 每轮回复必须调用 AskQuestion',
    'AI 变更前必须输出计划并等待确认'
);

-- 4b. 工作流程规范
UPDATE memory.rules SET rule_type = 'workflow'
WHERE title IN (
    'Commit Message 使用中文 + Conventional Commits',
    '文档分层管理——README 精简 + docs/ 详细',
    '新增后端工具时必须同步更新全链路',
    '代码变更后强制 Code Review',
    '新文件必须包含创建日期',
    '语言版本兼容性检查——禁止超版本特性',
    '禁止 Mock 数据交付——必须全链路对接',
    '禁止 Mock 数据交付'
);

-- 4c. 业务审计规范（业务审计规范（产品线红线））
UPDATE memory.rules SET rule_type = 'business'
WHERE source_ref->>'file' = 'team-code-audit-redlines.mdc'
   OR source_ref->>'file' = 'code-audit-universal.mdc';

-- 5. 更新 RLS 策略（表名已变更）
DROP POLICY IF EXISTS rules_project_isolation ON memory.rules;

CREATE POLICY rules_project_isolation ON memory.rules
    FOR ALL
    USING (
        project_id = COALESCE(
            NULLIF(current_setting('app.current_project_id', true), ''),
            project_id
        )
    )
    WITH CHECK (
        project_id = COALESCE(
            NULLIF(current_setting('app.current_project_id', true), ''),
            project_id
        )
    );

-- 6. 更新 rule_votes 外键引用（PostgreSQL RENAME 自动更新 FK，此处仅验证）
-- ALTER TABLE 后外键引用自动跟随表名变更，无需额外操作

-- 7. 验证
DO $$
DECLARE
    cnt INTEGER;
BEGIN
    SELECT COUNT(*) INTO cnt FROM memory.rules WHERE rule_type != 'coding';
    RAISE NOTICE '已分类非 coding 规则: % 条', cnt;
END $$;

COMMIT;
