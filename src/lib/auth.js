const bcrypt = require('bcrypt');
const db = require('../db');
const config = require('../config');

const BCRYPT_ROUNDS = 12;

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

async function seedAdminUser() {
  const existing = db
    .prepare('SELECT id FROM admin_users WHERE email = ?')
    .get(config.adminEmail);
  if (existing) return;
  const hash = await hashPassword(config.adminPassword);
  db.prepare(
    'INSERT INTO admin_users (email, password_hash, created_at) VALUES (?, ?, ?)',
  ).run(config.adminEmail, hash, Math.floor(Date.now() / 1000));
  console.log(`[auth] seeded admin user ${config.adminEmail}`);
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.redirect('/admin/login');
}

module.exports = { hashPassword, verifyPassword, seedAdminUser, requireAdmin };
