const fs = require('fs');
const path = require('path');
const { X509Certificate } = require('crypto');
const selfsigned = require('selfsigned');

const CERT_VALIDITY_YEARS = 5;

/**
 * Charge le certificat TLS ; s'il n'existe pas, génère un certificat auto-signé.
 * Un certificat officiel (Let's Encrypt…) peut être utilisé en indiquant ses fichiers.
 *
 * Retourne { cert, key, fingerprint, generated } — l'empreinte SHA-256 est celle
 * que les clients « épinglent » pour n'accepter que ce certificat.
 */
async function loadOrCreateCertificate({ certFile, keyFile }) {
  let generated = false;

  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    const notAfterDate = new Date();
    notAfterDate.setFullYear(notAfterDate.getFullYear() + CERT_VALIDITY_YEARS);
    const pems = await selfsigned.generate(
      [{ name: 'commonName', value: 'TACNET' }],
      { keySize: 2048, algorithm: 'sha256', notAfterDate },
    );

    fs.mkdirSync(path.dirname(certFile), { recursive: true });
    fs.writeFileSync(certFile, pems.cert, 'utf8');
    // Clé privée : lisible uniquement par le compte qui lance le serveur (là où le système le permet)
    fs.writeFileSync(keyFile, pems.private, { encoding: 'utf8', mode: 0o600 });
    generated = true;
  }

  const cert = fs.readFileSync(certFile, 'utf8');
  const key = fs.readFileSync(keyFile, 'utf8');
  const fingerprint = new X509Certificate(cert).fingerprint256;
  return { cert, key, fingerprint, generated };
}

module.exports = { loadOrCreateCertificate };
