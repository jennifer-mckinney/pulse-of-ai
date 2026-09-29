# syntax=docker/dockerfile:1
#
# Pulse of AI — Node 22 application image.
#
# ONE image serves every Node role; the compose service picks the role by
# command (see docker-compose.yml, profile "full"):
#   web        node src/server.js                         (default CMD)
#   worker     node src/workers/start.js                  (BullMQ ingest/embed/correlate)
#   migrate    node scripts/migrate.js && node scripts/seed.js   (one-shot)
#   demo-feed  node scripts/demo-feed.js --loop           (demo population only)
#
# Build:  docker build -t pulse-of-ai/app:local .
#
# The base image is pinned to an exact Node release so a rebuild months from
# now produces the same runtime; bump NODE_IMAGE deliberately.

ARG NODE_IMAGE=node:22.23.3-bookworm-slim

# ─── Stage 1: production dependencies only ───────────────────────────────────
# `npm ci --omit=dev` installs exactly what package-lock.json pins, minus jest /
# playwright / supertest. --ignore-scripts: no dependency here needs an install
# script, and skipping them keeps third-party code from running at build time.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Application files stay root-owned and read-only to the runtime user: the
# process can read its code but never rewrite it.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public

# Non-root runtime user (uid 1000 'node' ships with the official image).
USER node

EXPOSE 3000

# Healthy = the API answers AND reports a live database connection.
# /api/health returns 200 even when the DB is down (status "degraded"), so the
# check reads db_connected instead of trusting the status code alone. Node 22
# has a global fetch, so no curl/wget is needed in the image.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.ok?r.json():Promise.reject(r.status)).then(b=>process.exit(b.db_connected===true?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "src/server.js"]
