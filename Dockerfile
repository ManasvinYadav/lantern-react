# Builds the whole monorepo (server + client) into one deployable image,
# matching the original Go binary's "single self-hosted artifact" model —
# this container serves the API, WebSocket, and the built React UI.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 falls back to compiling from source when no prebuilt binary
# matches the image's platform; these make that fallback work instead of
# failing the build.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci
COPY . .
RUN npm run build -w server
RUN npm run build -w client

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/client/dist ./client-dist

ENV LANTERN_PORT=7654
ENV LANTERN_DB_PATH=/data/lantern.db
ENV LANTERN_STATIC_DIR=/app/client-dist

EXPOSE 7654
VOLUME ["/data"]

CMD ["node", "server/dist/index.js"]
