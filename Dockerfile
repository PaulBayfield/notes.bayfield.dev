# Notes: the web app and its server (Outline's API, collaboration, realtime, files) in one image.
#   docker build -t notes . && docker run -p 3000:3000 --env-file server/.env notes
#
# The first stage builds the web app (served at the root) and the editor bundle the server shares with it;
# the second runs the server, which serves both.

FROM node:24-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY src ./src
COPY public ./public
COPY server/editor ./server/editor
RUN npm run build && npm run build:editor

FROM node:24-alpine
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY --from=web /app/server/src/editor.bundle.mjs ./src/editor.bundle.mjs
COPY --from=web /app/dist /app/dist
ARG APP_VERSION=dev
ENV NODE_ENV=production PORT=3000 DIST_DIR=/app/dist FILE_STORAGE_DIR=/var/lib/notes/data APP_VERSION=$APP_VERSION
RUN mkdir -p /var/lib/notes/data && chown node:node /var/lib/notes/data
VOLUME /var/lib/notes/data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "src/index.ts"]
