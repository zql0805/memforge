-- Migration 019: Rules 表团队隔离
-- 为 memory.rules 表添加 team_id 和 visibility 字段，
-- 实现与 memory.entries 一致的分级可见性模型。

BEGIN;
ALTER TABLE memory.rules
    ADD COLUMN IF NOT EXISTS team_id     UUID REFERENCES memory.teams(id),
    ADD COLUMN IF NOT EXISTS visibility  VARCHAR(20) NOT NULL DEFAULT 'global'
                            CHECK (visibility IN ('personal', 'team', 'product_line', 'global'));

CREATE INDEX IF NOT EXISTS idx_rules_team_id ON memory.rules(team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rules_visibility ON memory.rules(visibility);
CREATE INDEX IF NOT EXISTS idx_rules_team_visibility
    ON memory.rules(team_id, visibility)
    WHERE status = 'active';

COMMENT ON COLUMN memory.rules.team_id IS '所属团队（team 级隔离，global/product_line 级规则为 NULL）';
COMMENT ON COLUMN memory.rules.visibility IS '可见性级别：personal（仅创建者）/ team（同团队）/ product_line（产品线）/ global（全局）';

-- 存量数据迁移策略：
-- 现有规则默认 visibility='global'（保持原有行为：所有人可见）
-- 后续新建规则会根据上下文设置适当的 team_id 和 visibility

COMMIT;
