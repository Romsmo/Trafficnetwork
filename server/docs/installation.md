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

**With a reverse proxy for real TLS** (needed once you have a domain
pointed at this host): copy `Caddyfile.example` to `Caddyfile`, put your real
domain in it, then:

```bash
docker compose --profile with-caddy up -d
```

Caddy provisions and renews its Let's Encrypt certificate automatically — no
separate certbot step. Update by pulling the latest code and re-running
`docker compose up -d --build` (rebuilds the image, re-runs migrations,
restarts with zero manual steps).

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
