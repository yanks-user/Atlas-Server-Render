// En premier : config.js lit process.env dès son chargement. Les variables déjà définies
// dans l'environnement restent prioritaires sur celles de config.env.
const path = require('path');
const env = require('dotenv').config({ path: path.join(__dirname, '..', 'config.env'), quiet: true });

const http = require('http');
const https = require('https');
const { loadServerConfig } = require('./config');
const { createSignalingServer } = require('./signaling-server');
const { NicknameRegistry } = require('./nickname-registry');
const { CodeRegistry } = require('./code-registry');
const { SessionStore } = require('./session-store');
const { VERSION } = require('./version');
const { startUpdateCheck } = require('./update-check');

const logger = {
  info: (message) => console.log(`${new Date().toISOString()} ${message}`),
  warn: (message) => console.warn(`${new Date().toISOString()} ${message}`),
};

// Toute requête HTTP ordinaire est refusée : seul le WebSocket est servi
function rejectPlainRequest(_request, response) {
  response.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('WebSocket uniquement.\n');
}

async function main() {
  // Fichier absent : normal, le mot de passe vient alors de server-config.json
  if (env.error && env.error.code !== 'ENOENT') logger.warn(`config.env ignoré : ${env.error.message}`);

  let config;
  let nicknames;
  let codes;
  let sessions;
  try {
    config = await loadServerConfig();
    nicknames = new NicknameRegistry({ filePath: config.usersPath, logger });
    nicknames.load();
    codes = new CodeRegistry({ filePath: config.sessionCodesPath, logger });
    codes.load();
    sessions = new SessionStore({ filePath: config.sessionsPath, logger });
    sessions.load();
  } catch (err) {
    logger.warn(`Configuration invalide : ${err.message}`);
    process.exit(1);
  }

  logger.info(`Serveur TACNET version ${VERSION}`);
  for (const notice of config.notices) logger.info(notice);
  logger.info(`Pseudos réservés : ${nicknames.size} (${config.usersPath})`);
  logger.info(`Codes de session réservés : ${codes.size} (${config.sessionCodesPath})`);
  logger.info(`Sessions gardées : ${sessions.size} (${config.sessionsPath})`);

  const httpServer = config.tls
    ? https.createServer({ cert: config.tls.cert, key: config.tls.key, minVersion: 'TLSv1.2' }, rejectPlainRequest)
    : http.createServer(rejectPlainRequest);

  const server = createSignalingServer({
    server: httpServer, passwordHash: config.passwordHash, logger, limits: config.limits, nicknames, codes, sessions, trustProxy: config.trustProxy,
  });

  let updateCheck = null;

  httpServer.on('error', (err) => {
    logger.warn(`Démarrage impossible : ${err.message}`);
    process.exit(1);
  });

  httpServer.listen(config.port, config.host, () => {
    const scheme = config.tls ? 'wss' : 'ws';
    logger.info(`Serveur de sessions en écoute sur ${scheme}://${config.host}:${config.port}`);
    if (config.tls) {
      logger.info(`Empreinte du certificat (à saisir dans Paramètres) : ${config.tls.fingerprint}`);
    } else {
      logger.warn('TLS désactivé : le mot de passe circule en clair. À réserver à un réseau de confiance ou à un reverse proxy qui chiffre.');
    }
    if (config.trustProxy) logger.info('Adresse des clients lue dans X-Forwarded-For (TRUST_PROXY=true) : ce port ne doit être joignable que par le reverse proxy.');
    // Après le démarrage : un réseau lent ne retarde jamais l'ouverture du serveur
    updateCheck = startUpdateCheck({ logger });
  });

  async function shutdown() {
    logger.info('Arrêt du serveur…');
    updateCheck?.stop();
    await server.close();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
