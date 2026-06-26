-- 017: 团队加入申请表
-- Created by dev on 2026/05/06

BEGIN;
CREATE TABLE IF NOT EXISTS memory.team_join_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES memory.teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES memory.users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  message TEXT,
  reviewed_by UUID REFERENCES memory.users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_join_requests_unique_pending
  ON memory.team_join_requests (team_id, user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_team_join_requests_team_status
  ON memory.team_join_requests (team_id, status);

CREATE INDEX IF NOT EXISTS idx_team_join_requests_user
  ON memory.team_join_requests (user_id, status);

COMMIT;
