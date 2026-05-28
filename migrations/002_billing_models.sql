-- 002_billing_models.sql — per-tier billing configuration + reported usage
--
-- A tier can be:
--   • Flat:    flat_amount_cents > 0, metered_unit IS NULL
--   • Metered: metered_unit IS NOT NULL, unit_amount_cents > 0 (flat may also be 0/NULL)
--   • Mixed:   both set — base fee + per-unit overage above included_units
--
-- Unit counts are reported by Dojo Master on each /api/v1/license/state poll.
-- The licensing service stores the latest count and history but does not
-- derive it. Counts are integers at the API boundary — no shared models.

ALTER TABLE tiers ADD COLUMN flat_amount_cents      INTEGER;
ALTER TABLE tiers ADD COLUMN metered_unit           TEXT;        -- 'students' | 'admin_users' | NULL
ALTER TABLE tiers ADD COLUMN included_units         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tiers ADD COLUMN unit_amount_cents      INTEGER;
ALTER TABLE tiers ADD COLUMN stripe_metered_price_id TEXT;
ALTER TABLE tiers ADD COLUMN billing_interval       TEXT NOT NULL DEFAULT 'monthly';  -- 'monthly' | 'annual'

ALTER TABLE tenants ADD COLUMN last_students            INTEGER;
ALTER TABLE tenants ADD COLUMN last_admin_users         INTEGER;
ALTER TABLE tenants ADD COLUMN last_usage_reported_at   INTEGER;

CREATE TABLE IF NOT EXISTS usage_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reported_at INTEGER NOT NULL,
  students INTEGER,
  admin_users INTEGER,
  source TEXT NOT NULL DEFAULT 'license_poll',  -- 'license_poll' | 'admin_manual' | 'stripe_sync'
  raw_payload TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_reports_tenant_at
  ON usage_reports(tenant_id, reported_at DESC);
