-- 040: 扩展 code_reviews 表支持 MR 审查
-- 向后兼容：新增列均有默认值，不影响已有功能

BEGIN;
SET search_path TO memory, public;

ALTER TABLE memory.code_reviews
  ADD COLUMN IF NOT EXISTS review_type VARCHAR(20) NOT NULL DEFAULT 'commit',
  ADD COLUMN IF NOT EXISTS mr_iid INTEGER,
  ADD COLUMN IF NOT EXISTS mr_url TEXT,
  ADD COLUMN IF NOT EXISTS gitlab_project_id INTEGER;

-- MR 审查去重索引：同 repo + 同 MR + 同 commit 不重复
CREATE UNIQUE INDEX IF NOT EXISTS idx_code_reviews_mr_dedup
  ON memory.code_reviews (repo_id, mr_iid, commit_hash)
  WHERE review_type = 'merge_request';

CREATE INDEX IF NOT EXISTS idx_code_reviews_mr
  ON memory.code_reviews (repo_id, mr_iid)
  WHERE mr_iid IS NOT NULL;

COMMIT;
