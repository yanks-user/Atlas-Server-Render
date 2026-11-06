const fs = require('fs');
const { tokenMatches, writeReservations } = require('./reservation-file');
const { parseTemplate, ROLES } = require('./protocol');

const COLLECTION = 'sessions';
const FILE_VERSION = 1;
// Au-delà, les sessions modifiées il y a le plus longtemps sont oubliées
const MAX_ENTRIES = 2000;
// Les changements arrivent par rafales (plusieurs règles « qui parle à qui » à la suite) : une seule écriture
const SAVE_DELAY_MS = 500;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const ROLE_VALUES = new Set(Object.values(ROLES));

/**
 * Sessions gardées (sessions.json) : ce qui fait une session, tel que son gérant l'a laissé (nom, verrou,
 * réglages, canaux et règles, gérant, rôles des joueurs). Une session qui se vide n'est pas perdue, ni au
 * redémarrage du serveur : on la retrouve en revenant sous son code (voir Session.persistentState).
 * Seules les empreintes des jetons d'identité y figurent. Sans `filePath`, le registre reste en mémoire.
 */
class SessionStore {
  /** Ordre du Map : de la moins récemment modifiée à la plus récente. @type {Map<string, { state: object, json: string, updatedAt: string }>} */
  #entries = new Map();
  #filePath;
  #maxEntries;
  #logger;
  #saveTimer = null;

  constructor({ filePath = null, maxEntries = MAX_ENTRIES, logger = console } = {}) {
    this.#filePath = filePath;
    this.#maxEntries = maxEntries;
    this.#logger = logger;
  }

  get size() {
    return this.#entries.size;
  }

  /** Lit le fichier s'il existe ; lève une erreur s'il est invalide (repartir de zéro perdrait toutes les sessions). */
  load() {
    let content;
    try {
      content = fs.readFileSync(this.#filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(content.replace(/^﻿/, ''));
    } catch (err) {
      throw new Error(`${this.#filePath} n'est pas un JSON valide (${err.message}).`);
    }
    const entries = parsed?.version === FILE_VERSION ? parsed[COLLECTION] : null;
    if (!entries || typeof entries !== 'object') throw new Error(`${this.#filePath} : format inconnu.`);

    const loaded = Object.entries(entries).map(([code, entry]) => {
      if (!isValidState(entry?.state)) throw new Error(`${this.#filePath} : session « ${code} » invalide.`);
      return [code, { state: entry.state, json: JSON.stringify(entry.state), updatedAt: String(entry.updatedAt) }];
    });
    loaded.sort(([, a], [, b]) => a.updatedAt.localeCompare(b.updatedAt));
    this.#entries = new Map(loaded);
  }

  has(code) {
    return this.#entries.has(code);
  }

  get(code) {
    return this.#entries.get(code)?.state ?? null;
  }

  /** La session de ce code, si ce jeton d'identité est celui de son gérant. */
  ownedBy(code, token) {
    const state = this.get(code);
    return state?.managerHash && tokenMatches(token, state.managerHash) ? state : null;
  }

  /** Appelé à chaque publication de la session : n'écrit que si quelque chose a changé. */
  save(code, state) {
    const json = JSON.stringify(state);
    if (this.#entries.get(code)?.json === json) return;
    this.#entries.delete(code);
    this.#entries.set(code, { state, json, updatedAt: new Date().toISOString() });
    while (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value);
    this.#scheduleWrite();
  }

  remove(code) {
    if (this.#entries.delete(code)) this.#scheduleWrite();
  }

  /** Écrit tout de suite ce qui attend (arrêt du serveur). */
  flush() {
    if (this.#saveTimer === null) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    this.#write();
  }

  #scheduleWrite() {
    if (!this.#filePath || this.#saveTimer !== null) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#write();
    }, SAVE_DELAY_MS);
    this.#saveTimer.unref();
  }

  #write() {
    const entries = [...this.#entries].map(([code, { state, updatedAt }]) => [code, { state, updatedAt }]);
    writeReservations(this.#filePath, COLLECTION, entries, this.#logger);
  }
}

/** Fichier retouché à la main : mêmes contrôles que pour un modèle de session, plus le gérant et les rôles. */
function isValidState(state) {
  if (!state || typeof state !== 'object' || typeof parseTemplate(state) === 'string') return false;
  if (state.managerHash !== null && !TOKEN_HASH_PATTERN.test(state.managerHash)) return false;
  if (!state.roles || typeof state.roles !== 'object') return false;
  const customRoles = new Set((state.customRoles ?? []).map(({ id }) => id));
  return Object.entries(state.roles).every(([hash, role]) => TOKEN_HASH_PATTERN.test(hash) && (ROLE_VALUES.has(role) || customRoles.has(role)));
}

module.exports = { SessionStore };
