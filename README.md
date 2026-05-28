# Dojo License Master

Hosted licensing service for the [Dojo Master](https://github.com/heartoftexasclassic/Dojo-Master)
multi-tenant application. Owns the tier → entitlement map and answers
`POST /api/v1/license/state` calls from each Dojo Master deployment.

This is **Layer 1 vendor licensing** as defined in
[Dojo Master's Claude.md](https://github.com/heartoftexasclassic/Dojo-Master/blob/main/Claude.md):
hosted-only, no license keys, no customer-side artifacts, tenant state is
a database row.

- **Runtime:** Node.js 20+, Express 4
- **DB:** SQLite (single file, via `better-sqlite3`)
- **Billing:** Stripe (Checkout, Billing Portal, webhooks)
- **Auth (deployments):** instance token (Bearer), bcrypt-hashed
- **Auth (admin):** session cookie + bcrypt password

## Setup

```bash
cp .env.example .env
# edit .env — set SESSION_SECRET, ADMIN_*, STRIPE_*
npm install
npm start
```

First boot creates `./data/licenses.db`, runs migrations (which seed
three default tiers and a starter entitlement set), and seeds the admin
user from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

Visit http://localhost:3000/admin/login.

## Data model

| Table              | Purpose                                                        |
| ------------------ | -------------------------------------------------------------- |
| `tenants`          | One row per paying org (customer business)                     |
| `tiers`            | Pricing tiers (Basic / Pro / Enterprise out of the box)        |
| `entitlements`     | Catalogue of feature flags + quantitative limits               |
| `tier_entitlements`| The map: which entitlements are unlocked at which tier         |
| `instance_tokens`  | Per-deployment Bearer credentials (bcrypt hashed)              |
| `license_events`   | Audit log of every license-affecting change                    |
| `admin_users`      | Vendor staff who log in to the admin UI                        |

## Entitlement model

Two kinds of entitlement, both stored in the same `entitlements` table:

- **boolean** — feature flags. `tier_entitlements.value` is `NULL`; presence
  of the row at all means "on". Example: `feature.advanced_reports`.
- **limit** — quantitative caps. `tier_entitlements.value` is the integer
  limit; `-1` means unlimited. Example: `limit.schools` = `5` on Pro.

Dojo Master clients call:
- `Licensing::can('feature.advanced_reports')` → bool
- `Licensing::limit('limit.schools')` → int (`PHP_INT_MAX` if unlimited)

**Never hardcode `if (tier === 'pro')`** in feature code. The whole point
of the entitlement map is that tiers can be re-shaped without code changes.

## API

### `POST /api/v1/license/state`

The only endpoint Dojo Master calls. Authenticated via instance token.

```http
POST /api/v1/license/state
Authorization: Bearer dlm_a7d0df05.smpbuUpOm5jjClHrRQukJj0ZbASQjiQnKC3fALGTJT8
```

Response:

```json
{
  "tenant": {
    "id": 1,
    "slug": "acme-dojo",
    "display_name": "Acme Karate"
  },
  "tier": "pro",
  "tier_name": "Pro",
  "status": "active",
  "features": ["feature.events", "feature.advanced_reports", "feature.kiosk", "feature.mobile_app"],
  "limits": { "limit.schools": 5, "limit.admin_users": 15 },
  "trial_ends_at": null,
  "current_period_end": null,
  "polled_at": 1779978045
}
```

Clients should:
- Poll on a cadence (every few minutes), not every request.
- Cache the response on disk.
- **Fail open** with the last known good state for a grace period (~7 days)
  if the license server is unreachable. Don't take customers' sites down
  for a vendor-side outage.
- After the grace window expires without a successful poll, **fail closed**
  (block + show an upgrade / "contact support" message).

### `POST /webhooks/stripe`

Stripe webhook receiver. On `customer.subscription.{created,updated,deleted}`,
looks up the tenant by `stripe_customer_id`, maps the Stripe status to our
internal status, syncs `tier_id` from the subscription's price, and writes
a row to `license_events`.

### `GET /healthz`

Returns `{"ok": true}`. Doesn't touch the DB.

## Provisioning a new tenant

In the admin UI:

1. **Tenants → New tenant** — fill in name, billing email, and starting tier.
2. **Settings** — paste `stripe_customer_id` / `stripe_subscription_id` once
   Stripe Checkout is wired up. (Until then, tier and status can be set by
   hand for early customers.)
3. **Instance tokens → Generate new token** — copy the token *immediately*
   (it's only shown once) and drop it into the new Dojo Master deployment's
   `config.local.php`:

   ```php
   define('LICENSE_SERVER_URL',   'https://licenses.yourdomain.com');
   define('LICENSE_INSTANCE_TOKEN', 'dlm_…');
   ```

## Stripe webhook (local dev)

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
```

Copy the `whsec_…` it prints into `STRIPE_WEBHOOK_SECRET`. To wire a tier
to a Stripe price, edit the tier in **Tiers & entitlements** and paste the
`price_…` ID.

## Deployment

- Put behind TLS — instance tokens are bearer tokens.
- Stripe webhook URL: `https://licenses.yourdomain.com/webhooks/stripe`.
- Back up `./data/licenses.db` daily (e.g. litestream to S3). Losing this
  DB means losing every tenant's licensing state.
- Run under systemd or pm2.
- Hosted-only. Customers never run this. They never see it.
