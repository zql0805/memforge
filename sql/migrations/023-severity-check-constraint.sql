-- 023: 添加 severity CHECK 约束，防止非标准值写入
-- Created by dev on 2026/05/09

-- 先清理已有的非标准值（幂等，如已清理则无影响）

BEGIN;
UPDATE memory.rules SET severity = 'critical' WHERE severity IN ('P0', 'must');
UPDATE memory.rules SET severity = 'error' WHERE severity = 'mandatory';
UPDATE memory.rules SET severity = 'warning' WHERE severity = 'recommended';

-- 添加 CHECK 约束（幂等：先删除再创建）
ALTER TABLE memory.rules
  DROP CONSTRAINT IF EXISTS chk_severity;

ALTER TABLE memory.rules
  ADD CONSTRAINT chk_severity
  CHECK (severity IN ('critical', 'error', 'warning', 'info'));

COMMIT;
