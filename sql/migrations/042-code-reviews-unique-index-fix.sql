-- 042: 修复 code_reviews 唯一索引，区分 commit 和 MR 审查
-- 旧索引 (repo_id, commit_hash) 会导致同一 commit 的 commit 审查和 MR 审查互相覆盖

BEGIN;
SET search_path TO memory, public;

-- 删除旧的唯一约束（可能是索引或约束形式）
DROP INDEX IF EXISTS memory.code_reviews_repo_id_commit_hash_key;
DROP INDEX IF EXISTS memory.idx_code_reviews_repo_commit;

-- 创建新唯一索引：commit 审查 mr_iid 为 NULL → COALESCE 为 0，MR 审查有具体 mr_iid
CREATE UNIQUE INDEX IF NOT EXISTS idx_code_reviews_repo_commit_mr
  ON memory.code_reviews (repo_id, commit_hash, COALESCE(mr_iid, 0));

COMMIT;
