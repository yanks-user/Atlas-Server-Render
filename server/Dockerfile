# Serveur de sessions TACNET. Démarrage : voir README.html
# Toute la configuration passe par des variables d'environnement (SERVER_PASSWORD, PORT, TLS, TRUST_PROXY…) : avec docker compose,
# par config.env ; sur Render, par render.yaml (à la racine du projet), sans aucun fichier à fournir. Contexte de construction : ce dossier.
FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json ./
# npm et yarn ne servent plus une fois les dépendances installées : l'image y gagne en taille et en surface d'attaque
RUN npm ci --omit=dev --no-audit --no-fund \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm
COPY src ./src
COPY scripts ./scripts

# Tout ce que le serveur écrit va dans /data : configuration, certificat, pseudos, codes et sessions gardées
RUN mkdir /data && chown node:node /data
ENV SERVER_CONFIG=/data/server-config.json
VOLUME /data

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "scripts/healthcheck.js"]
CMD ["node", "src/index.js"]
