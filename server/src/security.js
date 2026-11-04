/**
 * Limiteur à jetons : `ratePerSecond` messages par seconde en moyenne,
 * avec une rafale possible jusqu'à `ratePerSecond` messages.
 */
class RateLimiter {
  #tokens;
  #lastRefill = Date.now();

  constructor(ratePerSecond) {
    this.ratePerSecond = ratePerSecond;
    this.#tokens = ratePerSecond;
  }

  /** Consomme un jeton ; retourne false si la limite est dépassée. */
  tryConsume() {
    const now = Date.now();
    const elapsedS = (now - this.#lastRefill) / 1000;
    this.#tokens = Math.min(this.ratePerSecond, this.#tokens + elapsedS * this.ratePerSecond);
    this.#lastRefill = now;

    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/**
 * Freine le cassage du mot de passe par force brute :
 * après `maxFailures` échecs en `windowMs`, l'adresse IP est bloquée pendant `banMs`.
 */
class AuthGuard {
  #failures = new Map(); // ip -> { count, firstAt, bannedUntil }

  constructor({ maxFailures = 5, windowMs = 60000, banMs = 60000 } = {}) {
    Object.assign(this, { maxFailures, windowMs, banMs });
  }

  isBanned(ip) {
    const entry = this.#failures.get(ip);
    return Boolean(entry?.bannedUntil && entry.bannedUntil > Date.now());
  }

  recordFailure(ip) {
    const now = Date.now();
    let entry = this.#failures.get(ip);
    if (!entry || now - entry.firstAt > this.windowMs) {
      entry = { count: 0, firstAt: now, bannedUntil: 0 };
      this.#failures.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count >= this.maxFailures) entry.bannedUntil = now + this.banMs;
  }

  recordSuccess(ip) {
    this.#failures.delete(ip);
  }

  /** Oublie les entrées expirées (appelé périodiquement). */
  prune() {
    const now = Date.now();
    for (const [ip, entry] of this.#failures) {
      if (entry.bannedUntil < now && now - entry.firstAt > this.windowMs) this.#failures.delete(ip);
    }
  }
}

module.exports = { RateLimiter, AuthGuard };
