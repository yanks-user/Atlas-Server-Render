// Serveur Atlas : qui parle en ce moment, et vers quelles cibles.

/**
 * Gestionnaire d'état de transmission d'une session : qui émet en ce moment, et vers quelles cibles.
 * Chaque prise de parole accordée (une par demande) est retenue jusqu'à sa fin. Les canaux qu'elle
 * occupe ne sont pas stockés : ils découlent des cibles et des règles du moment (voir Session).
 */
class TransmissionState {
  /** @type {Map<string, Map<number, { targets: string[], channelId: string }>>} membre -> demande -> émission */
  #transmissions = new Map();

  hold(memberId, requestId, transmission) {
    if (!this.#transmissions.has(memberId)) this.#transmissions.set(memberId, new Map());
    this.#transmissions.get(memberId).set(requestId, transmission);
  }

  release(memberId, requestId) {
    const own = this.#transmissions.get(memberId);
    if (!own?.delete(requestId) || own.size > 0) return;
    this.#transmissions.delete(memberId);
  }

  releaseAll(memberId) {
    this.#transmissions.delete(memberId);
  }

  countOf(memberId) {
    return this.#transmissions.get(memberId)?.size ?? 0;
  }

  /** Cibles vers lesquelles ce membre émet (une cible peut être couverte par plusieurs demandes). */
  targetsOf(memberId) {
    const own = this.#transmissions.get(memberId);
    return own ? [...new Set([...own.values()].flatMap(({ targets }) => targets))] : [];
  }

  transmitters() {
    return [...this.#transmissions.keys()];
  }

  /** Copie : on peut libérer des émissions en la parcourant. */
  entries() {
    return [...this.#transmissions].flatMap(([memberId, own]) => [...own].map(([requestId, transmission]) => ({ memberId, requestId, transmission })));
  }
}

module.exports = { TransmissionState };
