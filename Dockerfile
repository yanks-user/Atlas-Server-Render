# Dockerfile à la racine du dépôt : Render, et tout hébergeur qui construit depuis la racine, le trouve sans aucun réglage.
# C'est la même image que server/Dockerfile (utilisé par docker compose, dont le contexte de construction est server/) ;
# seuls les chemins de COPY changent. Modifiez les deux ensemble.
# Sur Render, seule la variable SERVER_PASSWORD est à fournir : TLS=off et TRUST_PROXY=true se règlent tout seuls (server/src/config.js).
FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app
COPY server/package.json server/package-lock.json ./
# npm et yarn ne servent plus une fois les dépendances installées : l'image y gagne en taille et en surface d'attaque
RUN npm ci --omit=dev --no-audit --no-fund \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm
COPY server/src ./src
COPY server/scripts ./scripts

# Tout ce que le serveur écrit va dans /data : configuration, certificat, pseudos, codes et sessions gardées
RUN mkdir /data && chown node:node /data
ENV SERVER_CONFIG=/data/server-config.json

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "scripts/healthcheck.js"]
CMD ["node", "src/index.js"]
