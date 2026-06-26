-- 009: product_line 实体化
-- Created by dev on 2026/04/09
-- 将 product_line 从散落的字符串统一为实体表，支持 FK 约束和配置管理

-- 1. 创建产品线实体表

BEGIN;
CREATE TABLE IF NOT EXISTS memory.product_lines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE memory.product_lines IS '产品线实体表，统一管理产品线标识';

-- 2. 迁移现有数据：从 entries 和 topology_nodes 中提取唯一的 product_line 值
INSERT INTO memory.product_lines (name, display_name)
SELECT DISTINCT
  LOWER(TRIM(combined.product_line)),
  combined.product_line
FROM (
  SELECT DISTINCT project_id AS product_line FROM memory.entries
  WHERE project_id NOT LIKE '%/%'
    AND project_id != '_global_'
    AND project_id != 'default'
    AND LENGTH(project_id) > 0
  UNION
  SELECT DISTINCT product_line FROM memory.topology_nodes
  WHERE product_line IS NOT NULL AND LENGTH(product_line) > 0
) AS combined
ON CONFLICT (name) DO NOTHING;

-- 3. 大小写归一化：统一现有数据为小写
UPDATE memory.topology_nodes
SET product_line = LOWER(TRIM(product_line))
WHERE product_line IS NOT NULL
  AND product_line != LOWER(TRIM(product_line));

UPDATE memory.topology_edges
SET product_line = LOWER(TRIM(product_line))
WHERE product_line IS NOT NULL
  AND product_line != LOWER(TRIM(product_line));

-- 4. user_product_lines FK 关联（软约束，不影响已有数据）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_upl_product_line'
  ) THEN
    -- 先确保 user_product_lines 中的值在 product_lines 表中存在
    INSERT INTO memory.product_lines (name, display_name)
    SELECT DISTINCT LOWER(TRIM(product_line)), product_line
    FROM memory.user_product_lines
    WHERE LOWER(TRIM(product_line)) NOT IN (SELECT name FROM memory.product_lines)
    ON CONFLICT (name) DO NOTHING;

    -- 归一化 user_product_lines 中的值
    UPDATE memory.user_product_lines
    SET product_line = LOWER(TRIM(product_line))
    WHERE product_line != LOWER(TRIM(product_line));

    ALTER TABLE memory.user_product_lines
      ADD CONSTRAINT fk_upl_product_line
      FOREIGN KEY (product_line) REFERENCES memory.product_lines(name)
      ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
