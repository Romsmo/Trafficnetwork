# syntax=docker/dockerfile:1

# --- deps: full install (incl. devDependencies, needed for the build stage) ---
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- build: compile TypeScript, copy non-.ts build assets (migrations) ---
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

# --- prod-deps: production-only node_modules, kept separate from the build
#     stage's devDependencies so the final image doesn't carry them ---
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime: minimal final image ---
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S trafficnetwork && adduser -S trafficnetwork -G trafficnetwork
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Pre-built static-data packages (add-on E-B, docs/europe-scale.md) live on a volume: they are
# derived data, but rebuilding a Europe-sized set takes long, so they should survive a redeploy.
# Created here (owned by the runtime user) so a fresh named volume inherits the ownership.
RUN mkdir -p /app/data/static-packages && chown -R trafficnetwork:trafficnetwork /app/data
ENV STATIC_PACKAGES_DIR=/app/data/static-packages
VOLUME ["/app/data/static-packages"]

USER trafficnetwork
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run before the server starts so a fresh deployment (or one that
# picked up new migrations) never serves traffic against a stale schema —
# same ordering docker-compose.yml and the non-Docker install docs use.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
