const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { verifyPassword, requireAdmin } = require('../lib/auth');
const { stripe, requireStripe } = require('../lib/stripe');
const { generateKey, normalizeDomain } = require('../lib/licenseKey');

const router = express.Router();

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
    return res.status(401).render('login', { error: 'Invalid email or password.' });
  }
  req.session.adminId = user.id;
  res.redirect('/admin');
});

router.post('/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.get('/', requireAdmin, (req, res) => {
  const customers = db
    .prepare(
      `SELECT c.id, c.email, c.stripe_customer_id, c.created_at,
              (SELECT status FROM subscriptions WHERE customer_id = c.id ORDER BY updated_at DESC LIMIT 1) AS latest_status,
              (SELECT COUNT(*) FROM licenses WHERE customer_id = c.id AND status = 'active') AS active_licenses
       FROM customers c
       ORDER BY c.created_at DESC`,
    )
    .all();
  res.render('dashboard', { customers });
});

router.post('/customers', requireAdmin, (req, res) => {
  const email = (req.body && req.body.email ? String(req.body.email) : '').trim().toLowerCase();
  if (!email) return res.redirect('/admin');
  const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(email);
  if (existing) return res.redirect(`/admin/customers/${existing.id}`);
  const id = 'cust_' + crypto.randomBytes(8).toString('hex');
  db.prepare(
    'INSERT INTO customers (id, email, created_at) VALUES (?, ?, ?)',
  ).run(id, email, Math.floor(Date.now() / 1000));
  res.redirect(`/admin/customers/${id}`);
});

router.get('/customers/:id', requireAdmin, (req, res) => {
  const customer = db
    .prepare('SELECT * FROM customers WHERE id = ?')
    .get(req.params.id);
  if (!customer) return res.status(404).send('Not found');

  const subscriptions = db
    .prepare('SELECT * FROM subscriptions WHERE customer_id = ? ORDER BY updated_at DESC')
    .all(customer.id);
  const licenses = db
    .prepare('SELECT * FROM licenses WHERE customer_id = ? ORDER BY created_at DESC')
    .all(customer.id);
  const recentLog = db
    .prepare(
      `SELECT * FROM verification_log
       WHERE license_key IN (SELECT key FROM licenses WHERE customer_id = ?)
       ORDER BY at DESC LIMIT 25`,
    )
    .all(customer.id);

  res.render('customer', {
    customer,
    subscriptions,
    licenses,
    recentLog,
    stripeEnabled: !!stripe,
  });
});

router.post('/customers/:id/licenses', requireAdmin, (req, res) => {
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).send('Not found');
  const domain = normalizeDomain(req.body && req.body.domain);
  if (!domain) return res.redirect(`/admin/customers/${customer.id}`);
  const subscriptionId = (req.body && req.body.subscription_id) || null;

  let key;
  for (let i = 0; i < 5; i++) {
    key = generateKey();
    if (!db.prepare('SELECT 1 FROM licenses WHERE key = ?').get(key)) break;
  }
  db.prepare(
    `INSERT INTO licenses (key, customer_id, subscription_id, domain, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
  ).run(key, customer.id, subscriptionId || null, domain, Math.floor(Date.now() / 1000));
  res.redirect(`/admin/customers/${customer.id}`);
});

router.post('/licenses/:key/revoke', requireAdmin, (req, res) => {
  const license = db.prepare('SELECT customer_id FROM licenses WHERE key = ?').get(req.params.key);
  if (!license) return res.status(404).send('Not found');
  db.prepare(
    "UPDATE licenses SET status = 'revoked', revoked_at = ? WHERE key = ?",
  ).run(Math.floor(Date.now() / 1000), req.params.key);
  res.redirect(`/admin/customers/${license.customer_id}`);
});

router.post('/licenses/:key/rebind', requireAdmin, (req, res) => {
  const license = db.prepare('SELECT customer_id FROM licenses WHERE key = ?').get(req.params.key);
  if (!license) return res.status(404).send('Not found');
  const domain = normalizeDomain(req.body && req.body.domain);
  if (!domain) return res.redirect(`/admin/customers/${license.customer_id}`);
  db.prepare('UPDATE licenses SET domain = ? WHERE key = ?').run(domain, req.params.key);
  res.redirect(`/admin/customers/${license.customer_id}`);
});

router.post('/customers/:id/checkout', requireAdmin, async (req, res) => {
  try {
    const s = requireStripe();
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!customer) return res.status(404).send('Not found');

    let stripeCustomerId = customer.stripe_customer_id;
    if (!stripeCustomerId) {
      const created = await s.customers.create({ email: customer.email });
      stripeCustomerId = created.id;
      db.prepare('UPDATE customers SET stripe_customer_id = ? WHERE id = ?').run(
        stripeCustomerId,
        customer.id,
      );
    }

    const session = await s.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      client_reference_id: customer.id,
      line_items: [{ price: config.stripePriceId, quantity: 1 }],
      success_url: `${config.publicUrl}/admin/customers/${customer.id}?checkout=success`,
      cancel_url: `${config.publicUrl}/admin/customers/${customer.id}?checkout=cancel`,
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error(err);
    res.status(500).send(`Stripe error: ${err.message}`);
  }
});

router.post('/customers/:id/portal', requireAdmin, async (req, res) => {
  try {
    const s = requireStripe();
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!customer || !customer.stripe_customer_id) {
      return res.status(400).send('No Stripe customer yet. Run checkout first.');
    }
    const portal = await s.billingPortal.sessions.create({
      customer: customer.stripe_customer_id,
      return_url: `${config.publicUrl}/admin/customers/${customer.id}`,
    });
    res.redirect(303, portal.url);
  } catch (err) {
    console.error(err);
    res.status(500).send(`Stripe error: ${err.message}`);
  }
});

module.exports = router;
