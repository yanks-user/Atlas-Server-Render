// Serveur Atlas : contrôle de santé du conteneur : le serveur accepte-t-il les connexions sur son port ?
const net = require('net');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config.env'), quiet: true });

const TIMEOUT_MS = 3000;

const socket = net.connect(Number.parseInt(process.env.PORT ?? '8080', 10), '127.0.0.1');
socket.setTimeout(TIMEOUT_MS, () => process.exit(1));
socket.on('connect', () => process.exit(0));
socket.on('error', () => process.exit(1));
