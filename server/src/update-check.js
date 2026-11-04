const { VERSION, parseVersion, compareVersions } = require('./version');

// Dernière version publiée de TACNET (application et serveur sont publiés ensemble)
const DEFAULT_API = 'https://api.github.com/repos/yanks-user/TACNET/releases/latest';
const DEFAULT_PAGE = 'https://github.com/yanks-user/TACNET/releases/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

/** La dernière version publiée : { version, url }. Lève une erreur si GitHub ne répond pas ou répond autre chose. */
async function fetchLatestRelease({ api = DEFAULT_API, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(api, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `tacnet-server/${VERSION}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`réponse ${response.status}`);
  const release = await response.json();
  if (!parseVersion(release?.tag_name)) throw new Error('version illisible dans la réponse');
  return {
    version: String(release.tag_name).replace(/^v/, ''),
    url: typeof release.html_url === 'string' ? release.html_url : DEFAULT_PAGE,
  };
}

/**
 * Au démarrage puis chaque jour : compare la version de ce serveur à la dernière publiée et l'écrit dans le journal.
 * Rien n'est jamais mis à jour tout seul : un redémarrage coupe les joueurs (et, sur Render gratuit, efface les données).
 * UPDATE_CHECK=off l'interdit ; UPDATE_API change l'adresse interrogée (essais).
 * @returns {{ run: () => Promise<void>, stop: () => void }}
 */
function startUpdateCheck({ logger, env = process.env, fetchImpl, intervalMs = CHECK_INTERVAL_MS }) {
  const setting = env.UPDATE_CHECK;
  if (setting !== undefined && setting !== '' && setting !== 'on' && setting !== 'off') {
    logger.warn(`UPDATE_CHECK doit valoir on ou off (reçu : ${setting}) : recherche de mises à jour laissée active.`);
  }
  if (setting === 'off') {
    logger.info('Recherche de mises à jour désactivée (UPDATE_CHECK=off).');
    return { run: async () => {}, stop: () => {} };
  }

  const api = env.UPDATE_API || DEFAULT_API;
  const run = async () => {
    try {
      const latest = await fetchLatestRelease({ api, fetchImpl });
      if (compareVersions(latest.version, VERSION) > 0) {
        logger.warn(`[!] Nouvelle version de TACNET : ${latest.version} (ce serveur est en ${VERSION}). Détails : ${latest.url}`);
        logger.warn('    Docker : remplacez les fichiers du serveur (sauf config.env), puis « docker compose up -d --build ». Render : Manual Deploy, « Deploy latest commit ». UPDATE_CHECK=off retire ce message.');
      } else {
        logger.info(`Version ${VERSION} : à jour (dernière version publiée : ${latest.version}).`);
      }
    } catch (err) {
      // Pas de réseau, GitHub saturé (limite d'appels par adresse) : sans gravité, le serveur fonctionne
      logger.info(`Recherche de mises à jour impossible pour le moment (${err.message}).`);
    }
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return { run, stop: () => clearInterval(timer) };
}

module.exports = { startUpdateCheck, fetchLatestRelease };
