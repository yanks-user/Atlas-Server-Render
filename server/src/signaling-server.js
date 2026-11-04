const { randomUUID, randomBytes } = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { MESSAGE_TYPES, ERROR_CODES, RELAYED_TYPES, COMMAND_PERMISSIONS, MANAGER_TYPES, parseMessage } = require('./protocol');
const { SessionRegistry, SessionError } = require('./session');
const { RateLimiter, AuthGuard } = require('./security');
const { verifyPassword } = require('./password');
const { NicknameRegistry } = require('./nickname-registry');
const { CodeRegistry } = require('./code-registry');
const { SessionStore } = require('./session-store');
const { VERSION, MIN_CLIENT_VERSION } = require('./version');

// Code de fermeture WebSocket d'un départ volontaire (le client quitte, ce n'est pas une coupure)
const NORMAL_CLOSURE = 1000;
// Connexion refusée (mot de passe, blocage, pseudo) : la raison est dans le message envoyé juste avant
const REJECTED_CLOSE_CODE = 1008;

const LIMITS = Object.freeze({
  // Au-delà : message ignoré (une offre SDP audio fait quelques Ko)
  maxMessageBytes: 16 * 1024,
  // Au-delà : connexion coupée par ws (protection mémoire)
  maxPayloadBytes: 128 * 1024,
  messagesPerSecond: 10,
  authTimeoutMs: 5000,
  // Délai maximal pour livrer un message auth_error avant de détruire le socket
  authErrorFlushMs: 1000,
  heartbeatIntervalMs: 15000,
  // Durée pendant laquelle un client coupé garde sa place (micro-coupure réseau)
  resumeGraceMs: 20000,
  // Messages gardés pour un client coupé, renvoyés à sa reprise
  maxPendingMessages: 200,
  maxSessions: 200,
  maxMembersPerSession: 24,
  maxChannelsPerSession: 20,
});

/**
 * Serveur de signalisation par sessions. Il ne transporte jamais l'audio, seulement :
 * - l'état des sessions (canaux, membres, gérant, règles de diffusion), envoyé à chaque changement ;
 * - le routage de chaque membre (qui l'entend sur chaque cible, avec qui se connecter) ;
 * - les messages WebRTC (offer / answer / ice-candidate), relayés uniquement entre pairs
 *   que la matrice de routage autorise.
 *
 * Chaque connexion a un jeton de reprise : si le WebSocket coupe, le client garde sa place
 * pendant `resumeGraceMs` et la reprend en se reconnectant avec ce jeton.
 *
 * Anti-usurpation : un pseudo appartient au jeton d'identité du PC qui l'a utilisé le premier.
 * Il est vérifié à la connexion (s'il est fourni) puis à chaque création ou entrée dans une session,
 * où il est réellement utilisé : sinon on pourrait se connecter sous son pseudo et rejoindre sous un autre.
 *
 * `server` : serveur HTTP(S) existant (wss:// avec un serveur HTTPS) ; à défaut, écoute
 * en ws:// sur `port` (tests). `passwordHash` : empreinte scrypt du mot de passe du serveur.
 * `nicknames` : registre des pseudos réservés (en mémoire par défaut ; users.json en production).
 * `codes` : registre des codes de session réservés (en mémoire par défaut ; session-codes.json en production).
 * `sessions` : sessions gardées, retrouvées en revenant sous leur code (en mémoire par défaut ; sessions.json en production).
 * `trustProxy` : derrière un reverse proxy, l'adresse du client vient de X-Forwarded-For. Sinon tous les joueurs auraient
 * celle du proxy, et 5 erreurs d'un seul les bloqueraient tous. À n'activer que si le port n'est joignable que par le proxy.
 */
function createSignalingServer({
  server, port, host, passwordHash, logger = console, limits = {}, nicknames = new NicknameRegistry(), codes = new CodeRegistry(), sessions = new SessionStore(), trustProxy = false,
}) {
  const config = { ...LIMITS, ...limits };
  const authGuard = new AuthGuard();
  const registry = new SessionRegistry({
    maxSessions: config.maxSessions,
    sessionLimits: { maxMembers: config.maxMembersPerSession, maxChannels: config.maxChannelsPerSession },
    isCodeReserved: (code) => codes.isReserved(code) || sessions.has(code),
  });
  /** @type {Map<string, object>} jeton de reprise -> client */
  const clientsByToken = new Map();
  /** @type {Map<string, object>} identifiant -> client */
  const clientsById = new Map();

  const wss = server
    ? new WebSocketServer({ server, maxPayload: config.maxPayloadBytes })
    : new WebSocketServer({ port, host, maxPayload: config.maxPayloadBytes });

  /* ---------- Envoi ---------- */

  /** `buffered` : garder le message si le client est en coupure (sinon il est perdu). */
  function send(client, message, { buffered = false } = {}) {
    sendRaw(client, JSON.stringify(message), { buffered });
  }

  function sendRaw(client, serialized, { buffered = false } = {}) {
    if (client.socket?.readyState === WebSocket.OPEN) {
      client.socket.send(serialized);
      return true;
    }
    if (buffered && client.graceTimer) {
      if (client.pending.length >= config.maxPendingMessages) client.pending.shift();
      client.pending.push(serialized);
    }
    return false;
  }

  function sendError(client, request, code, message) {
    send(client, { type: MESSAGE_TYPES.ERROR, code, message, request });
  }

  function nameError(nickname, request = undefined) {
    return {
      type: MESSAGE_TYPES.NAME_ERROR,
      code: ERROR_CODES.NICKNAME_RESERVED,
      message: 'Ce pseudo est déjà réservé par un autre joueur.',
      nickname,
      request,
    };
  }

  function label(client) {
    return client.nickname ? `${client.nickname} (${client.id.slice(0, 8)})` : client.id.slice(0, 8);
  }

  /* ---------- Diffusion de l'état ---------- */

  /**
   * Envoie à chaque membre l'état de la session et son routage s'ils ont changé, puis met à jour
   * l'audience de ceux qui parlent et annule les émissions que ce changement ne permet plus.
   */
  function publish(session) {
    sessions.save(session.code, session.persistentState());
    const revoked = session.reconcileTransmissions();
    // Même état pour tous, sauf pour ceux à qui les canaux sont masqués : chacun reçoit alors le sien (voir Session.snapshot)
    let sharedState = null;
    const stateFor = (memberId) => {
      if (session.isChannelBound(memberId)) return JSON.stringify({ type: MESSAGE_TYPES.SESSION, ...session.snapshot(memberId) });
      sharedState ??= JSON.stringify({ type: MESSAGE_TYPES.SESSION, ...session.snapshot() });
      return sharedState;
    };
    const routing = session.computeRouting();

    for (const [memberId, own] of routing) {
      const client = clientsById.get(memberId);
      if (!client) continue;
      client.routing = { ...own, peerIds: new Set(own.peers.map((p) => p.id)) };

      // Un client en coupure recevra l'état complet à sa reprise (rien n'est mis en attente)
      const state = stateFor(memberId);
      if (state !== client.lastState && sendRaw(client, state)) client.lastState = state;
      const routingMessage = JSON.stringify({ type: MESSAGE_TYPES.ROUTING, ...own });
      if (routingMessage !== client.lastRouting && sendRaw(client, routingMessage)) client.lastRouting = routingMessage;
    }
    for (const memberId of routing.keys()) {
      const client = clientsById.get(memberId);
      if (client) refreshSpeaking(client);
    }
    // Après le routage : le client doit savoir ce qui reste permis pour redemander la parole
    for (const { memberId, requestId } of revoked) {
      const client = clientsById.get(memberId);
      if (client) send(client, { type: MESSAGE_TYPES.TX_REVOKED, requestId });
    }
  }

  /* ---------- Indicateur « en train de parler » ---------- */

  /** Qui est prévenu : ceux qui entendent la cible, et personne d'autre, pas même le gérant. */
  function speakingListeners(client, target) {
    return new Set(client.routing?.audience[target]);
  }

  function notifySpeaking(client, target, listenerIds, active) {
    const message = JSON.stringify({ type: MESSAGE_TYPES.SPEAKING, from: client.id, target, active });
    for (const id of listenerIds) {
      const listener = clientsById.get(id);
      if (listener) sendRaw(listener, message);
    }
  }

  /**
   * Met l'indicateur en accord avec les émissions en cours : prévenir quand une émission commence
   * ou finit, et les arrivants ou les partants quand une audience change pendant qu'on parle.
   */
  function refreshSpeaking(client) {
    const transmitted = new Set(client.session.transmissions.targetsOf(client.id));
    for (const target of transmitted) {
      if (client.speaking.has(target)) continue;
      const listeners = speakingListeners(client, target);
      client.speaking.set(target, listeners);
      notifySpeaking(client, target, listeners, true);
    }
    for (const [target, previous] of client.speaking) {
      const current = transmitted.has(target) ? speakingListeners(client, target) : new Set();
      notifySpeaking(client, target, [...current].filter((id) => !previous.has(id)), true);
      notifySpeaking(client, target, [...previous].filter((id) => !current.has(id)), false);
      if (transmitted.has(target)) client.speaking.set(target, current);
      else client.speaking.delete(target);
    }
  }

  /** Ses émissions s'arrêtent (départ, coupure) : la cible est libre pour les autres. */
  function stopSpeaking(client) {
    client.session?.transmissions.releaseAll(client.id);
    for (const [target, listeners] of client.speaking) notifySpeaking(client, target, listeners, false);
    client.speaking.clear();
  }

  /* ---------- Prise de parole ---------- */

  /** Le serveur arbitre ; le client n'ouvre son micro qu'à la réponse tx_granted. */
  function handleTxRequest(client, { requestId, targets }) {
    const { granted, occupant } = client.session
      ? client.session.requestTransmission(client.id, requestId, targets)
      : { granted: false, occupant: null };
    if (!granted) {
      send(client, { type: MESSAGE_TYPES.TX_DENIED, requestId, targets, by: occupant });
      return;
    }
    send(client, { type: MESSAGE_TYPES.TX_GRANTED, requestId, targets });
    refreshSpeaking(client);
  }

  function handleTxRelease(client, { requestId }) {
    if (!client.session) return;
    client.session.transmissions.release(client.id, requestId);
    refreshSpeaking(client);
  }

  /* ---------- Sessions ---------- */

  /**
   * Le client peut-il utiliser ce pseudo ? S'il est réservé par un autre joueur, name_error part
   * et la fonction retourne false ; la connexion reste ouverte pour essayer un autre pseudo.
   */
  function checkNickname(client, request, nickname) {
    if (!client.identityToken) {
      throw new SessionError(ERROR_CODES.IDENTITY_REQUIRED, 'Mettez à jour TACNET : ce serveur protège les pseudos et demande une version plus récente de l\'application.');
    }
    if (nicknames.isReservedByOther(nickname, client.identityToken)) {
      logger.warn(`[!] pseudo « ${nickname} » refusé pour ${label(client)} : réservé par un autre joueur`);
      send(client, nameError(nickname, request));
      return false;
    }
    if (!nicknames.hasRoomFor(nickname)) {
      throw new SessionError(ERROR_CODES.SERVER_FULL, 'Le serveur a atteint son nombre maximal de pseudos enregistrés.');
    }
    return true;
  }

  function enterSession(client, session, nickname) {
    session.addMember(client.id, nickname, client.identityToken);
    // Réservé à sa première utilisation réussie, jamais sur une tentative (mauvais code, session pleine…)
    if (nicknames.claim(nickname, client.identityToken)) logger.info(`[+] pseudo « ${nickname} » réservé`);
    client.session = session;
    client.nickname = nickname;
    client.lastState = null;
    client.lastRouting = null;
    publish(session);
  }

  /** Retire le client de sa session ; `reason` lui est envoyée ('left', 'kicked'). */
  function exitSession(client, reason = null) {
    const { session } = client;
    if (!session) return;
    stopSpeaking(client);
    session.removeMember(client.id);
    Object.assign(client, { session: null, routing: null, lastState: null, lastRouting: null });
    if (reason) send(client, { type: MESSAGE_TYPES.SESSION_ENDED, reason, code: session.code }, { buffered: true });

    if (session.isEmpty) {
      registry.delete(session.code);
      logger.info(`[-] session ${session.code} fermée (plus aucun membre)`);
    } else {
      publish(session);
    }
  }

  /**
   * Nouvelle session, ou relance d'une session sous son code. Déjà en cours (son gérant était parti) :
   * il y retrouve sa place, canaux et règles intacts. Code en cours chez un autre gérant, réservé par
   * lui (fichier de session reçu d'un autre) ou remplacé (Régénérer) : la session reçoit un nouveau code.
   *
   * Session gardée de ce gérant : « Reprendre » (resume) la retrouve telle qu'elle était ; une sauvegarde
   * nommée en remplace le nom, les réglages, les canaux et les règles, les rôles et le verrou restent.
   */
  function handleCreateSession(client, { nickname, template, code, resume }) {
    if (!checkNickname(client, MESSAGE_TYPES.CREATE_SESSION, nickname)) return;

    const running = code ? registry.get(code) : null;
    if (running?.isManagerIdentity(client.identityToken)) {
      if (client.session === running) return;
      exitSession(client, 'left');
      enterSession(client, running, nickname);
      logger.info(`[+] ${label(client)} reprend sa session ${running.code}`);
      return;
    }

    const codeAvailable = code && !running && !codes.isRetired(code) && !codes.isReservedByOther(code, client.identityToken);
    const saved = codeAvailable ? sessions.ownedBy(code, client.identityToken) : null;
    const session = saved ? registry.restore(code, saved) : registry.create(codeAvailable ? code : null);
    if (template && !(saved && resume)) {
      try {
        if (saved) session.replaceArchitecture(template);
        else session.applyTemplate(template);
      } catch (err) {
        // Modèle refusé : la session n'est pas créée et le client reste où il était
        registry.delete(session.code);
        throw err;
      }
    }
    exitSession(client, 'left');
    enterSession(client, session, nickname);
    codes.claim(session.code, client.identityToken);
    const origin = template ? ` à partir d'un modèle (${session.channels.size} canaux)` : '';
    logger.info(`[+] session ${session.code} créée par ${label(client)}${origin}`);
  }

  function handleJoinSession(client, { code, nickname }) {
    if (authGuard.isBanned(client.ip)) {
      throw new SessionError(ERROR_CODES.TOO_MANY_ATTEMPTS, 'Trop de codes erronés : réessayez dans une minute.');
    }
    if (!checkNickname(client, MESSAGE_TYPES.JOIN_SESSION, nickname)) return;
    let session = registry.get(code);
    let reopened = false;
    if (!session) {
      // Un code connu n'est pas un essai au hasard : un joueur peut réessayer en attendant la relance
      if (codes.isRetired(code)) throw new SessionError(ERROR_CODES.SESSION_INVALID, 'Cette session n\'est plus valide.');
      const saved = sessions.get(code);
      if (saved) {
        session = registry.restore(code, saved);
        reopened = true;
      } else if (codes.isReserved(code)) {
        throw new SessionError(ERROR_CODES.SESSION_NOT_OPEN, 'Cette session n\'est pas ouverte pour le moment : son gérant doit la relancer.');
      } else {
        // Un code se devine par essais successifs : les échecs comptent pour le blocage d'IP
        authGuard.recordFailure(client.ip);
        throw new SessionError(ERROR_CODES.SESSION_NOT_FOUND, `Aucune session avec le code ${code}.`);
      }
    }
    if (client.session === session) return;
    try {
      exitSession(client, 'left');
      enterSession(client, session, nickname);
    } catch (err) {
      // Personne n'a pu y entrer (verrouillée, gérant absent…) : elle reste simplement gardée
      if (reopened) registry.delete(code);
      throw err;
    }
    logger.info(`[+] ${label(client)} rejoint la session ${code}${reopened ? ' (rouverte)' : ''}`);
  }

  /** Actions réservées au gérant (MANAGER_TYPES), ou à ceux dont le rôle a l'option voulue (COMMAND_PERMISSIONS). */
  function handleManagerCommand(client, message) {
    const { session } = client;
    if (MANAGER_TYPES.has(message.type) && !session.isManager(client.id)) {
      throw new SessionError(ERROR_CODES.NOT_MANAGER, 'Action réservée au gérant de la session.');
    }
    const permission = COMMAND_PERMISSIONS.get(message.type);
    if (permission && !session.can(client.id, permission)) {
      throw new SessionError(ERROR_CODES.NOT_MANAGER, 'Votre rôle ne vous permet pas de faire cela.');
    }

    switch (message.type) {
      case MESSAGE_TYPES.CREATE_CHANNEL: session.createChannel(message.name); break;
      case MESSAGE_TYPES.RENAME_CHANNEL: session.renameChannel(message.channelId, message.name); break;
      case MESSAGE_TYPES.DELETE_CHANNEL: session.deleteChannel(message.channelId); break;
      case MESSAGE_TYPES.MOVE_MEMBER: session.moveMember(message.memberId, message.channelId); break;
      case MESSAGE_TYPES.SET_HEARING: session.setHearing(message.channelId, message.sourceId, message.enabled); break;
      case MESSAGE_TYPES.SET_BROADCAST: session.setBroadcast(message.channelId, message.enabled); break;
      case MESSAGE_TYPES.SET_MANAGER:
        session.setManager(message.memberId);
        // Le code suit la session : il appartient désormais au nouveau gérant
        codes.claim(session.code, session.members.get(message.memberId).identityToken);
        break;
      case MESSAGE_TYPES.REGENERATE_CODE: {
        const previousCode = session.code;
        registry.regenerateCode(session);
        // L'ancien code reste réservé, hors d'usage : il ne servira à aucune autre session, et qui
        // l'essaie apprend que cette session n'est plus valide
        codes.retire(previousCode);
        codes.claim(session.code, client.identityToken);
        sessions.remove(previousCode);
        logger.info(`[~] session ${previousCode} : nouveau code ${session.code}`);
        break;
      }
      case MESSAGE_TYPES.SET_LOCKED: session.setLocked(message.locked); break;
      case MESSAGE_TYPES.SET_ROLE: session.setRole(message.memberId, message.role); break;
      case MESSAGE_TYPES.SAVE_ROLE: session.saveCustomRole(message); break;
      case MESSAGE_TYPES.DELETE_ROLE: session.deleteCustomRole(message.id); break;
      case MESSAGE_TYPES.SET_SESSION_SETTINGS: session.updateSettings(message); break;
      case MESSAGE_TYPES.KICK_MEMBER: {
        const target = clientsById.get(message.memberId);
        if (message.memberId === client.id || !target || target.session !== session) {
          throw new SessionError(ERROR_CODES.MEMBER_NOT_FOUND, 'Membre introuvable dans la session.');
        }
        if (session.isManager(message.memberId)) throw new SessionError(ERROR_CODES.NOT_ALLOWED, 'Le gérant ne peut pas être exclu.');
        logger.info(`[x] ${label(target)} exclu de ${session.code} par ${label(client)}`);
        exitSession(target, 'kicked');
        return;
      }
      default: return;
    }
    publish(session);
  }

  function handleRelay(client, { type, to, payload }) {
    // Seuls les pairs que la matrice de routage relie peuvent négocier une connexion
    if (!client.routing?.peerIds.has(to)) {
      logger.warn(`[!] ${type} de ${label(client)} vers ${to.slice(0, 8)} refusé (non autorisé)`);
      return;
    }
    const target = clientsById.get(to);
    if (target) send(target, { type, from: client.id, payload }, { buffered: true });
  }

  function handleMessage(client, raw) {
    // Anti-spam : messages trop gros ou trop fréquents ignorés
    if (raw.length > config.maxMessageBytes) {
      logger.warn(`[!] ${label(client)} : message de ${raw.length} octets ignoré`);
      return;
    }
    if (!client.limiter.tryConsume()) {
      client.droppedMessages += 1;
      return;
    }

    const { message, error, type: rejectedType } = parseMessage(raw.toString());
    if (error) {
      sendError(client, rejectedType, ERROR_CODES.INVALID, error);
      return;
    }

    try {
      dispatch(client, message);
    } catch (err) {
      if (!(err instanceof SessionError)) throw err;
      sendError(client, message.type, err.code, err.message);
    }
  }

  function dispatch(client, message) {
    switch (message.type) {
      case MESSAGE_TYPES.PING: send(client, { type: MESSAGE_TYPES.PONG }); return;
      case MESSAGE_TYPES.AUTH: return; // déjà authentifié
      case MESSAGE_TYPES.CREATE_SESSION: handleCreateSession(client, message); return;
      case MESSAGE_TYPES.JOIN_SESSION: handleJoinSession(client, message); return;
      // Peuvent croiser la fin d'une session (exclu, par exemple) : jamais d'erreur à afficher
      case MESSAGE_TYPES.TX_REQUEST: handleTxRequest(client, message); return;
      case MESSAGE_TYPES.TX_RELEASE: handleTxRelease(client, message); return;
      default:
    }

    if (!client.session) {
      // Négociation audio qui croise un départ : elle n'a plus d'objet, rien à signaler au joueur
      if (RELAYED_TYPES.has(message.type)) return;
      throw new SessionError(ERROR_CODES.NOT_IN_SESSION, "Vous n'êtes dans aucune session.");
    }
    if (message.type === MESSAGE_TYPES.LEAVE_SESSION) {
      logger.info(`[-] ${label(client)} quitte la session ${client.session.code}`);
      exitSession(client, 'left');
    } else if (message.type === MESSAGE_TYPES.JOIN_CHANNEL) {
      // Chacun rejoint un canal existant (ou quitte le vocal) sans le gérant, sauf s'il l'a interdit
      if (!client.session.canMoveSelf(client.id)) {
        const hidden = client.session.isChannelBound(client.id);
        throw new SessionError(ERROR_CODES.NOT_ALLOWED, `Vous ne pouvez pas changer de canal vous-même : ${hidden ? 'les canaux sont masqués, ' : ''}le gérant vous place.`);
      }
      client.session.moveMember(client.id, message.channelId);
      publish(client.session);
    } else if (MANAGER_TYPES.has(message.type) || COMMAND_PERMISSIONS.has(message.type)) {
      handleManagerCommand(client, message);
    } else if (RELAYED_TYPES.has(message.type)) {
      handleRelay(client, message);
    }
  }

  /* ---------- Connexions ---------- */

  /** « ready » : l'application y lit la version du serveur, pour prévenir si l'un des deux est en retard sur l'autre. */
  function readyMessage(client, resumed) {
    return { type: MESSAGE_TYPES.READY, clientId: client.id, resumeToken: client.token, resumed, serverVersion: VERSION, minClientVersion: MIN_CLIENT_VERSION };
  }

  function createClient(socket, ip, identityToken, version = null) {
    const client = {
      id: randomUUID(),
      token: randomBytes(24).toString('base64url'),
      identityToken,
      // Version de l'application (null : application ancienne, qui ne l'annonce pas)
      version,
      ip,
      socket,
      nickname: null,
      session: null,
      routing: null,
      lastState: null,
      lastRouting: null,
      graceTimer: null,
      pending: [],
      speaking: new Map(), // cible -> identifiants prévenus
      limiter: new RateLimiter(config.messagesPerSecond),
      droppedMessages: 0,
    };
    clientsByToken.set(client.token, client);
    clientsById.set(client.id, client);
    return client;
  }

  function endClient(client) {
    clearTimeout(client.graceTimer);
    client.graceTimer = null;
    if (client.session) logger.info(`[-] ${label(client)} parti de la session ${client.session.code}`);
    exitSession(client);
    clientsByToken.delete(client.token);
    clientsById.delete(client.id);
  }

  /** Reprise après coupure : même identifiant, même session, même canal, sans annonce de départ. */
  function resumeClient(client, socket) {
    clearTimeout(client.graceTimer);
    client.graceTimer = null;
    client.socket?.terminate();
    client.socket = socket;
    client.lastState = null;
    client.lastRouting = null;
    send(client, readyMessage(client, true));
    for (const message of client.pending.splice(0)) sendRaw(client, message);
    if (client.session) {
      client.session.setConnected(client.id, true);
      publish(client.session);
    }
    logger.info(`[~] ${label(client)} reprend sa connexion`);
  }

  /**
   * Refus explicite de la connexion : le message part, puis le socket est détruit de force.
   * Le client sait ainsi qu'il doit cesser de se reconnecter (et corriger son mot de passe ou son pseudo).
   */
  function rejectConnection(socket, message) {
    // Détruit au plus tard après ce délai, même si l'envoi n'aboutit pas (client lent ou malveillant)
    const fallback = setTimeout(() => socket.terminate(), config.authErrorFlushMs);
    socket.once('close', () => clearTimeout(fallback));
    // Trame invalide d'un client refusé : sans écouteur, l'erreur ferait tomber le serveur
    socket.on('error', () => socket.terminate());
    // Fermeture normale : couper net effacerait ce message chez le client si sa demande est encore en route
    socket.send(JSON.stringify(message), () => socket.close(REJECTED_CLOSE_CODE));
  }

  function rejectAuth(socket, code, message) {
    rejectConnection(socket, { type: MESSAGE_TYPES.AUTH_ERROR, code, message });
  }

  /**
   * Premier message : mot de passe du serveur (et jeton pour reprendre une connexion coupée), jeton
   * d'identité et pseudo. Résout avec le client, ou null (le socket est alors détruit, après un
   * message auth_error ou name_error). Le pseudo n'est pas réservé ici, seulement vérifié : le client
   * se reconnecte pendant la saisie d'un nouveau pseudo, chaque essai ne doit pas le réserver.
   */
  async function authenticate(socket, ip, raw) {
    const { message } = raw.length <= config.maxMessageBytes ? parseMessage(raw.toString()) : {};
    const valid = message?.type === MESSAGE_TYPES.AUTH && await verifyPassword(message.password, passwordHash);
    // Le client a pu se déconnecter pendant la vérification
    if (socket.readyState !== WebSocket.OPEN) return null;
    if (!valid) {
      authGuard.recordFailure(ip);
      rejectAuth(socket, ERROR_CODES.INVALID_PASSWORD, 'Mot de passe invalide');
      return null;
    }
    authGuard.recordSuccess(ip);

    const previous = message.resumeToken && clientsByToken.get(message.resumeToken);
    if (previous) {
      resumeClient(previous, socket);
      return previous;
    }

    if (message.nickname && nicknames.isReservedByOther(message.nickname, message.identityToken)) {
      logger.warn(`[!] connexion refusée (${ip}) : pseudo « ${message.nickname} » réservé par un autre joueur`);
      rejectConnection(socket, nameError(message.nickname));
      return null;
    }

    const client = createClient(socket, ip, message.identityToken, message.clientVersion);
    send(client, readyMessage(client, false));
    return client;
  }

  /** La dernière adresse de X-Forwarded-For est celle qu'a vue le proxy ; les précédentes viennent du client, qui peut les inventer. */
  function clientAddress(request) {
    const forwarded = trustProxy ? request.headers['x-forwarded-for']?.split(',').at(-1)?.trim() : null;
    return forwarded || request.socket.remoteAddress;
  }

  wss.on('connection', (socket, request) => {
    const ip = clientAddress(request);
    if (authGuard.isBanned(ip)) {
      // Le mot de passe n'est même pas vérifié : le client ne doit pas l'effacer pour autant
      rejectAuth(socket, ERROR_CODES.TOO_MANY_ATTEMPTS, 'Trop de tentatives erronées : réessayez dans une minute.');
      return;
    }

    let client = null;
    let authStarted = false;
    socket.isAlive = true;
    const authTimer = setTimeout(() => socket.terminate(), config.authTimeoutMs);

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', async (raw) => {
      if (client) {
        handleMessage(client, raw);
        return;
      }
      // Messages reçus pendant la vérification du mot de passe : ignorés
      if (authStarted) return;
      authStarted = true;
      clearTimeout(authTimer);
      client = await authenticate(socket, ip, raw);
    });

    socket.on('close', (code) => {
      clearTimeout(authTimer);
      // Le client peut avoir été repris entre-temps par une nouvelle connexion
      if (!client || client.socket !== socket) return;
      client.socket = null;
      if (code === NORMAL_CLOSURE) {
        // Départ volontaire : la place est libérée tout de suite
        endClient(client);
        return;
      }
      client.graceTimer = setTimeout(() => endClient(client), config.resumeGraceMs);
      // La cible se libère pour les autres ; le client redemandera la parole à sa reprise
      stopSpeaking(client);
      if (client.session) {
        client.session.setConnected(client.id, false);
        publish(client.session);
      }
    });

    socket.on('error', (err) => logger.warn(`[!] ${client ? label(client) : ip} : ${err.message}`));
  });

  // Coupe les connexions mortes (client planté, réseau perdu) : le client passe en attente de reprise
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
    for (const client of clientsById.values()) {
      if (client.droppedMessages > 0) {
        logger.warn(`[!] ${label(client)} : ${client.droppedMessages} message(s) ignoré(s) (plus de ${config.messagesPerSecond}/s)`);
        client.droppedMessages = 0;
      }
    }
    authGuard.prune();
  }, config.heartbeatIntervalMs);

  wss.on('close', () => clearInterval(heartbeat));
  server?.on('close', () => clearInterval(heartbeat));

  return {
    wss,
    get sessionCount() {
      return registry.size;
    },
    close: () => new Promise((resolve) => {
      sessions.flush();
      for (const client of clientsById.values()) clearTimeout(client.graceTimer);
      for (const socket of wss.clients) socket.terminate();
      wss.close(() => (server ? server.close(() => resolve()) : resolve()));
    }),
  };
}

module.exports = { createSignalingServer, LIMITS };
