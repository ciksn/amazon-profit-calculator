FROM node:22-alpine

ENV NODE_ENV=production PORT=4173
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node config ./config
COPY --chown=node:node docs/data ./docs/data

USER node
EXPOSE 4173
CMD ["node", "server.js"]
