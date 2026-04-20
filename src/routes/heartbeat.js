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

router.post('/heartbeat', limiter, (req, res) => {
  const { license_key, domain } = req.body || {};
  if (!license_key || typeof license_key !== 'string') {
    return res.json({ ok: false });
  }
  const license = db
    .prepare('SELECT key, domain, status FROM licenses WHERE key = ?')
    .get(license_key);
  if (!license || license.status !== 'active') {
    return res.json({ ok: false });
  }
  if (license.domain !== normalizeDomain(domain)) {
    return res.json({ ok: false });
  }
  db.prepare(
    'UPDATE licenses SET last_seen_at = ?, last_seen_ip = ? WHERE key = ?',
  ).run(Math.floor(Date.now() / 1000), req.ip || null, license_key);
  return res.json({ ok: true });
});

module.exports = router;
