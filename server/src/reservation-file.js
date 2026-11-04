const fs = require('fs');
const { createHash, timingSafeEqual } = require('crypto');

const FILE_VERSION = 1;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Fichiers de réservations (users.json, session-codes.json) : une clé appartient à un jeton d'identité.
 * Seule l'empreinte SHA-256 du jeton y est gardée (aléatoire sur 122 bits : pas besoin de scrypt) :
 * lire le fichier ne permet pas de se faire passer pour son propriétaire.
 */

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/** Sans jeton, rien ne correspond. */
function tokenMatches(token, tokenHash) {
  return Boolean(token) && timingSafeEqual(Buffer.from(hashToken(token), 'hex'), Buffer.from(tokenHash, 'hex'));
}

/**
 * Entrées du fichier ([clé, entrée]), vide s'il n'existe pas. Un fichier invalide lève une erreur
 * (le serveur refuse de démarrer) : repartir de zéro libérerait toutes les réservations.
 */
function readReservations(filePath, collection) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  let parsed;
  try {
    // Retire le BOM UTF-8 éventuel (fichier retouché avec un éditeur Windows)
    parsed = JSON.parse(content.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`${filePath} n'est pas un JSON valide (${err.message}).`);
  }
  const entries = parsed?.version === FILE_VERSION ? parsed[collection] : null;
  if (!entries || typeof entries !== 'object') throw new Error(`${filePath} : format inconnu.`);
  for (const [key, entry] of Object.entries(entries)) {
    if (!TOKEN_HASH_PATTERN.test(entry?.tokenHash)) throw new Error(`${filePath} : entrée « ${key} » invalide.`);
  }
  return Object.entries(entries);
}

/**
 * Écriture atomique et synchrone : les réservations sont rares, et un arrêt brutal n'en perd aucune.
 * En cas d'échec, elles restent valables en mémoire jusqu'au prochain redémarrage.
 * Retourne true si le fichier a été écrit.
 */
function writeReservations(filePath, collection, entries, logger) {
  const content = { version: FILE_VERSION, [collection]: Object.fromEntries(entries) };
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(content, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    logger.warn(`[!] Enregistrement de ${filePath} impossible : ${err.message}`);
    return false;
  }
}

module.exports = { hashToken, tokenMatches, readReservations, writeReservations };
