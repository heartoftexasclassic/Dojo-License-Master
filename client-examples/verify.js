// Drop-in license verifier for Node / Next.js clients.
//
// Usage:
//   const { verifyLicense } = require('./verify');
//   const result = await verifyLicense();
//   if (!result.valid) { /* degrade feature */ }
//
// Env vars expected:
//   LICENSE_SERVER   e.g. https://licenses.yourdomain.com
//   LICENSE_KEY      e.g. DOJO-XXXX-XXXX-XXXX-XXXX
//   SITE_DOMAIN      e.g. example.com
//
// Caches last good result in a JSON file so a server outage doesn't take the
// site down. Fails open for up to GRACE_MS after the last successful check.

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '.license-cache.json');
const REFRESH_MS = 60 * 60 * 1000;        // 1 hour
const GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days of server-outage tolerance

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(entry) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entry), 'utf8');
  } catch (err) {
    console.warn('[license] could not write cache:', err.message);
  }
}

async function verifyLicense({ force = false } = {}) {
  const cache = readCache();
  const now = Date.now();

  if (!force && cache && now - cache.checked_at < REFRESH_MS) {
    return cache.result;
  }

  try {
    const res = await fetch(`${process.env.LICENSE_SERVER}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        license_key: process.env.LICENSE_KEY,
        domain: process.env.SITE_DOMAIN,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    writeCache({ checked_at: now, result });
    return result;
  } catch (err) {
    console.warn('[license] verification failed, using cache:', err.message);
    if (cache && cache.result.valid && now - cache.checked_at < GRACE_MS) {
      return { ...cache.result, stale: true };
    }
    return { valid: false, reason: 'network_error' };
  }
}

module.exports = { verifyLicense };
