const express = require('express');
const db = require('../db');
const config = require('../config');
const { stripe } = require('../lib/stripe');
const { generateKey } = require('../lib/licenseKey');

const router = express.Router();

function upsertSubscription(sub) {
  const customerRow = db
    .prepare('SELECT id FROM customers WHERE stripe_customer_id = ?')
    .get(sub.customer);
  if (!customerRow) {
    console.warn(
      `[webhook] subscription ${sub.id} references unknown stripe customer ${sub.customer}; ignoring`,
    );
    return null;
  }
  const plan =
    sub.items && sub.items.data && sub.items.data[0]
      ? sub.items.data[0].price.nickname || sub.items.data[0].price.id
      : null;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO subscriptions (id, customer_id, status, plan, current_period_end, cancel_at_period_end, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       plan = excluded.plan,
       current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end,
       updated_at = excluded.updated_at`,
  ).run(
    sub.id,
    customerRow.id,
    sub.status,
    plan,
    sub.current_period_end || null,
    sub.cancel_at_period_end ? 1 : 0,
    now,
  );
  return customerRow.id;
}

function issueLicenseIfMissing(subscriptionId, customerId, domain) {
  const existing = db
    .prepare('SELECT key FROM licenses WHERE subscription_id = ?')
    .get(subscriptionId);
  if (existing) return existing.key;
  let key;
  for (let i = 0; i < 5; i++) {
    key = generateKey();
    const clash = db.prepare('SELECT 1 FROM licenses WHERE key = ?').get(key);
    if (!clash) break;
  }
  db.prepare(
    `INSERT INTO licenses (key, customer_id, subscription_id, domain, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
  ).run(key, customerId, subscriptionId, domain || '', Math.floor(Date.now() / 1000));
  return key;
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
      case 'customer.subscription.created': {
        const sub = event.data.object;
        const customerId = upsertSubscription(sub);
        if (customerId) {
          const domain =
            (sub.metadata && sub.metadata.domain) ||
            '';
          const key = issueLicenseIfMissing(sub.id, customerId, domain);
          console.log(
            `[webhook] subscription ${sub.id} active for customer ${customerId}; license ${key} issued`,
          );
        }
        break;
      }
      case 'customer.subscription.updated': {
        upsertSubscription(event.data.object);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        upsertSubscription(sub);
        db.prepare(
          `UPDATE licenses SET status = 'revoked', revoked_at = ? WHERE subscription_id = ? AND status = 'active'`,
        ).run(Math.floor(Date.now() / 1000), sub.id);
        break;
      }
      case 'invoice.payment_failed': {
        console.log(`[webhook] invoice.payment_failed for ${event.data.object.customer}`);
        break;
      }
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.customer && session.client_reference_id) {
          db.prepare(
            'UPDATE customers SET stripe_customer_id = ? WHERE id = ? AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)',
          ).run(session.customer, session.client_reference_id, session.customer);
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
