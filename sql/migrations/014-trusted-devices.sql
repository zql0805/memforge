-- 011: 可信设备表 — 设备级访问控制
-- Created by dev on 2026/04/10

BEGIN;
CREATE TABLE memory.trusted_devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES memory.users(id) ON DELETE CASCADE,
    device_id       VARCHAR(255) NOT NULL,
    device_name     VARCHAR(255),
    device_type     VARCHAR(50) NOT NULL DEFAULT 'web',
    user_agent      TEXT,
    last_ip         VARCHAR(45),
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    approved_by     UUID REFERENCES memory.users(id),
    approved_at     TIMESTAMPTZ,
    last_seen_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, device_id),
    CHECK (status IN ('pending', 'approved', 'revoked'))
);

CREATE INDEX idx_trusted_devices_user ON memory.trusted_devices(user_id);
CREATE INDEX idx_trusted_devices_status ON memory.trusted_devices(status);

ALTER TABLE memory.trusted_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY trusted_devices_rls ON memory.trusted_devices
    USING (TRUE) WITH CHECK (TRUE);

COMMIT;
