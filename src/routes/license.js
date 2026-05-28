const express = require('express');
const db = require('../db');
const { verify, parsePrefix } = require('../lib/instanceToken');

const router = express.Router();

async function authenticate(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const fullToken = auth.slice(7).trim();
  const prefix = parsePrefix(fullToken);
  if (!prefix) return null;

  const row = db
    .prepare(
      `SELECT id, tenant_id, token_hash, revoked_at
       FROM instance_tokens
       WHERE token_prefix = ? AND revoked_at IS NULL`,
    )
    .get(prefix);
  if (!row) return null;

  const ok = await verify(fullToken, row.token_hash);
  if (!ok) return null;
  return row;
}

function loadEntitlements(tierId) {
  const rows = db
    .prepare(
      `SELECT e.code, e.kind, te.value
       FROM tier_entitlements te
       JOIN entitlements e ON e.id = te.entitlement_id
       WHERE te.tier_id = ?`,
    )
    .all(tierId);

  const features = [];
  const limits = {};
  for (const r of rows) {
    if (r.kind === 'boolean') {
      features.push(r.code);
    } else if (r.kind === 'limit') {
      limits[r.code] = r.value;
    }
  }
  return { features, limits };
}

function clampUsageInt(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.floor(n), 10_000_000);
}

function recordUsage(tenantId, rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const students = clampUsageInt(rawUsage.students);
  const adminUsers = clampUsageInt(rawUsage.admin_users);
  if (students === null && adminUsers === null) return null;

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO usage_reports
       (tenant_id, reported_at, students, admin_users, source, raw_payload, created_at)
     VALUES (?, ?, ?, ?, 'license_poll', ?, ?)`,
  ).run(tenantId, now, students, adminUsers, JSON.stringify(rawUsage), now);

  db.prepare(
    `UPDATE tenants
     SET last_students          = COALESCE(?, last_students),
         last_admin_users       = COALESCE(?, last_admin_users),
         last_usage_reported_at = ?
     WHERE id = ?`,
  ).run(students, adminUsers, now, tenantId);

  return { students, admin_users: adminUsers, reported_at: now };
}

function billingForTier(tier) {
  return {
    interval: tier.billing_interval || 'monthly',
    flat_amount_cents: tier.flat_amount_cents,
    metered_unit: tier.metered_unit,
    included_units: tier.included_units || 0,
    unit_amount_cents: tier.unit_amount_cents,
  };
}

router.post('/license/state', async (req, res) => {
  const tokenRow = await authenticate(req);
  if (!tokenRow) return res.status(401).json({ error: 'invalid_token' });

  const tenant = db
    .prepare(
      `SELECT t.id, t.slug, t.display_name, t.status, t.tier_id,
              t.current_period_end, t.trial_ends_at,
              ti.code AS tier_code, ti.display_name AS tier_name,
              ti.flat_amount_cents, ti.metered_unit, ti.included_units,
              ti.unit_amount_cents, ti.billing_interval
       FROM tenants t
       JOIN tiers ti ON ti.id = t.tier_id
       WHERE t.id = ?`,
    )
    .get(tokenRow.tenant_id);

  if (!tenant) return res.status(404).json({ error: 'tenant_not_found' });

  const { features, limits } = loadEntitlements(tenant.tier_id);
  const usageAck = recordUsage(tenant.id, (req.body || {}).usage);

  const now = Math.floor(Date.now() / 1000);
  const ip =
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    req.socket.remoteAddress ||
    null;
  db.prepare(
    'UPDATE instance_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?',
  ).run(now, ip, tokenRow.id);

  res.json({
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      display_name: tenant.display_name,
    },
    tier: tenant.tier_code,
    tier_name: tenant.tier_name,
    status: tenant.status,
    features,
    limits,
    billing: billingForTier(tenant),
    usage_acknowledged: usageAck,
    trial_ends_at: tenant.trial_ends_at,
    current_period_end: tenant.current_period_end,
    polled_at: now,
  });
});

module.exports = router;
