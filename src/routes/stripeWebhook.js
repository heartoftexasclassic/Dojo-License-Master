const express = require('express');
const db = require('../db');
const config = require('../config');
const { stripe } = require('../lib/stripe');

const router = express.Router();

// Map Stripe subscription status → our internal tenant status.
const STATUS_MAP = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  canceled: 'cancelled',
  incomplete: 'past_due',
  incomplete_expired: 'cancelled',
  unpaid: 'past_due',
};

function logEvent(tenantId, eventType, payload) {
  db.prepare(
    `INSERT INTO license_events (tenant_id, event_type, payload, actor, created_at)
     VALUES (?, ?, ?, 'stripe', ?)`,
  ).run(
    tenantId,
    eventType,
    JSON.stringify(payload),
    Math.floor(Date.now() / 1000),
  );
}

function tenantByStripeCustomer(stripeCustomerId) {
  return db
    .prepare('SELECT * FROM tenants WHERE stripe_customer_id = ?')
    .get(stripeCustomerId);
}

function tierByStripePriceId(priceId) {
  if (!priceId) return null;
  return db
    .prepare('SELECT * FROM tiers WHERE stripe_price_id = ?')
    .get(priceId);
}

function applySubscription(sub) {
  const tenant = tenantByStripeCustomer(sub.customer);
  if (!tenant) {
    console.warn(
      `[webhook] subscription ${sub.id} → unknown stripe customer ${sub.customer}; ignoring`,
    );
    return;
  }

  const priceId =
    sub.items && sub.items.data && sub.items.data[0]
      ? sub.items.data[0].price.id
      : null;
  const tier = tierByStripePriceId(priceId);
  const newStatus = STATUS_MAP[sub.status] || tenant.status;

  const tierChanged = tier && tier.id !== tenant.tier_id;
  const statusChanged = newStatus !== tenant.status;

  db.prepare(
    `UPDATE tenants
     SET tier_id = COALESCE(?, tier_id),
         status = ?,
         stripe_subscription_id = ?,
         current_period_end = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    tier ? tier.id : null,
    newStatus,
    sub.id,
    sub.current_period_end || null,
    Math.floor(Date.now() / 1000),
    tenant.id,
  );

  logEvent(tenant.id, 'subscription_sync', {
    subscription_id: sub.id,
    stripe_status: sub.status,
    price_id: priceId,
    tier_changed: tierChanged ? { from: tenant.tier_id, to: tier.id } : false,
    status_changed: statusChanged
      ? { from: tenant.status, to: newStatus }
      : false,
  });
}

router.post('/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !config.stripeWebhookSecret) {
    return res.status(503).send('stripe not configured');
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      config.stripeWebhookSecret,
    );
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        applySubscription(event.data.object);
        break;
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.customer && session.client_reference_id) {
          const tenant = db
            .prepare('SELECT * FROM tenants WHERE slug = ? OR id = ?')
            .get(
              session.client_reference_id,
              parseInt(session.client_reference_id, 10) || -1,
            );
          if (tenant && !tenant.stripe_customer_id) {
            db.prepare(
              'UPDATE tenants SET stripe_customer_id = ?, updated_at = ? WHERE id = ?',
            ).run(session.customer, Math.floor(Date.now() / 1000), tenant.id);
            logEvent(tenant.id, 'stripe_customer_attached', {
              stripe_customer_id: session.customer,
            });
          }
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('[webhook] handler error:', err);
    return res.status(500).send('handler error');
  }

  res.json({ received: true });
});

module.exports = router;
