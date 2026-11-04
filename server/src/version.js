const { version: VERSION } = require('../package.json');

// Application la plus ancienne que ce serveur accepte sans avertissement. À relever quand une nouvelle
// version du protocole (src/protocol.js) ne marche plus avec les anciennes applications.
const MIN_CLIENT_VERSION = '1.0.0';

const VERSION_PATTERN = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/;

/** « 1.2.3 » ou « v1.2.3 » -> [1, 2, 3], ou null si ce n'est pas une version. Un suffixe (-beta…) est ignoré. */
function parseVersion(text) {
  const match = VERSION_PATTERN.exec(String(text ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** -1, 0 ou 1 (a est plus ancienne, égale ou plus récente que b) ; null si l'une des deux est illisible. */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

module.exports = { VERSION, MIN_CLIENT_VERSION, parseVersion, compareVersions };
