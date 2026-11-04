const { scrypt, randomBytes, timingSafeEqual } = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(scrypt);

// Coût scrypt : ~50 ms par vérification, ce qui rend la force brute très lente
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 32 });
const PREFIX = 'scrypt';

/** Empreinte stockable : "scrypt$N$r$p$sel$hash" (le mot de passe lui-même n'est jamais stocké). */
async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return [PREFIX, SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

/** Vérifie un mot de passe contre son empreinte, en temps constant. */
async function verifyPassword(password, stored) {
  const [prefix, N, r, p, saltB64, hashB64] = String(stored).split('$');
  if (prefix !== PREFIX || !hashB64) return false;

  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

function isPasswordHash(value) {
  return typeof value === 'string' && value.startsWith(`${PREFIX}$`);
}

/** Mot de passe aléatoire lisible (16 caractères). */
function generatePassword() {
  return randomBytes(12).toString('base64url');
}

module.exports = { hashPassword, verifyPassword, isPasswordHash, generatePassword };
