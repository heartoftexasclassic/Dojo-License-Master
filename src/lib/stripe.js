const Stripe = require('stripe');
const config = require('../config');

const stripe = config.stripeSecretKey
  ? new Stripe(config.stripeSecretKey, { apiVersion: '2024-10-28.acacia' })
  : null;

function requireStripe() {
  if (!stripe) {
    throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  }
  return stripe;
}

module.exports = { stripe, requireStripe };
