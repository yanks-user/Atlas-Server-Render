// Protocole JSON échangé avec les clients.
// Le client (src/renderer/js/net/protocol.js) en garde une copie : les garder synchronisés.
const { parseVersion } = require('./version');

const MESSAGE_TYPES = Object.freeze({
  // Client -> serveur
  AUTH: 'auth',                     // { password, resumeToken?, identityToken, nickname?, clientVersion? }  obligatoirement le premier message
  // Devient gérant ; template : canaux et règles à recréer ; code : celui de la session relancée, s'il est disponible ;
  // resume : retrouver la session telle qu'elle était si le serveur l'a gardée (template ne sert alors qu'à défaut)
  CREATE_SESSION: 'create-session', // { nickname, template?, code?, resume? }
  JOIN_SESSION: 'join-session',     // { code, nickname }          arrive hors canal vocal
  LEAVE_SESSION: 'leave-session',   // {}
  JOIN_CHANNEL: 'join-channel',     // { channelId | null }        se déplace soi-même (null = quitter le vocal)
  // Prise de parole : demande vers une ou plusieurs cibles (voir TARGETS), accordée ou refusée d'un bloc
  TX_REQUEST: 'tx_request',         // { requestId, targets }
  TX_RELEASE: 'tx_release',         // { requestId }               fin de transmission
  PING: 'ping',                     // {}  le serveur répond 'pong'
  // Gérant -> serveur
  CREATE_CHANNEL: 'create-channel', // { name }
  RENAME_CHANNEL: 'rename-channel', // { channelId, name }
  DELETE_CHANNEL: 'delete-channel', // { channelId }  ses membres se retrouvent hors canal
  MOVE_MEMBER: 'move-member',       // { memberId, channelId | null }
  // Une case de la matrice par requête : chaque clic s'applique à l'état réel, sans en écraser un autre
  // « Qui parle à qui » : une case = « le canal sourceId parle (RAD Ext) au canal channelId » (côté serveur : channelId l'entend)
  SET_HEARING: 'set-hearing',       // { channelId, sourceId, enabled }  sourceId parle (ou non) à channelId
  SET_BROADCAST: 'set-broadcast',   // { channelId, enabled }            le canal peut diffuser à tous
  // RAD prioritaire (réglage allowPriorityRad) : le canal coupe la parole de qui occupe déjà un canal qu'il vise, même en Half-Duplex
  SET_PRIORITY: 'set-priority',     // { channelId, enabled }
  KICK_MEMBER: 'kick-member',       // { memberId }
  SET_LOCKED: 'set-locked',         // { locked }    plus personne ne peut rejoindre
  // Gérant seul (les commandes ci-dessus dépendent des options du rôle : voir COMMAND_PERMISSIONS)
  SET_MANAGER: 'set-manager',       // { memberId }  passe la main
  SET_ROLE: 'set-role',             // { memberId, role }  voir ROLES, ou l'identifiant d'un rôle personnalisé
  SAVE_ROLE: 'save-role',           // { id?, name, permissions }  sans id : crée le rôle personnalisé
  DELETE_ROLE: 'delete-role',       // { id }  ceux qui l'ont redeviennent joueurs
  REGENERATE_CODE: 'regenerate-code', // {}  nouveau code ; l'ancien ne permet plus de rejoindre
  // Champs absents inchangés ; réglages : voir DEFAULT_SESSION_SETTINGS
  SET_SESSION_SETTINGS: 'set-session-settings', // { name?, freeMovement?, allowExt?, allowToggleMode?, allowJoinWithoutManager?, managerHearsAll?, enableRadioSounds?, halfDuplexMode?, allowPriorityRad?, hideOtherChannels? }
  // Client -> serveur -> pair autorisé par la matrice de routage
  OFFER: 'offer',                   // { to, payload }  relayé en { from, payload }
  ANSWER: 'answer',
  ICE_CANDIDATE: 'ice-candidate',   // payload : liste de candidats (envoyés par lots)
  // Serveur -> client
  // serverVersion : version de ce serveur ; minClientVersion : application la plus ancienne qu'il accepte sans avertissement
  READY: 'ready',                   // { clientId, resumeToken, resumed, serverVersion, minClientVersion }
  // Authentification refusée, juste avant la fermeture forcée du socket : le client arrête de
  // se reconnecter et redemande le mot de passe (code 'invalid-password' ou 'too-many-attempts')
  AUTH_ERROR: 'auth_error',         // { code, message }
  // Pseudo réservé par un autre joueur (voir nickname-registry.js). Dans 'auth', le socket est ensuite
  // fermé ; en réponse à create-session ou join-session, la connexion reste ouverte (request : ce type)
  NAME_ERROR: 'name_error',         // { code, message, nickname, request? }
  // État complet (managerId null : gérant parti). Les canaux masqués (réglage hideOtherChannels) donnent à chaque joueur son propre état :
  // restricted: true, son seul canal, et les membres de ce canal ; le gérant et son encadrement y figurent sans canal (channelId null)
  SESSION: 'session',              // { code, name, locked, settings, managerId, absentManager, customRoles, channels, members, restricted? }
  ROUTING: 'routing',               // { targets, audience: { cible: [id] }, peers: [{ id, send, receive }] }
  SESSION_ENDED: 'session-ended',   // { reason: 'left' | 'kicked' }
  TX_GRANTED: 'tx_granted',         // { requestId, targets }  le micro peut s'ouvrir
  TX_DENIED: 'tx_denied',           // { requestId, targets, by }  by : le membre qui occupe la cible (null : cible non autorisée)
  // Émission annulée par le serveur : déplacé dans un autre canal, cible retirée, devenu auditeur…
  // reason: 'priority' quand un RAD prioritaire a coupé la parole (by : le membre qui l'a prise)
  TX_REVOKED: 'tx_revoked',         // { requestId, reason?, by? }
  SPEAKING: 'speaking',             // { from, target, active }  indicateur « en train de parler », envoyé à l'audience
  PONG: 'pong',
  ERROR: 'error',                   // { code, message, request }
});

// Cibles du RAD
const TARGETS = Object.freeze({
  INT: 'int',       // son canal uniquement
  EXT: 'ext',       // uniquement les canaux à qui le sien parle (« qui parle à qui »), s'il y en a
  GLOBAL: 'global', // toute la session (gérant, ou canal autorisé à diffuser)
});

// Un seul canal, choisi dans la liste ('channel:<id>') : voir Session.computeRouting pour qui y a droit
const CHANNEL_TARGET_PREFIX = 'channel:';
const channelTarget = (channelId) => `${CHANNEL_TARGET_PREFIX}${channelId}`;

// Rôle d'un membre ; le gérant (managerId) a tous les droits, quel que soit son rôle.
// S'y ajoutent les rôles personnalisés de la session, créés par son gérant
const ROLES = Object.freeze({
  MEMBER: 'member',     // joueur : Int, et selon les droits de la session, Ext et changement de canal
  DEPUTY: 'deputy',     // adjoint : canaux, règles, placement des joueurs, RAD Général, parler à un canal
  LISTENER: 'listener', // auditeur : écoute seulement, ne peut pas parler
});

// Ce qu'une personne peut faire, option par option : un rôle personnalisé en permet autant qu'il veut
const PERMISSIONS = Object.freeze({
  TALK_INT: 'talkInt',                // parler à son canal
  TALK_EXT: 'talkExt',                // parler aux canaux qui écoutent le sien
  TALK_GLOBAL: 'talkGlobal',          // parler à toute la session
  TALK_ANY_CHANNEL: 'talkAnyChannel', // parler à n'importe quel canal seul
  HEAR_ALL: 'hearAll',                // entendre toutes les communications, sans tenir compte de « qui parle à qui »
  MOVE_SELF: 'moveSelf',              // changer de canal soi-même
  MOVE_MEMBERS: 'moveMembers',        // déplacer les autres
  MANAGE_CHANNELS: 'manageChannels',  // créer, renommer et supprimer des canaux
  MANAGE_ROUTING: 'manageRouting',    // régler « qui parle à qui » et le RAD prioritaire
  KICK_MEMBERS: 'kickMembers',        // exclure de la session
  LOCK_SESSION: 'lockSession',        // verrouiller la session
});

const DEPUTY_PERMISSIONS = new Set([
  PERMISSIONS.TALK_INT, PERMISSIONS.TALK_EXT, PERMISSIONS.TALK_GLOBAL, PERMISSIONS.TALK_ANY_CHANNEL,
  PERMISSIONS.MOVE_SELF, PERMISSIONS.MOVE_MEMBERS, PERMISSIONS.MANAGE_CHANNELS, PERMISSIONS.MANAGE_ROUTING,
]);

const MAX_CUSTOM_ROLES = 20;
const ROLE_NAME_LENGTH = Object.freeze({ min: 1, max: 24 });
// Un rôle personnalisé ne peut pas se faire passer pour un rôle de base
const RESERVED_ROLE_NAMES = new Set(['gérant', 'adjoint', 'joueur', 'auditeur']);

// Réglages de la session, par le gérant (paramètres de la session)
const DEFAULT_SESSION_SETTINGS = Object.freeze({
  freeMovement: true,      // les joueurs changent de canal eux-mêmes (sinon le gérant ou un adjoint les place)
  allowExt: true,          // les joueurs peuvent parler en RAD Ext (sinon Int seulement)
  allowToggleMode: false,  // chacun peut choisir « appuyer pour démarrer / arrêter » (sinon, tous maintiennent la touche)
  allowJoinWithoutManager: true, // on peut entrer dans la session, ou la rouvrir, même si le gérant n'est pas là
  managerHearsAll: false,  // le gérant entend toutes les communications (sinon, « qui parle à qui » vaut aussi pour lui)
  enableRadioSounds: true, // bips de prise et de fin de parole, joués par chaque client
  halfDuplexMode: false,   // un seul émetteur à la fois vers un canal : les autres sont refusés
  // Les canaux marqués prioritaires (channel.priority) coupent la parole de qui occupe un canal qu'ils visent, même en Half-Duplex
  allowPriorityRad: false,
  // Canaux masqués : chaque joueur ne voit que son canal et ceux qui y sont, et ne parle qu'à lui (secret des équipes).
  // Le gérant et les rôles qui encadrent les autres gardent la vue d'ensemble (voir Session.seesAllChannels)
  hideOtherChannels: false,
});

const ERROR_CODES = Object.freeze({
  INVALID: 'invalid',
  NOT_IN_SESSION: 'not-in-session',
  NOT_MANAGER: 'not-manager',
  SESSION_NOT_FOUND: 'session-not-found',
  SESSION_INVALID: 'session-invalid',   // code remplacé par le gérant : il ne servira plus jamais
  SESSION_NOT_OPEN: 'session-not-open', // code valide, mais son gérant n'a pas encore relancé la session
  SESSION_LOCKED: 'session-locked',
  MANAGER_ABSENT: 'manager-absent',     // le gérant n'est pas là, et la session n'accepte personne en son absence
  SESSION_FULL: 'session-full',
  NICKNAME_TAKEN: 'nickname-taken',
  CHANNEL_NOT_FOUND: 'channel-not-found',
  CHANNEL_EXISTS: 'channel-exists',
  CHANNEL_LIMIT: 'channel-limit',
  MEMBER_NOT_FOUND: 'member-not-found',
  ROLE_NOT_FOUND: 'role-not-found',
  ROLE_EXISTS: 'role-exists',
  ROLE_LIMIT: 'role-limit',
  NOT_ALLOWED: 'not-allowed',
  NICKNAME_RESERVED: 'nickname-reserved',
  IDENTITY_REQUIRED: 'identity-required',
  SERVER_FULL: 'server-full',
  TOO_MANY_ATTEMPTS: 'too-many-attempts',
  INVALID_PASSWORD: 'invalid-password',
});

// Événements WebRTC relayés d'un pair à un autre, uniquement entre pairs autorisés
const RELAYED_TYPES = new Set([
  MESSAGE_TYPES.OFFER,
  MESSAGE_TYPES.ANSWER,
  MESSAGE_TYPES.ICE_CANDIDATE,
]);

// L'option que demande chaque commande
const COMMAND_PERMISSIONS = new Map([
  [MESSAGE_TYPES.CREATE_CHANNEL, PERMISSIONS.MANAGE_CHANNELS],
  [MESSAGE_TYPES.RENAME_CHANNEL, PERMISSIONS.MANAGE_CHANNELS],
  [MESSAGE_TYPES.DELETE_CHANNEL, PERMISSIONS.MANAGE_CHANNELS],
  [MESSAGE_TYPES.MOVE_MEMBER, PERMISSIONS.MOVE_MEMBERS],
  [MESSAGE_TYPES.SET_HEARING, PERMISSIONS.MANAGE_ROUTING],
  [MESSAGE_TYPES.SET_BROADCAST, PERMISSIONS.MANAGE_ROUTING],
  [MESSAGE_TYPES.SET_PRIORITY, PERMISSIONS.MANAGE_ROUTING],
  [MESSAGE_TYPES.KICK_MEMBER, PERMISSIONS.KICK_MEMBERS],
  [MESSAGE_TYPES.SET_LOCKED, PERMISSIONS.LOCK_SESSION],
]);

// Gérant seul : rien qui permette de se donner plus de droits ne passe par un rôle
const MANAGER_TYPES = new Set([
  MESSAGE_TYPES.SET_MANAGER,
  MESSAGE_TYPES.SET_ROLE,
  MESSAGE_TYPES.SAVE_ROLE,
  MESSAGE_TYPES.DELETE_ROLE,
  MESSAGE_TYPES.REGENERATE_CODE,
  MESSAGE_TYPES.SET_SESSION_SETTINGS,
]);

const NICKNAME_LENGTH = Object.freeze({ min: 2, max: 24 });
const CHANNEL_NAME_LENGTH = Object.freeze({ min: 1, max: 32 });
const SESSION_NAME_LENGTH = Object.freeze({ min: 1, max: 48 });
const ROLE_VALUES = new Set(Object.values(ROLES));
const PERMISSION_VALUES = new Set(Object.values(PERMISSIONS));
const CODE_PATTERN = /^[A-Z0-9]{4}$/;
const ID_PATTERN = /^[\w-]{1,64}$/;
const MAX_PASSWORD_LENGTH = 256;
const MAX_TOKEN_LENGTH = 128;
const MAX_VERSION_LENGTH = 32;
// Jeton d'identité d'un PC : UUID v4 généré une fois pour toutes par l'application
const IDENTITY_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_HEARS = 64;
// Le serveur applique ensuite sa propre limite de canaux par session
const MAX_TEMPLATE_CHANNELS = 64;
const TARGET_VALUES = new Set(Object.values(TARGETS));
// Le serveur vérifie ensuite que chaque cible fait partie du routage de l'émetteur
const MAX_TX_TARGETS = 64;

/** Texte affiché aux autres : espaces normalisés, sans caractères de contrôle ni invisibles. */
function cleanText(value, { min, max }) {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (text.length < min || text.length > max || /\p{C}/u.test(text)) return null;
  return text;
}

const isId = (value) => typeof value === 'string' && ID_PATTERN.test(value);
const isChannelOrNone = (value) => value === null || isId(value);
const isRequestId = (value) => Number.isSafeInteger(value) && value >= 0;
const isTarget = (value) => TARGET_VALUES.has(value)
  || (typeof value === 'string' && value.startsWith(CHANNEL_TARGET_PREFIX) && isId(value.slice(CHANNEL_TARGET_PREFIX.length)));

/** Droits de session : seuls les booléens connus sont gardés (les champs absents ne changent pas). */
function parseSettings(settings) {
  if (!settings || typeof settings !== 'object') return {};
  return Object.fromEntries(Object.keys(DEFAULT_SESSION_SETTINGS)
    .filter((key) => typeof settings[key] === 'boolean')
    .map((key) => [key, settings[key]]));
}

const roleNameKey = (name) => name.toLocaleLowerCase('fr');
const isReservedRoleName = (name) => RESERVED_ROLE_NAMES.has(roleNameKey(name));
/** Seules les options connues sont gardées : une version plus récente peut en avoir d'autres. */
const parsePermissions = (permissions) => [...new Set(permissions.filter((permission) => PERMISSION_VALUES.has(permission)))];

/** Rôles personnalisés d'un modèle : la liste nettoyée, ou null si elle est invalide. */
function parseCustomRoles(roles) {
  if (!Array.isArray(roles) || roles.length > MAX_CUSTOM_ROLES) return null;
  const ids = new Set();
  const names = new Set();
  const clean = [];
  for (const role of roles) {
    const name = cleanText(role?.name, ROLE_NAME_LENGTH);
    if (!name || isReservedRoleName(name) || names.has(roleNameKey(name))) return null;
    if (!isId(role.id) || ROLE_VALUES.has(role.id) || ids.has(role.id) || !Array.isArray(role.permissions)) return null;
    ids.add(role.id);
    names.add(roleNameKey(name));
    clean.push({ id: role.id, name, permissions: parsePermissions(role.permissions) });
  }
  return clean;
}

/** Modèle de session (nom, droits, rôles personnalisés, canaux + règles) : retourne le modèle nettoyé, ou un texte d'erreur. */
function parseTemplate(template) {
  if (!template || typeof template !== 'object' || !Array.isArray(template.channels)) return 'Modèle de session invalide.';
  if (template.channels.length > MAX_TEMPLATE_CHANNELS) return `Modèle : ${MAX_TEMPLATE_CHANNELS} canaux au maximum.`;
  const channels = [];
  for (const channel of template.channels) {
    const name = cleanText(channel?.name, CHANNEL_NAME_LENGTH);
    if (!isId(channel?.id) || !name) return 'Modèle : canal invalide.';
    if (!Array.isArray(channel.hears) || channel.hears.length > MAX_HEARS || !channel.hears.every(isId)) {
      return `Modèle : règles du canal « ${name} » invalides.`;
    }
    // priority : absent d'un modèle ou d'une session gardée avant le RAD prioritaire
    channels.push({ id: channel.id, name, hears: [...new Set(channel.hears)], broadcast: channel.broadcast === true, priority: channel.priority === true });
  }
  // Nom absent ou invalide : la session n'en a simplement pas
  const name = cleanText(template.name, SESSION_NAME_LENGTH);
  const parsed = { channels, name, settings: parseSettings(template.settings) };
  // Absents d'un ancien modèle : la session garde ceux qu'elle a
  if (template.customRoles === undefined) return parsed;
  const customRoles = parseCustomRoles(template.customRoles);
  return customRoles ? { ...parsed, customRoles } : 'Modèle : rôles personnalisés invalides.';
}

const NICKNAME_ERROR = `Pseudo invalide (${NICKNAME_LENGTH.min} à ${NICKNAME_LENGTH.max} caractères).`;
const CHANNEL_NAME_ERROR = `Nom de canal invalide (${CHANNEL_NAME_LENGTH.min} à ${CHANNEL_NAME_LENGTH.max} caractères).`;

/** Champs attendus pour chaque type : retourne le message nettoyé, ou un texte d'erreur. */
const PARSERS = {
  [MESSAGE_TYPES.AUTH]: ({ password, resumeToken, identityToken, nickname, clientVersion }) => {
    if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return 'Mot de passe manquant.';
    const token = typeof resumeToken === 'string' && resumeToken.length <= MAX_TOKEN_LENGTH ? resumeToken : null;
    return {
      password,
      resumeToken: token,
      // Absente d'une ancienne application, ou illisible : sans importance pour la connexion
      clientVersion: typeof clientVersion === 'string' && parseVersion(clientVersion) ? clientVersion.trim().slice(0, MAX_VERSION_LENGTH) : null,
      // Jeton invalide ou absent (ancienne version) : refus au moment d'utiliser un pseudo
      identityToken: typeof identityToken === 'string' && IDENTITY_TOKEN_PATTERN.test(identityToken) ? identityToken.toLowerCase() : null,
      // Pseudo facultatif : pas encore saisi au premier lancement, ou en cours de saisie
      nickname: cleanText(nickname, NICKNAME_LENGTH),
    };
  },

  [MESSAGE_TYPES.CREATE_SESSION]: ({ nickname, template, code, resume }) => {
    const clean = cleanText(nickname, NICKNAME_LENGTH);
    if (!clean) return NICKNAME_ERROR;
    // Code invalide (fichier retouché) : ignoré, la session en reçoit un nouveau
    const requested = { nickname: clean, code: typeof code === 'string' && CODE_PATTERN.test(code) ? code : null, resume: resume === true };
    if (template === undefined || template === null) return { ...requested, template: null };
    const parsed = parseTemplate(template);
    return typeof parsed === 'string' ? parsed : { ...requested, template: parsed };
  },

  [MESSAGE_TYPES.JOIN_SESSION]: ({ code, nickname }) => {
    const cleanCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
    if (!CODE_PATTERN.test(cleanCode)) return 'Code de session invalide (4 caractères).';
    const clean = cleanText(nickname, NICKNAME_LENGTH);
    return clean ? { code: cleanCode, nickname: clean } : NICKNAME_ERROR;
  },

  [MESSAGE_TYPES.LEAVE_SESSION]: () => ({}),
  [MESSAGE_TYPES.JOIN_CHANNEL]: ({ channelId }) => (isChannelOrNone(channelId) ? { channelId } : 'Canal invalide.'),
  [MESSAGE_TYPES.PING]: () => ({}),

  [MESSAGE_TYPES.TX_REQUEST]: ({ requestId, targets }) => (isRequestId(requestId) && Array.isArray(targets)
    && targets.length > 0 && targets.length <= MAX_TX_TARGETS && targets.every(isTarget)
    ? { requestId, targets: [...new Set(targets)] }
    : 'Demande de parole invalide.'),

  [MESSAGE_TYPES.TX_RELEASE]: ({ requestId }) => (isRequestId(requestId) ? { requestId } : 'Fin de transmission invalide.'),

  [MESSAGE_TYPES.CREATE_CHANNEL]: ({ name }) => {
    const clean = cleanText(name, CHANNEL_NAME_LENGTH);
    return clean ? { name: clean } : CHANNEL_NAME_ERROR;
  },

  [MESSAGE_TYPES.RENAME_CHANNEL]: ({ channelId, name }) => {
    if (!isId(channelId)) return 'Canal invalide.';
    const clean = cleanText(name, CHANNEL_NAME_LENGTH);
    return clean ? { channelId, name: clean } : CHANNEL_NAME_ERROR;
  },

  [MESSAGE_TYPES.DELETE_CHANNEL]: ({ channelId }) => (isId(channelId) ? { channelId } : 'Canal invalide.'),

  [MESSAGE_TYPES.MOVE_MEMBER]: ({ memberId, channelId }) => (isId(memberId) && isChannelOrNone(channelId)
    ? { memberId, channelId }
    : 'Déplacement invalide.'),

  [MESSAGE_TYPES.SET_HEARING]: ({ channelId, sourceId, enabled }) => (isId(channelId) && isId(sourceId)
    ? { channelId, sourceId, enabled: enabled === true }
    : 'Règle d\'écoute invalide.'),

  [MESSAGE_TYPES.SET_BROADCAST]: ({ channelId, enabled }) => (isId(channelId)
    ? { channelId, enabled: enabled === true }
    : 'Canal invalide.'),

  [MESSAGE_TYPES.SET_PRIORITY]: ({ channelId, enabled }) => (isId(channelId)
    ? { channelId, enabled: enabled === true }
    : 'Canal invalide.'),

  [MESSAGE_TYPES.SET_MANAGER]: ({ memberId }) => (isId(memberId) ? { memberId } : 'Membre invalide.'),
  [MESSAGE_TYPES.KICK_MEMBER]: ({ memberId }) => (isId(memberId) ? { memberId } : 'Membre invalide.'),
  [MESSAGE_TYPES.SET_LOCKED]: ({ locked }) => ({ locked: locked === true }),
  [MESSAGE_TYPES.REGENERATE_CODE]: () => ({}),

  // La session vérifie que ce rôle existe
  [MESSAGE_TYPES.SET_ROLE]: ({ memberId, role }) => (isId(memberId) && isId(role)
    ? { memberId, role }
    : 'Rôle invalide.'),

  [MESSAGE_TYPES.SAVE_ROLE]: ({ id, name, permissions }) => {
    if (id !== undefined && id !== null && !isId(id)) return 'Rôle invalide.';
    const clean = cleanText(name, ROLE_NAME_LENGTH);
    if (!clean) return `Nom de rôle invalide (${ROLE_NAME_LENGTH.min} à ${ROLE_NAME_LENGTH.max} caractères).`;
    if (isReservedRoleName(clean)) return `« ${clean} » est déjà un rôle de base : choisissez un autre nom.`;
    if (!Array.isArray(permissions)) return 'Options du rôle invalides.';
    return { id: id ?? null, name: clean, permissions: parsePermissions(permissions) };
  },

  [MESSAGE_TYPES.DELETE_ROLE]: ({ id }) => (isId(id) ? { id } : 'Rôle invalide.'),

  // name : texte (vide = sans nom) ; droits : booléens. Au moins un champ.
  [MESSAGE_TYPES.SET_SESSION_SETTINGS]: ({ name, ...rights }) => {
    const update = { settings: parseSettings(rights) };
    if (name !== undefined) {
      const empty = typeof name === 'string' && name.trim() === '';
      const clean = empty ? null : cleanText(name, SESSION_NAME_LENGTH);
      if (!empty && !clean) return `Nom de session invalide (${SESSION_NAME_LENGTH.max} caractères maximum).`;
      update.name = clean;
    }
    if (update.name === undefined && Object.keys(update.settings).length === 0) return 'Aucun paramètre à modifier.';
    return update;
  },
};

for (const type of RELAYED_TYPES) {
  PARSERS[type] = ({ to, payload }) => (isId(to) && payload !== undefined && payload !== null
    ? { to, payload }
    : `Message ${type} incomplet (to et payload requis).`);
}

/** Décode un message brut. Retourne { message } ou { error, type }. */
function parseMessage(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: 'Message JSON invalide.', type: null };
  }
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
    return { error: 'Message sans type.', type: null };
  }

  const parser = Object.hasOwn(PARSERS, data.type) ? PARSERS[data.type] : null;
  if (!parser) return { error: `Type de message inconnu : ${data.type}.`, type: data.type };

  const result = parser(data);
  if (typeof result === 'string') return { error: result, type: data.type };
  return { message: { type: data.type, ...result } };
}

module.exports = {
  MESSAGE_TYPES,
  TARGETS,
  channelTarget,
  ROLES,
  PERMISSIONS,
  DEPUTY_PERMISSIONS,
  MAX_CUSTOM_ROLES,
  DEFAULT_SESSION_SETTINGS,
  ERROR_CODES,
  RELAYED_TYPES,
  COMMAND_PERMISSIONS,
  MANAGER_TYPES,
  NICKNAME_LENGTH,
  CHANNEL_NAME_LENGTH,
  parseTemplate,
  parseMessage,
};
