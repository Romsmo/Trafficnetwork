# Installation

Two equally-supported paths — pick one. Both need a public HTTPS address if
you intend to federate (`FEDERATION_ENABLED=true`); for a private
single-server setup neither TLS nor a domain is required. Once you're up and
federating, see [`operating.md`](operating.md) for day-to-day operation and
[`federation-protocol.md`](federation-protocol.md) for how it all works.

## Docker (recommended)

```bash
git clone https://github.com/Romsmo/Trafficnetwork.git
cd Trafficnetwork/server
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD and JWT_SECRET at minimum
docker compose up -d
```

This starts the server and a PostGIS-enabled Postgres in one stack (see
`docker-compose.yml`). Migrations run automatically before the server starts
(baked into the image's `CMD`, see `Dockerfile`) — no separate migration step
needed, on first start or on every subsequent update.

Verify it's up: `curl http://localhost:3000/v1/health` → `{"status":"ok","database":"ok"}`.

Compose reuses an image it has already built under this name: after pulling new
code, run `docker compose up -d --build` (a fresh clone has no image, so the
first `up` builds one).

### Create the first client

Every endpoint but health and the network self-description needs a token, and
tokens come from credentials the operator mints — there is no signup. The
`npm run create-client` script in `server/` does that for a development setup;
inside the Docker stack, the same thing is a few lines run in the server
container (the image carries the compiled server, not the scripts):

```bash
docker compose exec -T server node --input-type=module - <<'EOF'
import { loadEnv } from "./dist/config/env.js";
import { createDb } from "./dist/db/client.js";
import { generateClientId, generateClientSecret, hashSecret } from "./dist/modules/auth/credentials.js";
import { insertClient } from "./dist/db/queries/clients.js";

const { db, client } = createDb(loadEnv());
const clientId = generateClientId();
const clientSecret = generateClientSecret();
await insertClient(db, {
  clientId,
  clientSecretHash: await hashSecret(clientSecret),
  scopes: ["client"], // "bulk-import" for an importer, "device-registration" for an app key
  name: "my-first-client",
});
await client.end();
console.log(JSON.stringify({ clientId, clientSecret }));
EOF
```

It prints the id and the secret once — the secret is stored only as a hash. Then
`POST /v1/auth/token` with them gives a token (`api.md`, "Auth"), and the same
pair is what the client library's examples take (`TN_CLIENT_ID`,
`TN_CLIENT_SECRET`).

**With a reverse proxy for real TLS** (needed once you have a domain
pointed at this host): copy `Caddyfile.example` to `Caddyfile`, put your real
domain in it, then:

```bash
docker compose --profile with-caddy up -d
```

Caddy provisions and renews its Let's Encrypt certificate automatically — no
separate certbot step. To update an existing node, follow
[Updating an existing node](#updating-an-existing-node-docker) below.

### Updating an existing node (Docker)

The compose file **builds the image locally** from `server/Dockerfile` (there is no `image:` entry for the
server, so nothing is pulled from GHCR; the images that `release.yml` publishes as
`ghcr.io/romsmo/trafficnetwork-server` are for people who run the image without this compose file).
Migrations run in the container's `CMD` before the server listens, so an update is "new code, rebuild, restart" —
but a migration cannot be undone by going back to old code, so **take a database dump first**. Run everything
in the directory that holds `docker-compose.yml` (`server/`). Service names: `server`, `postgres`; database
user and name default to `trafficnetwork` (`POSTGRES_USER`, `POSTGRES_DB`); the server listens on `PORT` (3000).

1. **Read what changes**: `git fetch` then `git log --oneline HEAD..origin/main` and the `CHANGELOG.md`
   sections for `server`. Note migrations among the new files (`git diff --stat HEAD origin/main -- server/src/db/migrations`);
   a heavy-lock one is listed in [`operating.md`](operating.md#migrations-that-take-a-heavy-lock).
2. **Check your `.env`** for leftovers of older versions:
   `SPEED_CAMERA_NAMESPACE_ENABLED=false` (the old default; it now switches *all* camera data off — remove the line or
   set `true`), `HAZARD_EXPIRY_SHORT_MINUTES=12` from an old `.env.example` (only affects red-light/distance reports
   since 1.1.0). `docker compose config` must run without an error: `POSTGRES_PASSWORD` and `JWT_SECRET` are
   required, everything else has a default. Never change `STATIC_DATA_PARTITION_H3_RESOLUTION` on a node with users.
3. **Back up**: `pg_dump` inside the container, then copy the file out (`>` redirection is not binary-safe in
   Windows PowerShell, so the dump is not piped through the host shell):
   ```bash
   docker compose exec -T postgres pg_dump -U trafficnetwork -d trafficnetwork -Fc -f /tmp/before-update.dump
   docker compose cp postgres:/tmp/before-update.dump ./before-update.dump
   git rev-parse HEAD            # write this commit down: it is what you roll back to
   ```
4. **Update**: `git pull --ff-only` and `docker compose up -d --build`. Watch `docker compose logs -f server` for
   `Migrations complete.`; a big migration keeps the container `starting`/`unhealthy` until it is done — do not interrupt it.
5. **Check**: `curl http://localhost:3000/v1/health` → `{"status":"ok","database":"ok"}` (no token needed). With a
   token (`POST /v1/auth/token`), `GET /v1/config` answers 200 and shows `cameraPolicy`, `reportExpiry` and
   `staticDataPartitionH3Resolution`; it needs a token, unlike `/v1/health`.
6. **Roll back**: if only code is wrong and no migration ran, `git checkout <old commit>` and
   `docker compose up -d --build`. If migrations ran, restore the dump into an empty database first (this deletes
   everything written since the dump):
   ```bash
   docker compose stop server
   docker compose cp ./before-update.dump postgres:/tmp/restore.dump
   docker compose exec -T postgres psql -U trafficnetwork -d postgres -c "DROP DATABASE trafficnetwork WITH (FORCE)" -c "CREATE DATABASE trafficnetwork TEMPLATE template0"
   docker compose exec -T postgres pg_restore -U trafficnetwork -d trafficnetwork --no-owner /tmp/restore.dump
   git checkout <old commit>
   docker compose up -d --build
   ```
   The `static-packages` volume is derived data and is rebuilt by the server if it no longer matches.

**Multi-arch**: the image builds for both `linux/amd64` and `linux/arm64`
(validated in CI), so this works unmodified on a Raspberry Pi or an ARM VPS,
not just x86 hardware.

## Without Docker

Requirements: Node.js 20+ (24 recommended — matches what CI and the Docker
image use), PostgreSQL with the PostGIS extension available (distribution
packages, e.g. `postgresql-16-postgis-3` on Debian/Ubuntu), and one of
Apache, nginx, or Caddy as a reverse proxy if you want TLS (all three are
documented below — pick whichever you already know).

```bash
git clone https://github.com/Romsmo/Trafficnetwork.git
cd Trafficnetwork/server
npm ci
npm run build
cp .env.example .env
# edit .env: DATABASE_URL pointing at your own Postgres, and JWT_SECRET
npm run db:migrate:prod
npm run start
```

**Running as a service**: see `deploy/trafficnetwork-server.service` for a
systemd unit example (runs `db:migrate:prod` automatically on every start,
restarts on failure, sandboxed). Windows: no first-class service wrapper is
provided in Phase F — run it under [NSSM](https://nssm.cc/) or Task
Scheduler pointed at `node dist/server.js`, or just use Docker Desktop
instead, which is the better-supported path on Windows.

**Reverse proxy** (needed for real TLS and to expose port 443/80 instead of
the app's own port 3000): example configs for all three, including the
`/v1/ws` WebSocket upgrade (Apache and nginx need explicit configuration for
this — Caddy handles it automatically):

- `deploy/apache.conf` — needs `mod_proxy`, `mod_proxy_http`, `mod_proxy_wstunnel` (`a2enmod proxy proxy_http proxy_wstunnel`)
- `deploy/nginx.conf`
- `deploy/Caddyfile.example`

All three assume [certbot](https://certbot.eff.org/)-issued certificates
(`certbot --apache`/`--nginx -d your-domain`) except Caddy, which issues its
own automatically.

**Backup**: back up the Postgres database (`pg_dump`/`pg_basebackup`) — the
server itself is stateless aside from it. **Update**: `git pull && npm ci &&
npm run build && npm run db:migrate:prod`, then restart the service.

## Configuration

Every setting is an environment variable, documented in `.env.example`. The
server refuses to start with a clear error naming the missing/invalid
variable(s) if a required value (`DATABASE_URL`, `JWT_SECRET`) is absent —
see `src/config/env.ts`.

## Verifying the install

```bash
curl https://your-domain/v1/health
```

Should return `{"status":"ok","database":"ok"}`. If it doesn't respond at
all, check the reverse proxy first (`systemctl status apache2`/`nginx`/
`caddy`, or `docker compose ps`); if it responds with `database: "unreachable"`,
check `DATABASE_URL` and that Postgres/PostGIS is actually running.
