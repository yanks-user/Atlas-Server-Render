// Gère les pseudos réservés (users.json) : un pseudo appartient au PC qui l'a utilisé le premier.
// Un joueur qui change de PC (ou réinstalle TACNET) ne peut plus utiliser son pseudo : on le libère ici,
// et il le réserve de nouveau, proprement, à sa prochaine connexion.
//
//   node scripts/users.js list [filtre]            liste les pseudos réservés (filtre : une partie du pseudo)
//   node scripts/users.js remove "<pseudo>" ...    libère un ou plusieurs pseudos (aussi : reset, delete)
//
// Avec npm :     npm run users -- list
// Avec Docker :  docker compose exec tacnet node scripts/users.js list
//
// Le serveur n'a pas besoin d'être arrêté : il relit users.json dès qu'il change.
// Même config.env que le serveur : SERVER_CONFIG y désigne le dossier de users.json.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config.env'), quiet: true });

const { USERS_PATH } = require('../src/config');
const { NicknameRegistry, nicknameKey } = require('../src/nickname-registry');

const USAGE = `Pseudos réservés (users.json)

  node scripts/users.js list [filtre]            liste les pseudos réservés
  node scripts/users.js remove "<pseudo>" ...    libère des pseudos : leurs joueurs peuvent les réserver de nouveau
                                                 (reset et delete font la même chose)

Fichier : ${USERS_PATH}
Le serveur n'a pas besoin d'être arrêté : il relit le fichier dès qu'il change.`;

const quietLogger = { info: () => {}, warn: (message) => console.warn(message) };

const shortDate = (iso) => String(iso).slice(0, 16).replace('T', ' ');
const shortHash = (hash) => hash.slice(0, 12);

function list(registry, filter) {
  const needle = filter ? nicknameKey(filter) : null;
  const users = registry.list().filter((user) => !needle || user.key.includes(needle));

  console.log(`Pseudos réservés : ${users.length}${needle ? ` (sur ${registry.size}, filtre « ${filter} »)` : ''}`);
  console.log(`Fichier : ${USERS_PATH}`);
  if (users.length === 0) return 0;

  const width = Math.max('Pseudo'.length, ...users.map((user) => user.nickname.length));
  console.log('');
  console.log(`  ${'Pseudo'.padEnd(width)}  ${'Réservé le (UTC)'.padEnd(16)}  Empreinte du PC`);
  for (const user of users) {
    console.log(`  ${user.nickname.padEnd(width)}  ${shortDate(user.registeredAt).padEnd(16)}  ${shortHash(user.tokenHash)}`);
  }
  return 0;
}

function remove(registry, nicknames) {
  if (nicknames.length === 0) {
    console.error('Indiquez le pseudo à libérer, entre guillemets s\'il contient des espaces : remove "Léa"');
    return 1;
  }
  let failures = 0;
  for (const nickname of nicknames) {
    const removed = registry.remove(nickname);
    if (removed) {
      console.log(`Libéré : « ${removed.nickname} » (réservé le ${shortDate(removed.registeredAt)} UTC). Le prochain joueur qui l'utilise le réserve.`);
    } else {
      console.error(`Introuvable : « ${nickname} » (voir « list »).`);
      failures += 1;
    }
  }
  return failures === 0 ? 0 : 1;
}

function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) {
    console.log(USAGE);
    return 0;
  }

  const registry = new NicknameRegistry({ filePath: USERS_PATH, logger: quietLogger });
  try {
    registry.load();
    switch (command) {
      case 'list': return list(registry, args.join(' ').trim());
      case 'remove':
      case 'reset':
      case 'delete': return remove(registry, args);
      default:
        console.error(`Commande inconnue : ${command}\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

process.exitCode = main();
