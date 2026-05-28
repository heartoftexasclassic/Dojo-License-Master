-- Dojo License Master — initial schema (tenant/tier/entitlement model)
--
-- Layer 1 vendor licensing only. No license keys, no domain binding,
-- no customer-side artifacts. License state is a database row.
--
-- See ../Claude.md (in the Dojo Master repo) for the architectural contract.

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  stripe_price_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('boolean','limit')),
  display_name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tier_entitlements (
  tier_id INTEGER NOT NULL REFERENCES tiers(id) ON DELETE CASCADE,
  entitlement_id INTEGER NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  value INTEGER,
  PRIMARY KEY (tier_id, entitlement_id)
);

CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  billing_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'trialing'
    CHECK(status IN ('trialing','active','past_due','suspended','cancelled')),
  tier_id INTEGER NOT NULL REFERENCES tiers(id),
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  trial_ends_at INTEGER,
  current_period_end INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_tier ON tenants(tier_id);

CREATE TABLE IF NOT EXISTS instance_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_prefix TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  last_used_ip TEXT,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_instance_tokens_tenant ON instance_tokens(tenant_id);

CREATE TABLE IF NOT EXISTS license_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload TEXT,
  actor TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_license_events_tenant ON license_events(tenant_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────
-- Seed data: three default tiers with a starter entitlement map.
-- Edit codes/values via the admin UI; never hard-code `if tier == 'pro'`
-- in feature code.
-- ─────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO tiers (code, display_name, sort_order, created_at) VALUES
  ('basic',      'Basic',      1, strftime('%s','now')),
  ('pro',        'Pro',        2, strftime('%s','now')),
  ('enterprise', 'Enterprise', 3, strftime('%s','now'));

INSERT OR IGNORE INTO entitlements (code, kind, display_name, description, created_at) VALUES
  ('limit.schools',           'limit',   'Locations (schools)',
    'Maximum number of school locations under this tenant. -1 = unlimited.',
    strftime('%s','now')),
  ('limit.admin_users',       'limit',   'Admin users',
    'Maximum staff/admin accounts in the Dojo Master deployment.',
    strftime('%s','now')),
  ('feature.events',          'boolean', 'Events module',
    'Belt tests, tournaments, and seminars with independent registration.',
    strftime('%s','now')),
  ('feature.advanced_reports','boolean', 'Advanced reports',
    'PDF/Excel export and analytics dashboards.',
    strftime('%s','now')),
  ('feature.kiosk',           'boolean', 'Check-in kiosk',
    'Dedicated kiosk check-in mode.',
    strftime('%s','now')),
  ('feature.mobile_app',      'boolean', 'Mobile app access',
    'Allow the Flutter mobile app to connect.',
    strftime('%s','now')),
  ('feature.api_access',      'boolean', 'External API',
    'Programmatic access via /api endpoints.',
    strftime('%s','now'));

-- Basic: 1 location, 3 admins, events on, nothing else
INSERT OR IGNORE INTO tier_entitlements (tier_id, entitlement_id, value)
SELECT t.id, e.id,
  CASE e.code
    WHEN 'limit.schools'     THEN 1
    WHEN 'limit.admin_users' THEN 3
    ELSE NULL
  END
FROM tiers t, entitlements e
WHERE t.code = 'basic'
  AND e.code IN ('limit.schools','limit.admin_users','feature.events');

-- Pro: 5 locations, 15 admins, events + reports + kiosk + mobile
INSERT OR IGNORE INTO tier_entitlements (tier_id, entitlement_id, value)
SELECT t.id, e.id,
  CASE e.code
    WHEN 'limit.schools'     THEN 5
    WHEN 'limit.admin_users' THEN 15
    ELSE NULL
  END
FROM tiers t, entitlements e
WHERE t.code = 'pro'
  AND e.code IN (
    'limit.schools','limit.admin_users',
    'feature.events','feature.advanced_reports','feature.kiosk','feature.mobile_app'
  );

-- Enterprise: unlimited locations + admins, everything
INSERT OR IGNORE INTO tier_entitlements (tier_id, entitlement_id, value)
SELECT t.id, e.id,
  CASE e.code
    WHEN 'limit.schools'     THEN -1
    WHEN 'limit.admin_users' THEN -1
    ELSE NULL
  END
FROM tiers t, entitlements e
WHERE t.code = 'enterprise';
