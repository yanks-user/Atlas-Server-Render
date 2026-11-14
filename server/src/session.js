const { randomBytes, randomInt } = require('crypto');
const { TARGETS, ROLES, PERMISSIONS, DEPUTY_PERMISSIONS, MAX_CUSTOM_ROLES, DEFAULT_SESSION_SETTINGS, ERROR_CODES, channelTarget } = require('./protocol');
const { TransmissionState } = require('./transmission-state');
const { hashToken } = require('./reservation-file');

const SESSION_LIMITS = Object.freeze({
  // Audio en maillage : chaque client envoie un flux par pair, au-delà la bande passante ne suit plus
  maxMembers: 24,
  maxChannels: 20,
});

// Sans 0/O ni 1/I : un code se dicte à voix haute sans ambiguïté
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const CHANNEL_ID_BYTES = 6;
const ROLE_ID_BYTES = 6;
const BASE_ROLES = new Set(Object.values(ROLES));
// Plusieurs RAD peuvent être maintenus ensemble ; au-delà, ce n'est plus un joueur qui appuie
const MAX_TRANSMISSIONS_PER_MEMBER = 16;
// Sourdines d'un membre qui n'en a annoncé aucune (ou application trop ancienne pour le faire)
const NO_MUTES = Object.freeze({ members: new Set(), channels: new Set() });
// Ceux qui encadrent les autres (placer, régler, exclure, tout entendre) gardent la vue d'ensemble quand les canaux sont masqués :
// sans elle, ils ne pourraient pas faire ce que leur rôle leur permet
const SUPERVISION_PERMISSIONS = Object.freeze([
  PERMISSIONS.MOVE_MEMBERS, PERMISSIONS.MANAGE_CHANNELS, PERMISSIONS.MANAGE_ROUTING, PERMISSIONS.KICK_MEMBERS, PERMISSIONS.HEAR_ALL,
]);

/** Erreur destinée au client (code + message lisible). */
class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function generateCode() {
  return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

/**
 * Une session de communication : ses canaux, ses membres, son gérant et sa matrice de routage.
 * Ne connaît ni les sockets ni le réseau (voir signaling-server.js).
 *
 * Une session commence sans canal. Un membre qui arrive n'est dans aucun canal vocal
 * (channelId null) : il n'entend personne et personne ne l'entend tant qu'il n'en a pas rejoint un.
 *
 * Matrice « qui parle à qui » : chaque canal a une liste de canaux qu'il entend (`hears`, c'est-à-dire ceux
 * qui lui parlent en RAD Ext) et peut être autorisé à diffuser à toute la session (`broadcast`).
 * Les cibles de RAD en découlent :
 * - 'int'    : entendu par son canal uniquement ;
 * - 'ext'    : entendu uniquement par les canaux qui entendent ce canal (pas le sien), s'il y en a ;
 * - 'global' : entendu par tous les membres présents dans un canal (gérant, adjoint, ou canal qui diffuse) ;
 * - 'channel:<id>' : entendu par les membres de ce seul canal. Tous les canaux pour le gérant et les
 *   adjoints ; pour les joueurs, le leur et ceux que leur RAD Ext atteint (« qui parle à qui »).
 *
 * Rôles (voir ROLES) : le gérant a tous les droits. Les adjoints gèrent canaux, règles et placement
 * des joueurs ; les auditeurs écoutent sans pouvoir parler. Les droits des joueurs (changer de canal
 * eux-mêmes, RAD Ext) sont des paramètres de la session, réglés par le gérant.
 *
 * Rôles personnalisés : créés par le gérant, ils permettent option par option (voir PERMISSIONS) ce qui y est
 * coché, et rien d'autre. Les droits des joueurs et la diffusion d'un canal ne les concernent pas. Ils
 * ne donnent jamais accès à ce qui permettrait de s'en donner davantage (rôles, paramètres de la session).
 *
 * Ce qu'on entend ne dépend pas du rôle : « qui parle à qui » vaut aussi pour le gérant. Seuls le réglage
 * managerHearsAll, désactivé par défaut, et l'option « tout entendre » d'un rôle personnalisé y dérogent ;
 * hors canal vocal, on n'entend toujours personne.
 *
 * Le gérant le reste tant qu'il ne passe pas la main : s'il part, personne ne le remplace (managerId
 * null) et les autres restent dans la session. Il retrouve sa place en revenant avec son jeton
 * d'identité, même session verrouillée ou pleine. Seul ce jeton le désigne, pas son pseudo.
 * En son absence, les autres peuvent entrer si le réglage allowJoinWithoutManager l'autorise.
 *
 * Une session survit à son dernier membre : son nom, son verrou, ses réglages, ses canaux, ses règles, son
 * gérant, ses rôles personnalisés et les rôles de ses joueurs (par jeton d'identité) sont gardés (voir session-store.js).
 *
 * Un canal se reconnaît à son identifiant, pas à son nom : unique d'une session à l'autre, il ne change
 * ni quand on renomme le canal, ni quand sa session est relancée depuis un modèle. Ce que chacun y a
 * rattaché de son côté (touches, volumes, RAD personnalisées) le suit donc partout.
 *
 * Prise de parole : le client n'ouvre son micro qu'une fois la parole accordée. Une émission occupe le canal
 * d'où elle part et ceux que ses cibles atteignent ; en Half-Duplex, on ne peut pas parler à un canal occupé,
 * gérant compris. Le premier arrivé garde la parole jusqu'à sa fin.
 *
 * RAD prioritaire (réglage allowPriorityRad, canaux marqués `priority`) : un membre d'un canal prioritaire ne se
 * voit pas refuser un canal occupé. Il coupe l'émission de ceux qui l'occupent, à moins qu'ils soient eux-mêmes
 * dans un canal prioritaire (à égalité, le premier arrivé garde la parole), puis la parole lui est accordée.
 *
 * Canaux masqués (réglage hideOtherChannels) : un joueur ne connaît que son canal. Le serveur ne lui envoie ni les
 * autres canaux ni leurs occupants (snapshot), il ne peut parler qu'à son canal (targetChannels) et c'est le gérant
 * qui le place (canMoveSelf). Ainsi, rien de ce qu'il reçoit ne trahit la présence de quelqu'un dans un autre canal.
 * Le gérant, et les rôles qui encadrent les autres (SUPERVISION_PERMISSIONS), gardent la vue d'ensemble : ils
 * figurent dans l'état de tous, sans canal, pour que leur voix reste attribuée.
 */
class Session {
  // Empreinte du jeton du gérant ; undefined : pas encore de gérant (le premier membre le devient)
  #managerHash = undefined;
  #managerNickname = null;
  /** Rôles autres que joueur, retenus même absent : empreinte du jeton d'identité -> rôle */
  #roles = new Map();
  /** Canal où chacun se trouvait en quittant la session, pour l'y remettre à son retour : empreinte du jeton d'identité -> canal */
  #lastChannels = new Map();

  constructor(code, limits = {}) {
    this.code = code;
    this.limits = { ...SESSION_LIMITS, ...limits };
    /** Nom affiché (facultatif), choisi par le gérant ou repris d'une session sauvegardée */
    this.name = null;
    this.settings = { ...DEFAULT_SESSION_SETTINGS };
    /** @type {Map<string, { id: string, name: string, permissions: string[] }>} */
    this.customRoles = new Map();
    /** @type {Map<string, { id: string, name: string, hears: Set<string>, broadcast: boolean, priority: boolean }>} */
    this.channels = new Map();
    /** Ordre d'insertion = ordre d'arrivée. */
    this.members = new Map();
    /** Identifiant du gérant s'il est présent, null s'il est parti. */
    this.managerId = null;
    this.locked = false;
    this.transmissions = new TransmissionState();
  }

  get isEmpty() {
    return this.members.size === 0;
  }

  isManager(memberId) {
    return this.managerId === memberId;
  }

  /** Ce jeton d'identité est-il celui du gérant, présent ou parti ? */
  isManagerIdentity(identityToken) {
    return Boolean(identityToken) && hashToken(identityToken) === this.#managerHash;
  }

  /** Le membre a-t-il cette option (voir PERMISSIONS) ? Un rôle personnalisé décide de tout, les autres sont fixés. */
  can(memberId, permission) {
    if (this.isManager(memberId)) return true;
    const role = this.members.get(memberId)?.role;
    if (this.customRoles.has(role)) return this.customRoles.get(role).permissions.includes(permission);
    if (role === ROLES.DEPUTY) return DEPUTY_PERMISSIONS.has(permission);
    if (permission === PERMISSIONS.MOVE_SELF) return this.settings.freeMovement;
    if (role !== ROLES.MEMBER) return false;
    return permission === PERMISSIONS.TALK_INT || (permission === PERMISSIONS.TALK_EXT && this.settings.allowExt);
  }

  /** Changer soi-même de canal (ou quitter le vocal) : impossible quand les canaux sont masqués, on ne les connaît pas. */
  canMoveSelf(memberId) {
    return this.can(memberId, PERMISSIONS.MOVE_SELF) && !this.isChannelBound(memberId);
  }

  /** Voit tous les canaux et tous les membres, même quand les canaux sont masqués : le gérant, et les rôles qui encadrent les autres. */
  seesAllChannels(memberId) {
    return this.isManager(memberId) || SUPERVISION_PERMISSIONS.some((permission) => this.can(memberId, permission));
  }

  /** Les canaux sont masqués pour ce membre : il ne voit que son canal et ne parle qu'à lui. */
  isChannelBound(memberId) {
    return this.settings.hideOtherChannels === true && !this.seesAllChannels(memberId);
  }

  /* ---------- Membres ---------- */

  addMember(id, nickname, identityToken = null) {
    // Le gérant parti retrouve toujours sa place
    const returningManager = this.managerId === null && this.isManagerIdentity(identityToken);
    if (this.locked && !returningManager) throw new SessionError(ERROR_CODES.SESSION_LOCKED, 'Cette session est verrouillée par son gérant.');
    const managerAway = this.#managerHash !== undefined && this.managerId === null;
    if (managerAway && !returningManager && !this.settings.allowJoinWithoutManager) {
      throw new SessionError(ERROR_CODES.MANAGER_ABSENT, 'Le gérant n\'est pas là : cette session n\'accepte personne en son absence.');
    }
    if (this.members.size >= this.limits.maxMembers && !returningManager) {
      throw new SessionError(ERROR_CODES.SESSION_FULL, `Session complète (${this.limits.maxMembers} membres maximum).`);
    }
    const lower = nickname.toLocaleLowerCase('fr');
    if ([...this.members.values()].some((m) => m.nickname.toLocaleLowerCase('fr') === lower)) {
      throw new SessionError(ERROR_CODES.NICKNAME_TAKEN, `Le pseudo « ${nickname} » est déjà utilisé dans cette session.`);
    }
    const identityHash = identityToken ? hashToken(identityToken) : null;
    // Parti depuis un canal qui existe toujours : il y revient directement. Sinon, aucun canal à l'arrivée : le membre choisit le sien
    // (ou le gérant l'y place). Son rôle l'attend s'il en avait un
    const lastChannel = identityHash ? this.#lastChannels.get(identityHash) : undefined;
    const channelId = lastChannel && this.channels.has(lastChannel) ? lastChannel : null;
    this.members.set(id, { id, nickname, channelId, connected: true, role: this.#roles.get(identityHash) ?? ROLES.MEMBER, identityToken, identityHash });
    if (this.#managerHash === undefined || returningManager) this.setManager(id);
  }

  /**
   * Retire un membre. Le gérant qui part n'est pas remplacé : il reste le gérant de la session.
   * (Sauf si son jeton est déjà de retour sous une autre connexion, l'ancienne n'ayant pas encore expiré.)
   */
  removeMember(id, { rememberChannel = true } = {}) {
    this.transmissions.releaseAll(id);
    // Son canal l'attendra à son retour ; parti hors canal (ou exclu), il reviendra hors canal
    const leaving = this.members.get(id);
    if (leaving?.identityHash) {
      if (rememberChannel && leaving.channelId) this.#lastChannels.set(leaving.identityHash, leaving.channelId);
      else this.#lastChannels.delete(leaving.identityHash);
    }
    if (!this.members.delete(id) || this.managerId !== id) return;
    const sameIdentity = this.#managerHash === null
      ? undefined
      : [...this.members.values()].find((m) => m.identityHash === this.#managerHash);
    this.managerId = sameIdentity?.id ?? null;
  }

  setConnected(id, connected) {
    const member = this.members.get(id);
    if (member) member.connected = connected;
  }

  /** Place un membre dans un canal ; channelId null = hors canal vocal. */
  moveMember(memberId, channelId) {
    const member = this.#member(memberId);
    if (channelId !== null) this.#channel(channelId);
    member.channelId = channelId;
  }

  /** Désigne le gérant (premier membre, retour du gérant, ou passage de main). */
  setManager(memberId) {
    const member = this.#member(memberId);
    this.managerId = memberId;
    this.#managerHash = member.identityHash;
    this.#managerNickname = member.nickname;
  }

  setLocked(locked) {
    this.locked = locked;
  }

  /** Rôle d'un membre (le gérant garde tous ses droits : son rôle ne compte qu'une fois la main passée). */
  setRole(memberId, role) {
    if (this.isManager(memberId)) throw new SessionError(ERROR_CODES.INVALID, 'Le gérant a déjà tous les droits.');
    if (!BASE_ROLES.has(role) && !this.customRoles.has(role)) throw new SessionError(ERROR_CODES.ROLE_NOT_FOUND, 'Ce rôle n\'existe plus.');
    const member = this.#member(memberId);
    member.role = role;
    if (!member.identityHash) return;
    if (role === ROLES.MEMBER) this.#roles.delete(member.identityHash);
    else this.#roles.set(member.identityHash, role);
  }

  /** Crée un rôle personnalisé (id null) ou le modifie : ce qu'il permet change aussitôt pour ceux qui l'ont. */
  saveCustomRole({ id, name, permissions }) {
    if (id && !this.customRoles.has(id)) throw new SessionError(ERROR_CODES.ROLE_NOT_FOUND, 'Ce rôle n\'existe plus.');
    if (!id && this.customRoles.size >= MAX_CUSTOM_ROLES) {
      throw new SessionError(ERROR_CODES.ROLE_LIMIT, `${MAX_CUSTOM_ROLES} rôles personnalisés au maximum.`);
    }
    const lower = name.toLocaleLowerCase('fr');
    if ([...this.customRoles.values()].some((role) => role.id !== id && role.name.toLocaleLowerCase('fr') === lower)) {
      throw new SessionError(ERROR_CODES.ROLE_EXISTS, `Un rôle « ${name} » existe déjà.`);
    }
    const roleId = id ?? randomBytes(ROLE_ID_BYTES).toString('hex');
    this.customRoles.set(roleId, { id: roleId, name, permissions });
  }

  /** Ceux qui l'avaient, présents ou non, redeviennent joueurs. */
  deleteCustomRole(id) {
    if (!this.customRoles.delete(id)) throw new SessionError(ERROR_CODES.ROLE_NOT_FOUND, 'Ce rôle n\'existe plus.');
    this.#forgetMissingRoles();
  }

  #forgetMissingRoles() {
    const exists = (role) => BASE_ROLES.has(role) || this.customRoles.has(role);
    for (const member of this.members.values()) {
      if (!exists(member.role)) member.role = ROLES.MEMBER;
    }
    for (const [hash, role] of this.#roles) {
      if (!exists(role)) this.#roles.delete(hash);
    }
  }

  /**
   * Nom (null : sans nom) et droits des joueurs ; les champs absents ne changent pas.
   * « Appuyer pour démarrer / arrêter » n'existe qu'en Full-Duplex : en Half-Duplex, une parole qui resterait ouverte sans qu'on tienne la touche
   * bloquerait le canal des autres. Repasser en Half-Duplex le retire, et il faut le cocher de nouveau après le retour en Full-Duplex.
   */
  updateSettings({ name, settings = {} }) {
    if (name !== undefined) this.name = name;
    Object.assign(this.settings, settings);
    if (this.settings.halfDuplexMode) this.settings.allowToggleMode = false;
  }

  /* ---------- Canaux ---------- */

  /** `id` : celui du canal dans un modèle relancé ; sinon, un nouveau canal reçoit le sien. */
  createChannel(name, id = randomBytes(CHANNEL_ID_BYTES).toString('hex')) {
    if (this.channels.size >= this.limits.maxChannels) {
      throw new SessionError(ERROR_CODES.CHANNEL_LIMIT, `${this.limits.maxChannels} canaux au maximum.`);
    }
    this.#assertNameFree(name);
    const channel = newChannel(id, name);
    this.channels.set(id, channel);
    return channel;
  }

  renameChannel(channelId, name) {
    const channel = this.#channel(channelId);
    this.#assertNameFree(name, channelId);
    channel.name = name;
  }

  /** Supprime un canal : ses membres se retrouvent hors canal, les règles qui le citent sont retirées. */
  deleteChannel(channelId) {
    this.#channel(channelId);
    this.channels.delete(channelId);
    for (const member of this.members.values()) {
      if (member.channelId === channelId) member.channelId = null;
    }
    for (const channel of this.channels.values()) channel.hears.delete(channelId);
  }

  /** Le canal `sourceId` parle (ou ne parle plus) au canal `channelId` : celui-ci l'entend quand on y parle en RAD Ext. */
  setHearing(channelId, sourceId, enabled) {
    const channel = this.#channel(channelId);
    this.#channel(sourceId);
    if (sourceId === channelId) throw new SessionError(ERROR_CODES.INVALID, 'Un canal s\'entend toujours lui-même.');
    if (enabled) channel.hears.add(sourceId);
    else channel.hears.delete(sourceId);
  }

  /** « Tout cocher » : chaque canal parle à tous les autres ; « Tout décocher » : chacun ne parle plus qu'à lui-même. La RAD Générale ne change pas. */
  setAllHearing(enabled) {
    for (const channel of this.channels.values()) {
      channel.hears.clear();
      if (!enabled) continue;
      for (const other of this.channels.keys()) if (other !== channel.id) channel.hears.add(other);
    }
  }

  /** Autorise (ou non) les membres du canal à utiliser la RAD Générale. */
  setBroadcast(channelId, enabled) {
    this.#channel(channelId).broadcast = enabled;
  }

  /** Les membres du canal sont prioritaires (ou non) : leur RAD coupe la parole de ceux qui occupent un canal visé. */
  setPriority(channelId, enabled) {
    this.#channel(channelId).priority = enabled;
  }

  /** Règles complètes d'un canal (chargement d'un modèle ; `priority` absent d'un ancien modèle : non prioritaire). */
  setRouting(channelId, { hears, broadcast, priority = false }) {
    const channel = this.#channel(channelId);
    for (const id of hears) this.#channel(id);
    channel.hears = new Set(hears.filter((id) => id !== channelId));
    channel.broadcast = broadcast;
    channel.priority = priority === true;
  }

  /**
   * Recrée le nom, les droits, les rôles personnalisés, les canaux et les règles d'un modèle sauvegardé.
   * Les canaux gardent les identifiants du fichier : ce sont les mêmes canaux qu'au lancement précédent.
   * @param {{ name?: string | null, settings?: object, customRoles?: { id: string, name: string, permissions: string[] }[], channels: { id: string, name: string, hears: string[], broadcast: boolean, priority?: boolean }[] }} template
   */
  applyTemplate({ channels, name = null, settings = {}, customRoles }) {
    this.updateSettings({ name, settings });
    if (customRoles) {
      this.customRoles = new Map(customRoles.map((role) => [role.id, role]));
      this.#forgetMissingRoles();
    }
    for (const { id, name } of channels) {
      if (this.channels.has(id)) throw new SessionError(ERROR_CODES.INVALID, `Modèle invalide : canal « ${id} » en double.`);
      this.createChannel(name, id);
    }
    for (const { id, hears, broadcast, priority } of channels) {
      const unknown = hears.find((source) => !this.channels.has(source));
      if (unknown) throw new SessionError(ERROR_CODES.INVALID, `Modèle invalide : règle vers un canal inconnu (${unknown}).`);
      this.setRouting(id, { hears, broadcast, priority });
    }
  }

  /**
   * Sauvegarde relancée par son gérant sur une session gardée : elle en remplace le nom, les réglages,
   * les canaux et les règles. Le verrou, le gérant et les rôles des joueurs restent.
   */
  replaceArchitecture(template) {
    this.channels.clear();
    this.applyTemplate(template);
  }

  /* ---------- Session gardée ---------- */

  /** Ce qui survit à la session quand elle se vide ou que le serveur redémarre (voir session-store.js). */
  persistentState() {
    return {
      name: this.name,
      locked: this.locked,
      settings: { ...this.settings },
      customRoles: [...this.customRoles.values()],
      channels: [...this.channels.values()].map(({ id, name, hears, broadcast, priority }) => ({ id, name, hears: [...hears], broadcast, priority })),
      managerHash: this.#managerHash ?? null,
      managerNickname: this.#managerNickname,
      roles: Object.fromEntries(this.#roles),
      // Seulement vers des canaux qui existent encore
      lastChannels: Object.fromEntries([...this.#lastChannels].filter(([, channelId]) => this.channels.has(channelId))),
    };
  }

  /** La session reprend là où elle en était, sans membres : le gérant reste absent jusqu'à son retour. */
  restoreState({ name, locked, settings, customRoles, channels, managerHash, managerNickname, roles, lastChannels = {} }) {
    this.applyTemplate({ name, settings, customRoles, channels });
    this.locked = locked;
    this.#managerHash = managerHash;
    this.#managerNickname = managerNickname;
    this.#roles = new Map(Object.entries(roles));
    this.#lastChannels = new Map(Object.entries(lastChannels));
  }

  /* ---------- Routage audio ---------- */

  /** Hors canal vocal, personne ne peut parler, pas même le gérant. Un joueur le peut depuis un canal qui diffuse. */
  canBroadcast(memberId) {
    const member = this.members.get(memberId);
    if (!member?.channelId) return false;
    if (this.can(memberId, PERMISSIONS.TALK_GLOBAL)) return true;
    return member.role === ROLES.MEMBER && this.channels.get(member.channelId)?.broadcast === true;
  }

  /**
   * Cibles de RAD autorisées à un membre, et les canaux que chacune atteint
   * (hors canal vocal : aucune ; sans option pour parler : aucune, mais il entend tout de même son canal).
   * @returns {Map<string, Set<string>>}
   */
  targetChannels(memberId) {
    const targets = new Map();
    const speaker = this.members.get(memberId);
    if (!speaker?.channelId) return targets;

    // Canaux masqués : ni Ext, ni Général, ni autre canal. Parler ailleurs révélerait qu'il y a quelqu'un
    if (this.isChannelBound(memberId)) {
      if (this.can(memberId, PERMISSIONS.TALK_INT)) {
        targets.set(TARGETS.INT, new Set([speaker.channelId]));
        targets.set(channelTarget(speaker.channelId), new Set([speaker.channelId]));
      }
      return targets;
    }

    // Ext : uniquement les canaux qui entendent ce canal, jamais le sien ; aucun canal relié : pas de cible
    const linked = new Set();
    for (const channel of this.channels.values()) {
      if (channel.hears.has(speaker.channelId)) linked.add(channel.id);
    }
    const intAllowed = this.can(memberId, PERMISSIONS.TALK_INT);
    const extAllowed = this.can(memberId, PERMISSIONS.TALK_EXT);
    if (intAllowed) targets.set(TARGETS.INT, new Set([speaker.channelId]));
    if (linked.size > 0 && extAllowed) targets.set(TARGETS.EXT, linked);
    if (this.canBroadcast(memberId)) targets.set(TARGETS.GLOBAL, new Set(this.channels.keys()));
    // Un seul canal : tous avec l'option ; sinon son canal et ceux que la RAD Ext atteint
    const reachable = this.can(memberId, PERMISSIONS.TALK_ANY_CHANNEL)
      ? [...this.channels.keys()]
      : [...(intAllowed ? [speaker.channelId] : []), ...(extAllowed ? linked : [])];
    for (const channelId of reachable) targets.set(channelTarget(channelId), new Set([channelId]));
    return targets;
  }

  /**
   * Demande de parole vers ces cibles : accordée ou refusée d'un bloc. En Half-Duplex, refusée si un
   * autre membre émet déjà vers l'un des canaux qu'elles atteignent, sauf pour une RAD prioritaire (voir
   * #canCut) : les émissions qui occupaient ces canaux sont alors coupées, et la parole lui est accordée.
   *
   * Sourdines (mutesOf : ce que chaque membre a coupé pour lui-même, voir MESSAGE_TYPES.SET_MUTES) :
   * - un membre d'un canal visé a mis en sourdine le canal de l'émetteur : refusée (reason 'channel-muted') ;
   * - un membre qui l'entendrait l'a mis en sourdine, lui seul : accordée quand même (mutedBy), les autres l'entendent.
   * @returns {{ granted: boolean, occupant: string | null, preempted: { memberId: string, requestId: number }[], reason?: string, mutedBy?: boolean }}
   *   occupant : le membre qui occupe le canal ; preempted : les émissions coupées pour donner la parole
   */
  requestTransmission(memberId, requestId, targets, mutesOf = () => NO_MUTES) {
    const reachable = this.targetChannels(memberId);
    const allowed = targets.every((target) => reachable.has(target));
    if (!allowed || this.transmissions.countOf(memberId) >= MAX_TRANSMISSIONS_PER_MEMBER) return { granted: false, occupant: null, preempted: [] };
    if (this.#channelMutedBy(memberId, targets, reachable, mutesOf)) return { granted: false, occupant: null, preempted: [], reason: 'channel-muted' };

    let preempted = [];
    if (this.settings.halfDuplexMode) {
      const wanted = new Set(targets.flatMap((target) => [...reachable.get(target)]));
      const blockers = this.#blockersOf(wanted, memberId);
      // Tout ou rien : si l'un d'eux ne peut pas être coupé, personne ne l'est et la parole est refusée
      const uncuttable = blockers.find((blocker) => !this.#canCut(memberId, blocker.memberId));
      if (uncuttable) return { granted: false, occupant: uncuttable.memberId, preempted: [] };
      preempted = blockers;
      for (const blocker of preempted) this.transmissions.release(blocker.memberId, blocker.requestId);
    }
    this.transmissions.hold(memberId, requestId, { targets, channelId: this.members.get(memberId).channelId });
    return { granted: true, occupant: null, preempted, mutedBy: this.#memberMutedBy(memberId, targets, reachable, mutesOf) };
  }

  /**
   * Un membre d'un canal visé a mis en sourdine le canal de l'émetteur. Seuls comptent les canaux visés autres que le sien
   * (son propre canal ne se met pas en sourdine) ; Général s'adresse à toute la session, pas à un canal : il n'est jamais refusé pour ça.
   */
  #channelMutedBy(memberId, targets, reachable, mutesOf) {
    const own = this.members.get(memberId).channelId;
    const visited = new Set(targets.filter((target) => target !== TARGETS.GLOBAL).flatMap((target) => [...reachable.get(target)]));
    visited.delete(own);
    return [...this.members.values()].some((m) => m.id !== memberId && visited.has(m.channelId) && mutesOf(m.id).channels.has(own));
  }

  /** Quelqu'un qui l'entendrait l'a coupé : lui seul, ou son canal par Général (les autres l'entendent quand même). */
  #memberMutedBy(memberId, targets, reachable, mutesOf) {
    const own = this.members.get(memberId).channelId;
    const reached = new Set(targets.flatMap((target) => [...reachable.get(target)]));
    return [...this.members.values()].some((m) => {
      if (m.id === memberId || !m.channelId || !(reached.has(m.channelId) || this.#hearsEverything(m.id))) return false;
      const mutes = mutesOf(m.id);
      return mutes.members.has(memberId) || (m.channelId !== own && mutes.channels.has(own));
    });
  }

  /** La RAD prioritaire est autorisé par la session et ce membre parle depuis un canal prioritaire. */
  hasPriority(memberId) {
    return this.settings.allowPriorityRad === true
      && this.channels.get(this.members.get(memberId)?.channelId)?.priority === true;
  }

  /** Une émission de `speakerId` peut couper celle de `otherId` : elle est prioritaire, pas la sienne (à égalité, le premier arrivé garde la parole). */
  #canCut(speakerId, otherId) {
    return this.hasPriority(speakerId) && !this.hasPriority(otherId);
  }

  /**
   * Les émissions d'autres membres qui occupent l'un de ces canaux, une entrée par demande : le canal d'où
   * elle part aussi (personne ne lui parle, pas même le canal à qui il émet pour lui répondre) et ceux que ses cibles atteignent.
   * @returns {{ memberId: string, requestId: number }[]}
   */
  #blockersOf(channelIds, exceptId) {
    const blockers = [];
    for (const { memberId, requestId, transmission } of this.transmissions.entries()) {
      if (memberId === exceptId) continue;
      const reachable = this.targetChannels(memberId);
      const occupied = [this.members.get(memberId)?.channelId, ...transmission.targets.flatMap((target) => [...(reachable.get(target) ?? [])])];
      if (occupied.some((channelId) => channelIds.has(channelId))) blockers.push({ memberId, requestId });
    }
    return blockers;
  }

  /**
   * Après un changement (déplacement, règle, rôle, droits) : une émission dont le membre a changé de
   * canal ou qui n'a plus de cible autorisée est annulée, les autres gardent ce qui reste permis.
   * @returns {{ memberId: string, requestId: number }[]} les émissions annulées
   */
  reconcileTransmissions() {
    const revoked = [];
    for (const { memberId, requestId, transmission } of this.transmissions.entries()) {
      const reachable = this.targetChannels(memberId);
      const targets = transmission.targets.filter((target) => reachable.has(target));
      if (targets.length > 0 && this.members.get(memberId)?.channelId === transmission.channelId) {
        transmission.targets = targets;
      } else {
        this.transmissions.release(memberId, requestId);
        revoked.push({ memberId, requestId });
      }
    }
    return revoked;
  }

  /**
   * Qui peut entendre qui, pour chaque membre (hors canal vocal : ni cible, ni audience) :
   * - targets  : cibles de RAD autorisées ;
   * - audience : pour chaque cible, les membres qui l'entendent ;
   * - peers    : membres avec qui une connexion WebRTC est nécessaire (send : il peut nous
   *              entendre ; receive : nous pouvons l'entendre).
   * @returns {Map<string, { targets: string[], audience: Record<string, string[]>, peers: { id: string, send: boolean, receive: boolean }[] }>}
   */
  computeRouting() {
    const members = [...this.members.values()];
    const audiences = new Map();

    for (const speaker of members) {
      // Seuls les membres présents dans un canal entendent quoi que ce soit
      const others = members.filter((m) => m.id !== speaker.id && m.channelId);
      const audience = {};
      for (const [target, channelIds] of this.targetChannels(speaker.id)) {
        audience[target] = others.filter((m) => channelIds.has(m.channelId) || this.#hearsEverything(m.id)).map((m) => m.id);
      }
      audiences.set(speaker.id, audience);
    }

    const hearsFrom = new Map(members.map((m) => [m.id, new Set()]));
    const heardBy = new Map();
    for (const [speakerId, audience] of audiences) {
      const listeners = new Set(Object.values(audience).flat());
      heardBy.set(speakerId, listeners);
      for (const listenerId of listeners) hearsFrom.get(listenerId).add(speakerId);
    }

    const routing = new Map();
    for (const member of members) {
      const send = heardBy.get(member.id);
      const receive = hearsFrom.get(member.id);
      const peerIds = new Set([...send, ...receive]);
      const audience = audiences.get(member.id);
      routing.set(member.id, {
        targets: Object.keys(audience),
        audience,
        peers: [...peerIds].sort().map((id) => ({ id, send: send.has(id), receive: receive.has(id) })),
      });
    }
    return routing;
  }

  /**
   * État de la session tel que le voit ce membre. Sans `viewerId`, ou quand les canaux ne lui sont pas masqués,
   * c'est l'état complet. Sinon : seulement son canal et ses occupants, plus ceux qui ont la vue d'ensemble
   * (le gérant, l'encadrement), sans leur canal : leur voix doit rester attribuée, pas leur position connue.
   */
  snapshot(viewerId = null) {
    const state = this.#fullSnapshot();
    if (viewerId === null || !this.isChannelBound(viewerId)) return state;

    const own = this.members.get(viewerId)?.channelId ?? null;
    return {
      ...state,
      restricted: true,
      channels: state.channels.filter((channel) => channel.id === own).map(({ id, name }) => ({ id, name, hears: [], broadcast: false, priority: false })),
      members: state.members
        .filter((member) => member.id === viewerId || (own !== null && member.channelId === own) || this.seesAllChannels(member.id))
        .map((member) => (member.channelId === own ? member : { ...member, channelId: null })),
    };
  }

  #fullSnapshot() {
    return {
      code: this.code,
      name: this.name,
      locked: this.locked,
      settings: { ...this.settings },
      customRoles: [...this.customRoles.values()],
      managerId: this.managerId,
      // Pseudo du gérant quand il est parti (il reprendra sa place à son retour), sinon null
      absentManager: this.managerId === null ? this.#managerNickname : null,
      channels: [...this.channels.values()].map(({ id, name, hears, broadcast, priority }) => ({
        id, name, hears: [...hears], broadcast, priority,
      })),
      members: [...this.members.values()].map(({ id, nickname, channelId, connected, role }) => ({
        id, nickname, channelId, connected, role,
      })),
    };
  }

  /* ---------- Interne ---------- */

  #hearsEverything(memberId) {
    return this.isManager(memberId) ? this.settings.managerHearsAll : this.can(memberId, PERMISSIONS.HEAR_ALL);
  }

  #member(memberId) {
    const member = this.members.get(memberId);
    if (!member) throw new SessionError(ERROR_CODES.MEMBER_NOT_FOUND, 'Ce membre a quitté la session.');
    return member;
  }

  #channel(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) throw new SessionError(ERROR_CODES.CHANNEL_NOT_FOUND, "Ce canal n'existe plus.");
    return channel;
  }

  #assertNameFree(name, exceptId = null) {
    const lower = name.toLocaleLowerCase('fr');
    for (const channel of this.channels.values()) {
      if (channel.id !== exceptId && channel.name.toLocaleLowerCase('fr') === lower) {
        throw new SessionError(ERROR_CODES.CHANNEL_EXISTS, `Un canal « ${name} » existe déjà.`);
      }
    }
  }
}

function newChannel(id, name) {
  return { id, name, hears: new Set(), broadcast: false, priority: false };
}

/** Ensemble des sessions du serveur, indexées par leur code. */
class SessionRegistry {
  #sessions = new Map();

  /** `isCodeReserved` : code gardé par un gérant, même sans session en cours (voir code-registry.js). */
  constructor({ maxSessions = 200, sessionLimits = {}, isCodeReserved = () => false } = {}) {
    this.maxSessions = maxSessions;
    this.sessionLimits = sessionLimits;
    this.isCodeReserved = isCodeReserved;
  }

  get size() {
    return this.#sessions.size;
  }

  /** Nouvelle session sous ce code (l'appelant a vérifié qu'il est disponible), ou sous un code libre. */
  create(code = null) {
    this.#assertRoom();
    const session = new Session(code ?? this.#freeCode(), this.sessionLimits);
    this.#sessions.set(session.code, session);
    return session;
  }

  /** Une session gardée rouvre sous son code (voir session-store.js). */
  restore(code, state) {
    this.#assertRoom();
    const session = new Session(code, this.sessionLimits);
    session.restoreState(state);
    this.#sessions.set(code, session);
    return session;
  }

  #assertRoom() {
    if (this.#sessions.size >= this.maxSessions) {
      throw new SessionError(ERROR_CODES.SERVER_FULL, 'Le serveur a atteint son nombre maximal de sessions.');
    }
  }

  get(code) {
    return this.#sessions.get(code) ?? null;
  }

  /** La session passe à un nouveau code ; l'ancien ne permet plus de la rejoindre. */
  regenerateCode(session) {
    this.#sessions.delete(session.code);
    session.code = this.#freeCode();
    this.#sessions.set(session.code, session);
  }

  #freeCode() {
    let code;
    do code = generateCode(); while (this.#sessions.has(code) || this.isCodeReserved(code));
    return code;
  }

  delete(code) {
    this.#sessions.delete(code);
  }
}

module.exports = { Session, SessionRegistry, SessionError, SESSION_LIMITS, CODE_ALPHABET, NO_MUTES };
