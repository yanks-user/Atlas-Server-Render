const fs = require('fs');
const { hashToken, tokenMatches, readReservations, writeReservations } = require('./reservation-file');

const COLLECTION = 'users';
// Chaque nouveau pseudo agrandit le fichier : un client authentifié ne peut pas le faire grossir sans fin
const MAX_ENTRIES = 10000;

/** Même pseudo quelles que soient la casse et les variantes Unicode (caractères pleine chasse…). */
const nicknameKey = (nickname) => nickname.normalize('NFKC').toLocaleLowerCase('fr');

/**
 * Registre des pseudos réservés (users.json) : premier arrivé, premier servi.
 *
 * Un pseudo appartient au jeton d'identité du PC qui l'a utilisé le premier.
 * Sans `filePath`, le registre reste en mémoire.
 *
 * Pour libérer un pseudo (PC changé ou réinstallé…) : `node scripts/users.js remove "<pseudo>"`, ou retirer son
 * entrée de users.json à la main. Le serveur n'a pas besoin d'être arrêté : il relit le fichier dès qu'il change
 * (retouche, script), au lieu de l'écraser avec ce qu'il avait en mémoire. Si le fichier retouché est invalide,
 * il garde ce qu'il a en mémoire et le signale.
 */
class NicknameRegistry {
  /** @type {Map<string, { nickname: string, tokenHash: string, registeredAt: string }>} */
  #entries = new Map();
  #filePath;
  #maxEntries;
  #logger;
  // Date et taille du fichier tel que ce registre l'a lu ou écrit en dernier : s'ils changent, quelqu'un d'autre l'a modifié
  #stamp = null;

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
    if (!this.#filePath) return;
    this.#entries = new Map(readReservations(this.#filePath, COLLECTION));
    this.#stamp = this.#fileStamp();
  }

  /** Tous les pseudos réservés, du plus ancien au plus récent : { key, nickname, tokenHash, registeredAt }. */
  list() {
    this.#refresh();
    return [...this.#entries]
      .map(([key, entry]) => ({ key, ...entry }))
      .sort((a, b) => String(a.registeredAt).localeCompare(String(b.registeredAt)));
  }

  /** Vrai si le pseudo appartient à un autre jeton (sans jeton, un pseudo déjà enregistré est toujours refusé). */
  isReservedByOther(nickname, token) {
    this.#refresh();
    const entry = this.#entries.get(nicknameKey(nickname));
    return Boolean(entry) && !tokenMatches(token, entry.tokenHash);
  }

  /** Faux si le pseudo est nouveau et que le registre est plein. */
  hasRoomFor(nickname) {
    this.#refresh();
    return this.#entries.has(nicknameKey(nickname)) || this.#entries.size < this.#maxEntries;
  }

  /** Réserve le pseudo s'il est libre (l'appelant a vérifié isReservedByOther). Retourne true s'il est nouveau. */
  claim(nickname, token) {
    this.#refresh();
    const key = nicknameKey(nickname);
    if (this.#entries.has(key)) return false;
    this.#entries.set(key, { nickname, tokenHash: hashToken(token), registeredAt: new Date().toISOString() });
    this.#save();
    return true;
  }

  /**
   * Libère le pseudo (quelle que soit la casse) : le prochain joueur qui l'utilise le réserve à son tour, avec son
   * propre jeton. Retourne l'entrée retirée, ou null si ce pseudo n'était pas réservé. Lève une erreur si le fichier
   * ne peut pas être écrit : la libération serait perdue au redémarrage.
   */
  remove(nickname) {
    this.#refresh();
    const key = nicknameKey(nickname);
    const entry = this.#entries.get(key);
    if (!entry) return null;
    this.#entries.delete(key);
    if (this.#filePath && !this.#save()) {
      this.#entries.set(key, entry);
      throw new Error(`${this.#filePath} n'a pas pu être modifié (voir l'avertissement ci-dessus).`);
    }
    return { key, ...entry };
  }

  #save() {
    if (!this.#filePath) return true;
    const written = writeReservations(this.#filePath, COLLECTION, this.#entries, this.#logger);
    if (written) this.#stamp = this.#fileStamp();
    return written;
  }

  #fileStamp() {
    try {
      const { mtimeMs, size } = fs.statSync(this.#filePath);
      return `${mtimeMs}:${size}`;
    } catch (err) {
      return err.code === 'ENOENT' ? 'absent' : `illisible:${err.code}`;
    }
  }

  /** Relit le fichier s'il a changé depuis la dernière fois (retouche à la main, scripts/users.js). Peu coûteux : un stat. */
  #refresh() {
    if (!this.#filePath) return;
    const stamp = this.#fileStamp();
    if (stamp === this.#stamp) return;
    // Mémorisé avant la lecture : un fichier invalide n'est signalé qu'une fois, pas à chaque connexion
    this.#stamp = stamp;
    try {
      this.#entries = new Map(readReservations(this.#filePath, COLLECTION));
      this.#logger.info(`Pseudos réservés rechargés : ${this.#entries.size} (${this.#filePath})`);
    } catch (err) {
      this.#logger.warn(`[!] ${err.message} Les ${this.#entries.size} pseudos gardés en mémoire restent valables, corrigez le fichier.`);
    }
  }
}

module.exports = { NicknameRegistry, nicknameKey };
