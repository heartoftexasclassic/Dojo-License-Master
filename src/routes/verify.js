const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { normalizeDomain } = require('../lib/licenseKey');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

function logResult(licenseKey, domain, ip, result) {
  db.prepare(
    'INSERT INTO verification_log (license_key, domain, ip, result, at) VALUES (?, ?, ?, ?, ?)',
  ).run(licenseKey || null, domain || null, ip || null, result, Math.floor(Date.now() / 1000));
}

router.post('/verify', limiter, (req, res) => {
  const { license_key, domain } = req.body || {};
  const ip = req.ip;

  if (!license_key || typeof license_key !== 'string') {
    logResult(null, domain, ip, 'invalid_key');
    return res.json({ valid: false, reason: 'invalid_key' });
  }

  const normDomain = normalizeDomain(domain);
  const license = db
    .prepare('SELECT * FROM licenses WHERE key = ?')
    .get(license_key);

  if (!license) {
    logResult(license_key, normDomain, ip, 'invalid_key');
    return res.json({ valid: false, reason: 'invalid_key' });
  }

  if (license.status === 'revoked') {
    logResult(license_key, normDomain, ip, 'revoked');
    return res.json({ valid: false, reason: 'revoked' });
  }

  if (license.domain !== normDomain) {
    logResult(license_key, normDomain, ip, 'domain_mismatch');
    return res.json({ valid: false, reason: 'domain_mismatch' });
  }

  const sub = license.subscription_id
    ? db
        .prepare('SELECT * FROM subscriptions WHERE id = ?')
        .get(license.subscription_id)
    : null;

  if (!sub) {
    logResult(license_key, normDomain, ip, 'no_subscription');
    return res.json({ valid: false, reason: 'no_subscription' });
  }

  const now = Math.floor(Date.now() / 1000);
  const inWindow = !sub.current_period_end || sub.current_period_end > now;
  if (!ACTIVE_STATUSES.has(sub.status) || !inWindow) {
    logResult(license_key, normDomain, ip, 'subscription_inactive');
    return res.json({ valid: false, reason: 'subscription_inactive' });
  }

  db.prepare(
    'UPDATE licenses SET last_seen_at = ?, last_seen_ip = ? WHERE key = ?',
  ).run(now, ip || null, license_key);

  const customer = db
    .prepare('SELECT email FROM customers WHERE id = ?')
    .get(license.customer_id);

  logResult(license_key, normDomain, ip, 'ok');

  return res.json({
    valid: true,
    status: sub.status,
    plan: sub.plan || null,
    expires_at: sub.current_period_end || null,
    customer_email: customer ? customer.email : null,
  });
});

module.exports = router;
