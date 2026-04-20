# Dojo License Master

Self-hosted license and subscription manager. Your websites call it to verify a
paying subscription is active before enabling a feature.

- **Runtime:** Node.js 20+, Express 4
- **DB:** SQLite (single file, via `better-sqlite3`)
- **Billing:** Stripe (Checkout + Billing Portal + webhooks)
- **Auth (clients):** license key + domain binding
- **Auth (admin):** session cookie + bcrypt password

## Setup

```bash
cp .env.example .env
# edit .env — set SESSION_SECRET, ADMIN_*, STRIPE_*
npm install
npm start
```

First boot creates `./data/licenses.db`, runs migrations, and seeds the admin
user from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

Visit http://localhost:3000/admin/login.

## Stripe webhook (local dev)

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
```

Copy the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET`.

## Client verification API

`POST /api/verify`

```json
{ "license_key": "DOJO-XXXX-XXXX-XXXX-XXXX", "domain": "example.com" }
```

Returns:

```json
{ "valid": true, "status": "active", "plan": "pro", "expires_at": 1719878400 }
```

Or on failure (still HTTP 200 — clients distinguish network errors from invalid licenses):

```json
{ "valid": false, "reason": "domain_mismatch" }
```

Reasons: `invalid_key`, `domain_mismatch`, `revoked`, `no_subscription`, `subscription_inactive`.

See `client-examples/` for drop-in helpers (Node and PHP). Client helpers
should **fail open on network errors** and cache the last known good result
for several days so a server outage doesn't take down paying customers' sites.

## Deployment

- Put behind TLS — license keys are bearer tokens.
- Stripe webhook URL: `https://licenses.yourdomain.com/webhooks/stripe`.
- Back up `./data/licenses.db` daily (e.g. litestream to S3).
- Run under systemd or pm2.
