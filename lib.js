'use strict';
// Hachage des mots de passe avec scrypt (intégré à Node, aucune dépendance).
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `s1$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [v, saltHex, keyHex] = String(stored).split('$');
    if (v !== 's1') return false;
    const expected = Buffer.from(keyHex, 'hex');
    const key = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
