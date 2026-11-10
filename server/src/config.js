const fs = require('fs');
const path = require('path');
const { hashPassword, isPasswordHash, generatePassword } = require('./password');
const { loadOrCreateCertificate } = require('./tls');

// SERVER_CONFIG permet de placer la configuration ailleurs ; les chemins TLS sont relatifs à ce fichier
const CONFIG_PATH = process.env.SERVER_CONFIG
  ? path.resolve(process.env.SERVER_CONFIG)
  : path.join(__dirname, '..', 'server-config.json');
const CONFIG_DIR = path.dirname(CONFIG_PATH);
// Pseudos réservés (voir nickname-registry.js), à côté de la configuration : scripts/users.js les gère
const USERS_PATH = path.join(CONFIG_DIR, 'users.json');
const MIN_PASSWORD_LENGTH = 8;
// Limites réglables dans server-config.json (les autres restent celles de signaling-server.js)
const TUNABLE_LIMITS = Object.freeze(['maxSessions', 'maxMembersPerSession', 'maxChannelsPerSession']);

const DEFAULTS = Object.freeze({
  port: 8080,
  host: '0.0.0.0',
  // null pour désactiver TLS (ex. derrière un proxy qui chiffre déjà)
  tls: Object.freeze({ certFile: 'tls/cert.pem', keyFile: 'tls/key.pem' }),
});

function readConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
}

function writeConfigFile(config) {
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
}

/** Remplace l'empreinte du mot de passe dans server-config.json (crée le fichier au besoin). */
async function setPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`);
  }
  const fileConfig = readConfigFile() ?? { port: DEFAULTS.port, host: DEFAULTS.host, tls: DEFAULTS.tls };
  delete fileConfig.password;
  fileConfig.passwordHash = await hashPassword(password);
  writeConfigFile(fileConfig);
}

/** Variable à deux valeurs possibles : une faute de frappe ne doit pas laisser croire qu'elle s'applique. */
function readSwitch(name, on, off, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value !== on && value !== off) throw new Error(`${name} doit valoir ${on} ou ${off} (reçu : ${value}).`);
  return value === on;
}

/** Limites facultatives du fichier : entiers positifs uniquement. */
function readLimits(fileLimits = {}) {
  const limits = {};
  for (const key of TUNABLE_LIMITS) {
    const value = fileLimits[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) throw new Error(`limits.${key} doit être un entier positif.`);
    limits[key] = value;
  }
  return limits;
}

/**
 * Configuration du serveur. Les variables d'environnement PORT, HOST et SERVER_PASSWORD
 * (définies dans le système ou dans config.env, chargé par index.js) sont prioritaires sur
 * server-config.json (emplacement modifiable avec SERVER_CONFIG).
 * Derrière un reverse proxy qui chiffre déjà : TLS=off et TRUST_PROXY=true (voir README.html). Sur Render (RENDER=true), c'est le défaut.
 *
 * server-config.json ne contient jamais le mot de passe, seulement son empreinte scrypt :
 * - premier lancement : un mot de passe aléatoire est généré et affiché une seule fois ;
 * - ancien fichier avec "password" en clair : converti automatiquement en empreinte.
 */
/**
 * Stockage durable facultatif (Upstash Redis, voir remote-storage.js) : UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN, les noms
 * que donne Upstash. UPSTASH_KEY_PREFIX (facultatif) sépare plusieurs serveurs qui partageraient une même base.
 * Sans ces variables : null, les données restent dans les fichiers du serveur, comme avant.
 */
function readRemoteStorage() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url && !token) return null;
  // Une seule des deux : on le dit plutôt que de laisser croire que les données sont gardées
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN doivent être définis ensemble.');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('UPSTASH_REDIS_REST_URL n\'est pas une adresse valide (attendu : https://….upstash.io).');
  }
  // http:// seulement vers la machine elle-même (essais) : le jeton ne doit jamais circuler en clair sur Internet
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new Error('UPSTASH_REDIS_REST_URL doit commencer par https://.');
  const prefix = process.env.UPSTASH_KEY_PREFIX?.trim() || 'atlas:';
  if (!/^[A-Za-z0-9:_-]{1,40}$/.test(prefix)) throw new Error('UPSTASH_KEY_PREFIX : lettres, chiffres, « : », « _ » et « - » seulement, 40 caractères au plus.');
  return { url: url.replace(/\/+$/, ''), token, prefix };
}

async function loadServerConfig() {
  const notices = [];
  let fileConfig = readConfigFile();

  if (!fileConfig) {
    fileConfig = { port: DEFAULTS.port, host: DEFAULTS.host, tls: DEFAULTS.tls };
    if (!process.env.SERVER_PASSWORD) {
      const password = generatePassword();
      fileConfig.passwordHash = await hashPassword(password);
      notices.push(`Mot de passe généré (affiché une seule fois, notez-le) : ${password}`);
    }
    writeConfigFile(fileConfig);
  } else if (typeof fileConfig.password === 'string') {
    fileConfig.passwordHash = await hashPassword(fileConfig.password);
    delete fileConfig.password;
    writeConfigFile(fileConfig);
    notices.push('Mot de passe en clair converti en empreinte dans server-config.json.');
  }

  // Le mot de passe de SERVER_PASSWORD (config.env ou environnement) n'est gardé qu'en empreinte, en mémoire
  let passwordHash = fileConfig.passwordHash;
  if (process.env.SERVER_PASSWORD !== undefined) {
    if (process.env.SERVER_PASSWORD.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`SERVER_PASSWORD doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`);
    }
    passwordHash = await hashPassword(process.env.SERVER_PASSWORD);
    notices.push('Mot de passe : variable SERVER_PASSWORD (config.env ou environnement), prioritaire sur server-config.json.');
  }
  if (!isPasswordHash(passwordHash)) {
    throw new Error(`Aucun mot de passe : lancez "npm run set-password" (fichier ${CONFIG_PATH}).`);
  }

  // Render définit toujours RENDER=true. Son proxy chiffre déjà les connexions (wss://) et les transmet en clair au service :
  // avec TLS actif le serveur serait injoignable, et sans TRUST_PROXY tous les joueurs auraient la même adresse.
  // Sur Render, ces deux réglages ont donc d'autres valeurs par défaut ; TLS et TRUST_PROXY, s'ils sont définis, restent prioritaires.
  const onRender = process.env.RENDER === 'true';

  // Une config sans clé "tls" (version précédente) passe en TLS par défaut
  const tlsFiles = fileConfig.tls === undefined ? DEFAULTS.tls : fileConfig.tls;
  const tlsEnabled = readSwitch('TLS', 'on', 'off', !onRender);
  const trustProxy = readSwitch('TRUST_PROXY', 'true', 'false', onRender);
  if (onRender) notices.push(`Render détecté (RENDER=true) : TLS=${tlsEnabled ? 'on' : 'off'}, TRUST_PROXY=${trustProxy}.`);
  let tls = null;
  if (tlsEnabled && tlsFiles) {
    tls = await loadOrCreateCertificate({
      certFile: path.resolve(CONFIG_DIR, tlsFiles.certFile),
      keyFile: path.resolve(CONFIG_DIR, tlsFiles.keyFile),
    });
    if (tls.generated) notices.push('Certificat TLS auto-signé généré.');
  }

  return {
    port: Number.parseInt(process.env.PORT ?? fileConfig.port ?? DEFAULTS.port, 10),
    host: process.env.HOST ?? fileConfig.host ?? DEFAULTS.host,
    passwordHash,
    tls,
    trustProxy,
    limits: readLimits(fileConfig.limits),
    configPath: CONFIG_PATH,
    // Pseudos, codes réservés et sessions gardées (voir nickname-registry.js, code-registry.js, session-store.js), à côté de la configuration
    usersPath: USERS_PATH,
    sessionCodesPath: path.join(CONFIG_DIR, 'session-codes.json'),
    sessionsPath: path.join(CONFIG_DIR, 'sessions.json'),
    remoteStorage: readRemoteStorage(),
    onRender,
    notices,
  };
}

module.exports = { loadServerConfig, setPassword, MIN_PASSWORD_LENGTH, USERS_PATH };
