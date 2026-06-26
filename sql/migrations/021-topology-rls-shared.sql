-- 021: 拓扑 RLS 改为共享模式
-- Created by dev on 2026/05/08
--
-- 拓扑图是团队共享资源（多用户扫描结果的并集），不应按 user_id 行级隔离。
-- 访问控制完全依赖 Gateway 的产品线 ACL（per product_line 读写权限），
-- DB 层只需保证连接可见全部拓扑数据。
--
-- 018 迁移为 topology 表引入了 USING(user_id = current_user_id()) 策略，
-- 但 TopologyStore 的 INSERT 未写入 user_id，且 REST API 不走 runWithRLS，
-- 导致 RLS 策略与共享图设计冲突。此迁移将拓扑表 RLS 改为全放行。

BEGIN;
DO $$ BEGIN RAISE NOTICE '=== 021: 拓扑 RLS 改为共享模式 ==='; END $$;

-- ── topology_nodes: 共享可见 ──
DROP POLICY IF EXISTS topology_nodes_isolation ON memory.topology_nodes;
DROP POLICY IF EXISTS topology_nodes_shared ON memory.topology_nodes;
CREATE POLICY topology_nodes_shared ON memory.topology_nodes USING (TRUE);

-- ── topology_edges: 共享可见 ──
DROP POLICY IF EXISTS topology_edges_isolation ON memory.topology_edges;
DROP POLICY IF EXISTS topology_edges_shared ON memory.topology_edges;
CREATE POLICY topology_edges_shared ON memory.topology_edges USING (TRUE);

-- ── topology_layers: 共享可见 ──
DROP POLICY IF EXISTS topology_layers_isolation ON memory.topology_layers;
DROP POLICY IF EXISTS topology_layers_shared ON memory.topology_layers;
CREATE POLICY topology_layers_shared ON memory.topology_layers USING (TRUE);

DO $$ BEGIN RAISE NOTICE '=== 021: 拓扑 RLS 共享策略已应用 ==='; END $$;

COMMIT;
