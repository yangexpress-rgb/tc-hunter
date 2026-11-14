# TC Hunter: one image for the web app, the background worker and the one-shot migration job.
# Built and run by deploy/compose.yaml (accepted proposal P6).

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
RUN npm run build -w apps/web

# Migration job: runs as the database owner, then exits.
FROM deps AS migrate
COPY packages packages
COPY tsconfig.base.json ./
USER node
CMD ["npx", "tsx", "packages/db/src/migrate.ts"]

# Background worker: scans and pasted links (design 7). Runs the TypeScript directly, like migrate.
FROM deps AS worker
COPY packages packages
COPY apps/worker apps/worker
COPY tsconfig.base.json ./
ENV NODE_ENV=production
USER node
CMD ["npx", "tsx", "apps/worker/src/main.ts"]

# Web app: Next.js standalone server, non-root, read-only friendly.
FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
