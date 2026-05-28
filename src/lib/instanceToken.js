const crypto = require('crypto');
const bcrypt = require('bcrypt');

const PREFIX_PREFIX = 'dlm_';
const PREFIX_RANDOM_BYTES = 4;
const SECRET_BYTES = 32;
const BCRYPT_ROUNDS = 12;

function makePrefix() {
  return PREFIX_PREFIX + crypto.randomBytes(PREFIX_RANDOM_BYTES).toString('hex');
}

function generate() {
  const prefix = makePrefix();
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const fullToken = `${prefix}.${secret}`;
  return { fullToken, prefix };
}

async function hash(fullToken) {
  return bcrypt.hash(fullToken, BCRYPT_ROUNDS);
}

async function verify(fullToken, storedHash) {
  return bcrypt.compare(fullToken, storedHash);
}

function parsePrefix(fullToken) {
  if (typeof fullToken !== 'string') return null;
  const dot = fullToken.indexOf('.');
  if (dot < 0) return null;
  const prefix = fullToken.slice(0, dot);
  if (!prefix.startsWith(PREFIX_PREFIX)) return null;
  return prefix;
}

module.exports = { generate, hash, verify, parsePrefix };
