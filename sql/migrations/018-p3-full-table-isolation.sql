-- 018: P3 全表多租户隔离 + 个人级数据字段
-- Created by dev on 2026/05/06
--
-- 为所有业务表添加 user_id / org_id 字段，实现个人级/组织级隔离
-- 默认 org: 00000000-0000-0000-0000-000000000001
-- 默认 admin user (volsier): f9ca132e-0c30-41d5-9b0b-a6f988039265

BEGIN;
DO $$ BEGIN RAISE NOTICE '=== 018: P3 全表多租户隔离 开始 ==='; END $$;

-- ═══════════════════════════════════════════════
-- 1. rules 表：添加 org_id, user_id
-- ═══════════════════════════════════════════════

ALTER TABLE memory.rules
  ADD COLUMN IF NOT EXISTS org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  ADD COLUMN IF NOT EXISTS user_id UUID;

UPDATE memory.rules SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

UPDATE memory.rules r SET user_id = u.id
FROM memory.users u WHERE r.created_by = u.id::text AND r.user_id IS NULL;

UPDATE memory.rules SET user_id = 'f9ca132e-0c30-41d5-9b0b-a6f988039265'
WHERE user_id IS NULL;

ALTER TABLE memory.rules ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rules_org_id ON memory.rules(org_id);
CREATE INDEX IF NOT EXISTS idx_rules_user_id ON memory.rules(user_id);

-- ═══════════════════════════════════════════════
-- 2. topology_nodes 表：添加 user_id, org_id
-- ═══════════════════════════════════════════════

ALTER TABLE memory.topology_nodes
  ADD COLUMN IF NOT EXISTS org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  ADD COLUMN IF NOT EXISTS user_id UUID;

UPDATE memory.topology_nodes SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
UPDATE memory.topology_nodes SET user_id = 'f9ca132e-0c30-41d5-9b0b-a6f988039265' WHERE user_id IS NULL;

ALTER TABLE memory.topology_nodes ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_topology_nodes_org_id ON memory.topology_nodes(org_id);
CREATE INDEX IF NOT EXISTS idx_topology_nodes_user_id ON memory.topology_nodes(user_id);

-- ═══════════════════════════════════════════════
-- 3. topology_edges 表：添加 user_id, org_id
-- ═══════════════════════════════════════════════

ALTER TABLE memory.topology_edges
  ADD COLUMN IF NOT EXISTS org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  ADD COLUMN IF NOT EXISTS user_id UUID;

UPDATE memory.topology_edges SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
UPDATE memory.topology_edges SET user_id = 'f9ca132e-0c30-41d5-9b0b-a6f988039265' WHERE user_id IS NULL;

ALTER TABLE memory.topology_edges ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_topology_edges_org_id ON memory.topology_edges(org_id);

-- ═══════════════════════════════════════════════
-- 4. topology_layers 表：添加 user_id, org_id
-- ═══════════════════════════════════════════════

ALTER TABLE memory.topology_layers
  ADD COLUMN IF NOT EXISTS org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  ADD COLUMN IF NOT EXISTS user_id UUID;

UPDATE memory.topology_layers SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
UPDATE memory.topology_layers SET user_id = 'f9ca132e-0c30-41d5-9b0b-a6f988039265' WHERE user_id IS NULL;

ALTER TABLE memory.topology_layers ALTER COLUMN org_id SET NOT NULL;

-- ═══════════════════════════════════════════════
-- 5. knowledge_relations 表：添加 org_id, user_id
-- ═══════════════════════════════════════════════

ALTER TABLE memory.knowledge_relations
  ADD COLUMN IF NOT EXISTS org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  ADD COLUMN IF NOT EXISTS user_id UUID;

UPDATE memory.knowledge_relations SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

UPDATE memory.knowledge_relations kr SET user_id = u.id
FROM memory.users u WHERE kr.created_by = u.id::text AND kr.user_id IS NULL;

UPDATE memory.knowledge_relations SET user_id = 'f9ca132e-0c30-41d5-9b0b-a6f988039265'
WHERE user_id IS NULL;

ALTER TABLE memory.knowledge_relations ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_relations_org_id ON memory.knowledge_relations(org_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_relations_user_id ON memory.knowledge_relations(user_id);

-- ═══════════════════════════════════════════════
-- 6. agent_tasks 表：添加 org_id, team_id
-- ═══════════════════════════════════════════════

ALTER TABLE memory.agent_tasks
  ADD COLUMN IF NOT EXISTS org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  ADD COLUMN IF NOT EXISTS team_id UUID;

UPDATE memory.agent_tasks SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

UPDATE memory.agent_tasks at2 SET team_id = tm.team_id
FROM memory.team_members tm
WHERE at2.user_id = tm.user_id AND tm.is_primary = true AND at2.team_id IS NULL;

ALTER TABLE memory.agent_tasks ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_tasks_org_id ON memory.agent_tasks(org_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_id_status ON memory.agent_tasks(user_id, status);

-- ═══════════════════════════════════════════════
-- 7. work_contexts 表：添加 user_id, team_id
-- ═══════════════════════════════════════════════

ALTER TABLE memory.work_contexts
  ADD COLUMN IF NOT EXISTS user_id UUID,
  ADD COLUMN IF NOT EXISTS team_id UUID;

UPDATE memory.work_contexts SET user_id = 'f9ca132e-0c30-41d5-9b0b-a6f988039265'
WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_work_contexts_user_id ON memory.work_contexts(user_id);

-- ═══════════════════════════════════════════════
-- 8. api_keys 表：添加 org_id
-- ═══════════════════════════════════════════════

ALTER TABLE memory.api_keys
  ADD COLUMN IF NOT EXISTS org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001';

UPDATE memory.api_keys SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

ALTER TABLE memory.api_keys ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_org_id ON memory.api_keys(org_id);

-- ═══════════════════════════════════════════════
-- 9. product_lines 表：添加 org_id
-- ═══════════════════════════════════════════════

ALTER TABLE memory.product_lines
  ADD COLUMN IF NOT EXISTS org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001';

UPDATE memory.product_lines SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

ALTER TABLE memory.product_lines ALTER COLUMN org_id SET NOT NULL;

-- ═══════════════════════════════════════════════
-- 10. audit_logs 表：添加 team_id
-- ═══════════════════════════════════════════════

ALTER TABLE memory.audit_logs
  ADD COLUMN IF NOT EXISTS team_id UUID;

UPDATE memory.audit_logs al SET team_id = tm.team_id
FROM memory.team_members tm
WHERE al.user_id = tm.user_id AND tm.is_primary = true AND al.team_id IS NULL;

-- ═══════════════════════════════════════════════
-- 11. topology_user_paths 表：添加 org_id
-- ═══════════════════════════════════════════════

ALTER TABLE memory.topology_user_paths
  ADD COLUMN IF NOT EXISTS org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001';

UPDATE memory.topology_user_paths SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

-- ═══════════════════════════════════════════════
-- 12. RLS 辅助函数 + 策略
-- ═══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION memory.current_user_id() RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_user_id', true), '')::UUID;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION memory.current_org_id() RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_org_id', true), '')::UUID;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION memory.is_admin() RETURNS BOOLEAN AS $$
BEGIN
  RETURN current_setting('app.current_user_role', true) = 'admin';
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

-- 清理旧的全放行 RLS 策略（qual = true）
DROP POLICY IF EXISTS agent_task_logs_rls ON memory.agent_task_logs;
DROP POLICY IF EXISTS agent_tasks_rls ON memory.agent_tasks;
DROP POLICY IF EXISTS topo_edges_rls ON memory.topology_edges;
DROP POLICY IF EXISTS topo_layers_rls ON memory.topology_layers;
DROP POLICY IF EXISTS topo_nodes_rls ON memory.topology_nodes;
DROP POLICY IF EXISTS trusted_devices_rls ON memory.trusted_devices;
DROP POLICY IF EXISTS upl_rls ON memory.user_product_lines;

-- ── rules RLS ──
ALTER TABLE memory.rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory.rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rules_isolation ON memory.rules;
CREATE POLICY rules_isolation ON memory.rules
  USING (
    memory.current_user_id() IS NULL
    OR memory.is_admin()
    OR user_id = memory.current_user_id()
    OR org_id = memory.current_org_id()
  );

-- ── agent_tasks RLS ──
ALTER TABLE memory.agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory.agent_tasks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_tasks_isolation ON memory.agent_tasks;
CREATE POLICY agent_tasks_isolation ON memory.agent_tasks
  USING (
    memory.current_user_id() IS NULL
    OR memory.is_admin()
    OR user_id = memory.current_user_id()
  );

-- ── topology_nodes RLS ──
ALTER TABLE memory.topology_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory.topology_nodes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS topology_nodes_isolation ON memory.topology_nodes;
CREATE POLICY topology_nodes_isolation ON memory.topology_nodes
  USING (
    memory.current_user_id() IS NULL
    OR memory.is_admin()
    OR user_id = memory.current_user_id()
  );

-- ── topology_edges RLS ──
ALTER TABLE memory.topology_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory.topology_edges FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS topology_edges_isolation ON memory.topology_edges;
CREATE POLICY topology_edges_isolation ON memory.topology_edges
  USING (
    memory.current_user_id() IS NULL
    OR memory.is_admin()
    OR user_id = memory.current_user_id()
  );

-- ── knowledge_relations RLS ──
ALTER TABLE memory.knowledge_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory.knowledge_relations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_relations_isolation ON memory.knowledge_relations;
CREATE POLICY knowledge_relations_isolation ON memory.knowledge_relations
  USING (
    memory.current_user_id() IS NULL
    OR memory.is_admin()
    OR user_id = memory.current_user_id()
  );

-- ── agent_task_logs RLS ──
DROP POLICY IF EXISTS agent_task_logs_isolation ON memory.agent_task_logs;
CREATE POLICY agent_task_logs_isolation ON memory.agent_task_logs
  USING (
    memory.current_user_id() IS NULL
    OR memory.is_admin()
    OR task_id IN (SELECT id FROM memory.agent_tasks WHERE user_id = memory.current_user_id())
  );

-- ── trusted_devices RLS ──
DROP POLICY IF EXISTS trusted_devices_isolation ON memory.trusted_devices;
CREATE POLICY trusted_devices_isolation ON memory.trusted_devices
  USING (
    memory.current_user_id() IS NULL
    OR memory.is_admin()
    OR user_id = memory.current_user_id()
  );

-- ── user_product_lines RLS ──
DROP POLICY IF EXISTS upl_isolation ON memory.user_product_lines;
CREATE POLICY upl_isolation ON memory.user_product_lines
  USING (
    memory.current_user_id() IS NULL
    OR memory.is_admin()
    OR user_id = memory.current_user_id()
  );

DO $$ BEGIN RAISE NOTICE '=== 018: P3 全表多租户隔离 完成 ==='; END $$;

COMMIT;
