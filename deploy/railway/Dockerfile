# TC Hunter on Railway: one container runs the web app, the background worker,
# the two outbound gates and the nightly backup. One service plus Railway's
# Postgres keeps the bill small (Railway charges for what runs, per service).
# Built by Railway from railway.json at the repo root.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w apps/web \
 && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static

FROM node:22-bookworm-slim AS app
# Backup tools: pg_dump from the PostgreSQL project (must be at least Railway's Postgres version), age, rclone.
ARG PG_MAJOR=18
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg age rclone bash tzdata \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-${PG_MAJOR} \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
# Worker and migrations run from TypeScript (as in the Compose setup), so they need the packages and node_modules.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/worker ./apps/worker
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./web
COPY --from=build --chown=node:node /app/package.json /app/tsconfig.base.json ./
COPY --chown=node:node deploy/egress-proxy ./deploy/egress-proxy
COPY --chown=node:node deploy/railway/start.mjs ./deploy/railway/start.mjs
COPY deploy/backup/backup.sh deploy/backup/restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh \
 && mkdir -p /data && chown node:node /data
# Railway mounts the volume at /data (vault in /data/vault). Volumes mount as root, so the
# start script fixes ownership, then runs everything as the unprivileged "node" user.
CMD ["node", "deploy/railway/start.mjs"]
