const { hashToken, tokenMatches, readReservations, writeReservations } = require('./reservation-file');

const COLLECTION = 'codes';
// Au-delà, les codes inutilisés depuis le plus longtemps sont libérés
const MAX_ENTRIES = 5000;

/**
 * Codes de session réservés (session-codes.json) : chaque code appartient au jeton d'identité de son gérant.
 *
 * Une session garde ainsi son code d'un lancement à l'autre, même une fois vide ou après un redémarrage
 * du serveur, et personne d'autre ne peut le reprendre entre-temps : ses joueurs pourraient atterrir
 * dans la session d'un inconnu. Sans `filePath`, le registre reste en mémoire.
 */
class CodeRegistry {
  /** Ordre du Map : du moins récemment utilisé au plus récent. @type {Map<string, { tokenHash: string, usedAt: string, retired?: boolean }>} */
  #entries = new Map();
  #filePath;
  #maxEntries;
  #logger;

  constructor({ filePath = null, maxEntries = MAX_ENTRIES, logger = console } = {}) {
    this.#filePath = filePath;
    this.#maxEntries = maxEntries;
    this.#logger = logger;
  }

  get size() {
    return this.#entries.size;
  }

  /** Lit le fichier s'il existe ; lève une erreur s'il est invalide. */
  load() {
    const entries = readReservations(this.#filePath, COLLECTION);
    entries.sort(([, a], [, b]) => String(a.usedAt).localeCompare(String(b.usedAt)));
    this.#entries = new Map(entries);
  }

  isReserved(code) {
    return this.#entries.has(code);
  }

  /** Vrai pour un code remplacé par son gérant (Régénérer) : il ne sert plus jamais. */
  isRetired(code) {
    return this.#entries.get(code)?.retired === true;
  }

  retire(code) {
    const entry = this.#entries.get(code);
    if (!entry) return;
    entry.retired = true;
    this.#save();
  }

  isReservedByOther(code, token) {
    const entry = this.#entries.get(code);
    return Boolean(entry) && !tokenMatches(token, entry.tokenHash);
  }

  /** Le code appartient désormais à ce jeton (nouvelle session, relance, ou main passée). */
  claim(code, token) {
    this.#entries.delete(code);
    this.#entries.set(code, { tokenHash: hashToken(token), usedAt: new Date().toISOString() });
    while (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value);
    this.#save();
  }

  #save() {
    if (this.#filePath) writeReservations(this.#filePath, COLLECTION, this.#entries, this.#logger);
  }
}

module.exports = { CodeRegistry };
