-- 035: 删除 memory.branches 设计残留表
-- 背景：branches 表在 init.sql 中定义，但无任何代码引用（entries.branch_id 为 TEXT 类型非外键）
-- memory 系统实际通过 batch-index 脚本在本地检测 git 分支，不依赖此表
-- Created: 2026-06-03

BEGIN;

DROP INDEX IF EXISTS memory.idx_branches_project_active;
DROP TABLE IF EXISTS memory.branches;

COMMIT;
