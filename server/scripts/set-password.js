// Change le mot de passe du serveur : seule son empreinte est écrite dans server-config.json.
//   npm run set-password -- "mon mot de passe"   (mot de passe choisi)
//   npm run set-password                         (mot de passe aléatoire, affiché une fois)
// Même config.env que le serveur : SERVER_CONFIG y désigne le même fichier de config.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config.env'), quiet: true });

const { setPassword } = require('../src/config');
const { generatePassword } = require('../src/password');

async function main() {
  const chosen = process.argv[2];
  const password = chosen ?? generatePassword();

  try {
    await setPassword(password);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log(chosen ? 'Mot de passe enregistré.' : `Nouveau mot de passe (notez-le, il ne sera plus affiché) : ${password}`);
  if (process.env.SERVER_PASSWORD !== undefined) {
    console.warn('Attention : SERVER_PASSWORD est défini (config.env ou environnement) et reste prioritaire.');
    console.warn(`Ce nouveau mot de passe ne servira qu'après avoir retiré SERVER_PASSWORD.`);
  }
  console.log(`Redémarrez le serveur : chaque application refusera l'ancien et demandera le nouveau.`);
}

main();
