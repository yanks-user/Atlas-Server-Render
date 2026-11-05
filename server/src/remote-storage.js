'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { onReservationsWritten } = require('./reservation-file');

// Valeur stockée chez Upstash : le JSON tel quel (lisible dans la console d'Upstash) ; compressé au-delà de cette taille
// (la taille d'une requête est limitée sur l'offre gratuite)
const GZIP_PREFIX = 'gz1:';
const PLAIN_LIMIT_BYTES = 300 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
// Au démarrage : quelques essais si Upstash ne répond pas, puis le serveur refuse de démarrer (voir pull)
const STARTUP_RETRY_DELAYS_MS = [1000, 2000, 4000];
// Ensuite : les changements rapprochés partent en une seule commande, et un échec est retenté de plus en plus lentement
const DEFAULT_PUSH_DELAY_MS = 3000;
const DEFAULT_RETRY_DELAYS_MS = [5000, 15000, 60000];
// Fichiers retouchés sans passer par le serveur (commande users.js) : repérés par comparaison locale, sans aucune requête
const FILE_CHECK_INTERVAL_MS = 30000;

class StorageError extends Error {
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.fatal = fatal;
  }
}

const encode = (text) => (Buffer.byteLength(text) <= PLAIN_LIMIT_BYTES ? text : `${GZIP_PREFIX}${zlib.gzipSync(text).toString('base64')}`);
const decode = (value) => (value.startsWith(GZIP_PREFIX) ? zlib.gunzipSync(Buffer.from(value.slice(GZIP_PREFIX.length), 'base64')).toString('utf8') : value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stockage durable FACULTATIF : copie des fichiers de données (users.json, session-codes.json, sessions.json) chez Upstash Redis
 * (API REST, simple HTTPS). Sur le plan gratuit de Render, le disque est effacé à chaque redémarrage, redéploiement ou mise en veille :
 * pseudos réservés et sessions gardées sont alors perdus. Avec Upstash, le serveur les y retrouve au démarrage.
 *
 * Fonctionnement : les fichiers restent la copie de travail, comme sans Upstash. Au démarrage, pull() les remplace par ce que
 * contient Upstash (rien chez Upstash : les fichiers locaux y sont copiés) ; ensuite, chaque écriture d'un fichier est envoyée à Upstash.
 * Un échec d'envoi n'arrête jamais le serveur : les données restent en mémoire et dans les fichiers, et l'envoi est retenté.
 * Mais si Upstash ne répond pas AU DÉMARRAGE, le serveur refuse de démarrer : repartir de zéro puis écrire par-dessus
 * effacerait ce qui était gardé (même principe qu'un fichier illisible).
 */
class UpstashStorage {
  #url;
  #token;
  #prefix;
  #files;
  #logger;
  #fetch;
  #pushDelayMs;
  #retryDelaysMs;
  #startupRetryDelaysMs;
  #fileCheckIntervalMs;
  // Dernier texte connu chez Upstash, par clé : rien n'est renvoyé s'il n'a pas changé
  #lastPushed = new Map();
  #pending = new Map();
  #seedNames = new Set();
  #timer = null;
  #pushing = null;
  #failing = false;
  #retries = 0;
  #unsubscribe = null;
  #checkTimer = null;

  /**
   * @param {{ url: string, token: string, prefix?: string, files: Record<string, string>, logger: object,
   *   fetchImpl?: typeof fetch, pushDelayMs?: number, retryDelaysMs?: number[], startupRetryDelaysMs?: number[], fileCheckIntervalMs?: number }} options
   *   files : nom du document -> chemin du fichier (clé chez Upstash : préfixe + nom)
   */
  constructor({ url, token, prefix = 'tacnet:', files, logger, fetchImpl = fetch, pushDelayMs = DEFAULT_PUSH_DELAY_MS, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, startupRetryDelaysMs = STARTUP_RETRY_DELAYS_MS, fileCheckIntervalMs = FILE_CHECK_INTERVAL_MS }) {
    this.#url = url;
    this.#token = token;
    this.#prefix = prefix;
    this.#files = files;
    this.#logger = logger;
    this.#fetch = fetchImpl;
    this.#pushDelayMs = pushDelayMs;
    this.#retryDelaysMs = retryDelaysMs;
    this.#startupRetryDelaysMs = startupRetryDelaysMs;
    this.#fileCheckIntervalMs = fileCheckIntervalMs;
  }

  /** Adresse sans le jeton, pour le journal. */
  get host() {
    return new URL(this.#url).host;
  }

  get prefix() {
    return this.#prefix;
  }

  #key(name) {
    return `${this.#prefix}${name}`;
  }

  /** Une commande Redis (API REST : tableau JSON envoyé en POST). Retourne le résultat. */
  async #command(args) {
    let response;
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new StorageError(`Upstash injoignable (${err.cause?.code ?? err.name ?? err.message})`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new StorageError('Upstash refuse la clé (UPSTASH_REDIS_REST_TOKEN)', { fatal: true });
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      // Réponse sans JSON : traitée avec le code HTTP
    }
    if (!response.ok || body?.error) {
      throw new StorageError(`Upstash : ${body?.error ?? `réponse ${response.status}`}`, { fatal: response.status >= 400 && response.status < 500 });
    }
    return body?.result ?? null;
  }

  async #withRetries(operation) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (err) {
        if (err.fatal || attempt >= this.#startupRetryDelaysMs.length) throw err;
        await sleep(this.#startupRetryDelaysMs[attempt]);
      }
    }
  }

  /**
   * À appeler AVANT de charger les fichiers : ce qu'Upstash garde remplace les fichiers locaux (l'ancien contenu est mis de côté
   * dans <fichier>.avant-upstash s'il était différent). Lève une erreur si Upstash est injoignable ou si son contenu est illisible.
   */
  async pull() {
    for (const [name, file] of Object.entries(this.#files)) {
      const key = this.#key(name);
      const remote = await this.#withRetries(() => this.#command(['GET', key]));
      if (remote === null) {
        // Première activation : les fichiers locaux, s'il y en a, seront copiés chez Upstash
        if (fs.existsSync(file)) this.#seedNames.add(name);
        continue;
      }
      let text;
      try {
        text = decode(String(remote));
        JSON.parse(text.replace(/^﻿/, ''));
      } catch (err) {
        throw new StorageError(`Upstash : la clé ${key} est illisible (${err.message}). Rien n'a été écrasé.`, { fatal: true });
      }
      this.#lastPushed.set(key, text);
      const local = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (local === text) continue;
      if (local !== null) fs.copyFileSync(file, `${file}.avant-upstash`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, text, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
      this.#logger.info(`Upstash : ${name} restauré (${Buffer.byteLength(text)} octets).`);
    }
  }

  /** À appeler une fois les fichiers chargés : copie chaque écriture vers Upstash (et la première fois, les fichiers existants). */
  start() {
    this.#unsubscribe = onReservationsWritten((filePath, text) => {
      const name = Object.keys(this.#files).find((n) => path.resolve(this.#files[n]) === path.resolve(filePath));
      if (name) this.#queue(name, text);
    });
    for (const name of this.#seedNames) this.#queue(name, fs.readFileSync(this.#files[name], 'utf8'));
    this.#checkTimer = setInterval(() => this.#checkFiles(), this.#fileCheckIntervalMs);
    this.#checkTimer.unref();
  }

  #checkFiles() {
    for (const [name, file] of Object.entries(this.#files)) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (text !== this.#lastPushed.get(this.#key(name))) this.#queue(name, text);
    }
  }

  #queue(name, text) {
    const key = this.#key(name);
    if (this.#lastPushed.get(key) === text) {
      this.#pending.delete(key);
      return;
    }
    this.#pending.set(key, text);
    this.#schedule(this.#pushDelayMs);
  }

  #schedule(delay) {
    if (this.#timer) return;
    this.#timer = setTimeout(() => this.#push(), delay);
    this.#timer.unref();
  }

  async #push() {
    this.#timer = null;
    if (this.#pushing) return;
    this.#pushing = (async () => {
      try {
        for (const [key, text] of [...this.#pending]) {
          await this.#command(['SET', key, encode(text)]);
          this.#lastPushed.set(key, text);
          // Un changement plus récent arrivé pendant l'envoi reste en attente
          if (this.#pending.get(key) === text) this.#pending.delete(key);
        }
        if (this.#failing) {
          this.#logger.info('Upstash : de nouveau joignable, données à jour.');
          this.#failing = false;
        }
        this.#retries = 0;
      } catch (err) {
        if (!this.#failing) {
          this.#logger.warn(`[!] ${err.message} : les données restent en mémoire et dans les fichiers, nouvel essai bientôt.`);
          this.#failing = true;
        }
        this.#schedule(this.#retryDelaysMs[Math.min(this.#retries, this.#retryDelaysMs.length - 1)]);
        this.#retries += 1;
      } finally {
        this.#pushing = null;
        if (this.#pending.size > 0) this.#schedule(this.#pushDelayMs);
      }
    })();
    await this.#pushing;
  }

  /** Arrêt du serveur : envoie ce qui attend (au plus timeoutMs). Retourne true si tout est parti. */
  async flush(timeoutMs = 5000) {
    clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#pending.size === 0 && !this.#pushing) return true;
    const done = (async () => {
      if (this.#pushing) await this.#pushing;
      if (this.#pending.size > 0) await this.#push();
    })();
    const sent = await Promise.race([done.then(() => this.#pending.size === 0), sleep(timeoutMs).then(() => false)]);
    clearTimeout(this.#timer);
    this.#timer = null;
    return sent;
  }

  stop() {
    this.#unsubscribe?.();
    clearTimeout(this.#timer);
    clearInterval(this.#checkTimer);
    this.#timer = null;
    this.#checkTimer = null;
  }
}

module.exports = { UpstashStorage, StorageError, encode, decode };
