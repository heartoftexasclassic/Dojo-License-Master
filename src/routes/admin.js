const express = require('express');
const db = require('../db');
const { verifyPassword, requireAdmin } = require('../lib/auth');
const instanceToken = require('../lib/instanceToken');

const router = express.Router();

const TENANT_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'suspended',
  'cancelled',
];

function now() {
  return Math.floor(Date.now() / 1000);
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function logEvent(req, tenantId, eventType, payload) {
  const actor = req.session && req.session.adminId
    ? `admin:${req.session.adminId}`
    : 'system';
  db.prepare(
    `INSERT INTO license_events (tenant_id, event_type, payload, actor, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(tenantId, eventType, JSON.stringify(payload || {}), actor, now());
}

// ─────────────────────────── auth ───────────────────────────

router.get('/login', (req, res) => {
  if (req.session && req.session.adminId) return res.redirect('/admin');
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = db
    .prepare('SELECT id, password_hash FROM admin_users WHERE email = ?')
    .get(email || '');
  if (!user || !(await verifyPassword(password || '', user.password_hash))) {
    return res
      .status(401)
      .render('login', { error: 'Invalid email or password.' });
  }
  req.session.adminId = user.id;
  res.redirect('/admin');
});

router.post('/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ─────────────────────────── dashboard ───────────────────────────

router.get('/', requireAdmin, (req, res) => {
  const byTier = db
    .prepare(
      `SELECT ti.code, ti.display_name, COUNT(t.id) AS count
       FROM tiers ti
       LEFT JOIN tenants t ON t.tier_id = ti.id
       GROUP BY ti.id
       ORDER BY ti.sort_order`,
    )
    .all();
  const byStatus = db
    .prepare(
      `SELECT status, COUNT(*) AS count
       FROM tenants
       GROUP BY status`,
    )
    .all();
  const recentEvents = db
    .prepare(
      `SELECT le.*, t.slug AS tenant_slug, t.display_name AS tenant_name
       FROM license_events le
       LEFT JOIN tenants t ON t.id = le.tenant_id
       ORDER BY le.created_at DESC
       LIMIT 25`,
    )
    .all();
  const totalTenants = db
    .prepare('SELECT COUNT(*) AS n FROM tenants')
    .get().n;

  res.render('dashboard', { byTier, byStatus, recentEvents, totalTenants });
});

// ─────────────────────────── tenants ───────────────────────────

router.get('/tenants', requireAdmin, (req, res) => {
  const tenants = db
    .prepare(
      `SELECT t.*, ti.code AS tier_code, ti.display_name AS tier_name,
              (SELECT COUNT(*) FROM instance_tokens
                 WHERE tenant_id = t.id AND revoked_at IS NULL) AS active_tokens
       FROM tenants t
       JOIN tiers ti ON ti.id = t.tier_id
       ORDER BY t.created_at DESC`,
    )
    .all();
  const tiers = db
    .prepare('SELECT * FROM tiers ORDER BY sort_order')
    .all();
  res.render('tenants', { tenants, tiers, statuses: TENANT_STATUSES });
});

router.post('/tenants', requireAdmin, (req, res) => {
  const body = req.body || {};
  const display_name = String(body.display_name || '').trim();
  const billing_email = String(body.billing_email || '').trim().toLowerCase();
  const tierId = parseInt(body.tier_id, 10);
  let slug = slugify(body.slug || display_name);

  if (!display_name || !billing_email || !tierId || !slug) {
    return res.redirect('/admin/tenants?error=missing_fields');
  }
  const tier = db.prepare('SELECT id FROM tiers WHERE id = ?').get(tierId);
  if (!tier) return res.redirect('/admin/tenants?error=invalid_tier');

  // Ensure slug uniqueness — append -2, -3, … if needed.
  let candidate = slug;
  let suffix = 2;
  while (db.prepare('SELECT 1 FROM tenants WHERE slug = ?').get(candidate)) {
    candidate = `${slug}-${suffix++}`;
  }

  const result = db
    .prepare(
      `INSERT INTO tenants
         (slug, display_name, billing_email, status, tier_id, created_at, updated_at)
       VALUES (?, ?, ?, 'trialing', ?, ?, ?)`,
    )
    .run(candidate, display_name, billing_email, tierId, now(), now());

  logEvent(req, result.lastInsertRowid, 'tenant_created', {
    slug: candidate,
    display_name,
    tier_id: tierId,
  });

  res.redirect(`/admin/tenants/${result.lastInsertRowid}`);
});

router.get('/tenants/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tenant = db
    .prepare(
      `SELECT t.*, ti.code AS tier_code, ti.display_name AS tier_name
       FROM tenants t
       JOIN tiers ti ON ti.id = t.tier_id
       WHERE t.id = ?`,
    )
    .get(id);
  if (!tenant) return res.status(404).send('Tenant not found');

  const tiers = db.prepare('SELECT * FROM tiers ORDER BY sort_order').all();
  const tokens = db
    .prepare(
      `SELECT * FROM instance_tokens
       WHERE tenant_id = ?
       ORDER BY (revoked_at IS NULL) DESC, created_at DESC`,
    )
    .all(id);
  const events = db
    .prepare(
      `SELECT * FROM license_events
       WHERE tenant_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
    )
    .all(id);

  const newTokenFull = req.session.newTokenFull;
  const newTokenTenantId = req.session.newTokenTenantId;
  if (newTokenFull && newTokenTenantId === id) {
    delete req.session.newTokenFull;
    delete req.session.newTokenTenantId;
  }

  res.render('tenant', {
    tenant,
    tiers,
    statuses: TENANT_STATUSES,
    tokens,
    events,
    newTokenFull: newTokenTenantId === id ? newTokenFull : null,
  });
});

router.post('/tenants/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  if (!tenant) return res.status(404).send('Tenant not found');

  const body = req.body || {};
  const tierId = parseInt(body.tier_id, 10) || tenant.tier_id;
  const status = TENANT_STATUSES.includes(body.status)
    ? body.status
    : tenant.status;
  const display_name = String(body.display_name || tenant.display_name).trim();
  const billing_email = String(body.billing_email || tenant.billing_email)
    .trim()
    .toLowerCase();
  const stripe_customer_id =
    String(body.stripe_customer_id || '').trim() || null;
  const stripe_subscription_id =
    String(body.stripe_subscription_id || '').trim() || null;
  const notes = String(body.notes || '').trim() || null;

  db.prepare(
    `UPDATE tenants SET
       tier_id = ?,
       status = ?,
       display_name = ?,
       billing_email = ?,
       stripe_customer_id = ?,
       stripe_subscription_id = ?,
       notes = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    tierId,
    status,
    display_name,
    billing_email,
    stripe_customer_id,
    stripe_subscription_id,
    notes,
    now(),
    id,
  );

  const changes = {};
  if (tierId !== tenant.tier_id)
    changes.tier_id = { from: tenant.tier_id, to: tierId };
  if (status !== tenant.status)
    changes.status = { from: tenant.status, to: status };
  if (Object.keys(changes).length > 0) {
    logEvent(req, id, 'tenant_updated', changes);
  }

  res.redirect(`/admin/tenants/${id}`);
});

// ─────────────────────────── instance tokens ───────────────────────────

router.post('/tenants/:id/tokens', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(id);
  if (!tenant) return res.status(404).send('Tenant not found');

  const label = String((req.body && req.body.label) || '').trim() || null;
  const { fullToken, prefix } = instanceToken.generate();
  const tokenHash = await instanceToken.hash(fullToken);

  db.prepare(
    `INSERT INTO instance_tokens
       (tenant_id, token_prefix, token_hash, label, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, prefix, tokenHash, label, now());

  logEvent(req, id, 'token_issued', { prefix, label });

  // Show the full token once via session flash.
  req.session.newTokenFull = fullToken;
  req.session.newTokenTenantId = id;

  res.redirect(`/admin/tenants/${id}`);
});

router.post('/tokens/:id/revoke', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const token = db
    .prepare('SELECT id, tenant_id, token_prefix FROM instance_tokens WHERE id = ?')
    .get(id);
  if (!token) return res.status(404).send('Token not found');

  db.prepare(
    'UPDATE instance_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
  ).run(now(), id);

  logEvent(req, token.tenant_id, 'token_revoked', { prefix: token.token_prefix });
  res.redirect(`/admin/tenants/${token.tenant_id}`);
});

// ─────────────────────────── tiers + entitlements ───────────────────────────

router.get('/tiers', requireAdmin, (req, res) => {
  const tiers = db
    .prepare('SELECT * FROM tiers ORDER BY sort_order')
    .all();
  const entitlements = db
    .prepare('SELECT * FROM entitlements ORDER BY kind, code')
    .all();
  const map = db
    .prepare(
      `SELECT tier_id, entitlement_id, value FROM tier_entitlements`,
    )
    .all();
  // Build a quick lookup: lookup[tierId][entitlementId] = value (or 'absent')
  const lookup = {};
  for (const t of tiers) lookup[t.id] = {};
  for (const row of map) {
    lookup[row.tier_id][row.entitlement_id] = row.value;
  }
  res.render('tiers', { tiers, entitlements, lookup });
});

router.post('/tiers/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tier = db.prepare('SELECT * FROM tiers WHERE id = ?').get(id);
  if (!tier) return res.status(404).send('Tier not found');
  const body = req.body || {};
  const display_name = String(body.display_name || tier.display_name).trim();
  const stripe_price_id =
    String(body.stripe_price_id || '').trim() || null;
  db.prepare(
    `UPDATE tiers SET display_name = ?, stripe_price_id = ? WHERE id = ?`,
  ).run(display_name, stripe_price_id, id);
  res.redirect('/admin/tiers');
});

router.post('/tiers/:id/entitlements', requireAdmin, (req, res) => {
  const tierId = parseInt(req.params.id, 10);
  const tier = db.prepare('SELECT id FROM tiers WHERE id = ?').get(tierId);
  if (!tier) return res.status(404).send('Tier not found');

  const entitlements = db
    .prepare('SELECT id, code, kind FROM entitlements')
    .all();
  const body = req.body || {};

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM tier_entitlements WHERE tier_id = ?').run(tierId);
    const insert = db.prepare(
      `INSERT INTO tier_entitlements (tier_id, entitlement_id, value)
       VALUES (?, ?, ?)`,
    );
    for (const e of entitlements) {
      if (e.kind === 'boolean') {
        // Checkbox: present in body if checked.
        if (body[`feature_${e.id}`]) {
          insert.run(tierId, e.id, null);
        }
      } else if (e.kind === 'limit') {
        // Numeric input. Empty string = entitlement absent (no limit row).
        const raw = body[`limit_${e.id}`];
        if (raw !== undefined && String(raw).trim() !== '') {
          const v = parseInt(raw, 10);
          if (Number.isFinite(v)) insert.run(tierId, e.id, v);
        }
      }
    }
  });
  tx();
  res.redirect('/admin/tiers');
});

// ─────────────────────────── events log ───────────────────────────

router.get('/events', requireAdmin, (req, res) => {
  const events = db
    .prepare(
      `SELECT le.*, t.slug AS tenant_slug, t.display_name AS tenant_name
       FROM license_events le
       LEFT JOIN tenants t ON t.id = le.tenant_id
       ORDER BY le.created_at DESC
       LIMIT 200`,
    )
    .all();
  res.render('events', { events });
});

module.exports = router;
