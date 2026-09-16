# server

Relay-/Moderator-Server: Ereignisprotokoll, materialisierter Zustand (PostGIS), Snapshot-/Delta-API, Moderationsgate, Blitzer-Namensraum (standardmäßig deaktiviert), Client-Credential-Auth, Bulk-Import, WebSocket-Push.

**Status**: Phase 1 abgeschlossen (P1.0–P1.5). API vollständig, dokumentiert (siehe [`docs/api.md`](docs/api.md), [`docs/schema.md`](docs/schema.md)) und getestet. Details zum Architekturkonzept siehe [`docs/concept.md`](../docs/concept.md) und [`docs/prompt-phase1-server.md`](../docs/prompt-phase1-server.md).

Phase 2 (`client-lib/`) kann beginnen.

## Tech-Stack

Node.js + TypeScript + [Fastify](https://fastify.dev/) + [Drizzle ORM](https://orm.drizzle.team/) gegen Postgres/PostGIS (empfohlen: [Neon](https://neon.com/)). WebSocket-Push über [`@fastify/websocket`](https://github.com/fastify/fastify-websocket), Auth über clientseitige JWTs ([`jose`](https://github.com/panva/jose)). Begründung der Plattform-/Protokoll-/Tiling-Entscheidungen: siehe Plan-Dokument dieser Session bzw. `docs/prompt-phase1-server.md` Abschnitt 2.

## Setup

```bash
npm install
cp .env.example .env
# .env ausfüllen: DATABASE_URL (Neon-Connection-String), JWT_SECRET
npm run db:migrate
npm run create-client -- --name "mein-erster-client" --scope client
npm run dev
```

`GET /v1/health` prüft Erreichbarkeit der Datenbank (kein Auth nötig). Jeder andere `/v1/*`-Endpunkt braucht einen Bearer-Token — siehe [`docs/api.md`](docs/api.md) Abschnitt "Auth".

## Umgebungsvariablen

Siehe [`.env.example`](.env.example) — alle Werte sind dokumentiert und haben sinnvolle Defaults, insbesondere:

- `SPEED_CAMERA_NAMESPACE_ENABLED` — globaler Kill-Switch für den Blitzer-Namensraum, **muss** `false` bleiben, bis der Betreiber nach rechtlicher Prüfung (§23 Abs. 1b StVO, siehe `docs/concept.md` Abschnitt 8) grünes Licht gibt.
- `EVENT_LOG_RETENTION_DAYS_DYNAMIC` / `_STATIC` — Aufbewahrungsfenster für das Ereignisprotokoll, durchgesetzt vom stündlichen Cleanup-Job (`modules/expiry/retention.ts`).
- Moderationsgate-Parameter (`REPORT_RATE_LIMIT_*`, `DUPLICATE_MERGE_RADIUS_METERS`, `SPEED_KMH_*`, `CAMERA_REMOVAL_THRESHOLD`).
- `JWT_SECRET` / `JWT_TTL_SECONDS` — Signierschlüssel und Gültigkeitsdauer für Client-Tokens.

## API

Vollständige Referenz: [`docs/api.md`](docs/api.md). Kurzfassung:

- **Auth**: `POST /v1/auth/token` (Client-Credentials → JWT). Jeder `/v1/*`-Endpunkt außer `/v1/health` und `/v1/auth/token` braucht `Authorization: Bearer <token>`. `reporterId` kommt bei Schreibzugriffen immer aus dem Token, nie aus dem Body.
- **Lesen**: `GET /v1/speed-limit`, `/v1/speed-limit-segments/nearby`, `/v1/static-signs/nearby`, `/v1/hazard-reports/{nearby,by-tile}`, `/v1/speed-cameras/{nearby,by-tile}` (leer, solange das Blitzer-Flag aus ist), `/v1/snapshot`, `/v1/delta`.
- **Schreiben**: `POST /v1/hazard-reports` (läuft durchs Moderationsgate: Plausibilität, Rate-Limit, Duplikat-Merge; `type: "fixedSpeedCamera"` wird in den Blitzer-Namensraum umgeleitet), `POST /v1/hazard-reports/:id/confirmations`, `POST /v1/speed-cameras/:id/removal-reports`. Schreibzugriffe auf den Blitzer-Namensraum funktionieren unabhängig vom Flag — nur Lesezugriffe sind gegated.
- **Bulk-Import** (Scope `bulk-import`): `POST /v1/bulk-import/{speed-limit-segments,static-signs,speed-cameras}`, max. 5000 Zeilen/Aufruf, erzeugt bewusst keine Event-Log-Einträge (Abholung nur über `/v1/snapshot`, siehe `docs/api.md`).
- **Realtime**: `GET /v1/ws` (WebSocket) — Auth per erster Nachricht (nicht per Query-String-Token), danach `subscribe`/`unsubscribe` auf H3-Tiles.

## Datenbank / Migrations

Schema liegt in `src/db/schema/`, Migrations werden mit [drizzle-kit](https://orm.drizzle.team/kit-docs/overview) erzeugt:

```bash
npm run db:generate   # neue Migration aus Schema-Änderungen generieren
npm run db:migrate    # ausstehende Migrations gegen DATABASE_URL anwenden
```

Die erste Migration (`0000_enable_postgis.sql`) aktiviert die PostGIS-Extension und muss vor der Schema-Migration laufen — das ist bereits so in der Migrationsreihenfolge hinterlegt. Vollständige Schema-Doku: [`docs/schema.md`](docs/schema.md) (u. a. der Grund, warum alle Geometrie-Spalten einen Custom-Type statt Drizzles eingebauten `geometry()`-Helper nutzen).

## Client-Provisionierung

Kein Admin-HTTP-API in Phase 1 (bewusste Vereinfachung für Einzelbetreiber). Clients werden lokal gegen die DB angelegt:

```bash
npm run create-client -- --name "mein-erster-client" --scope client
npm run create-client -- --name "ingestion-worker" --scope bulk-import
```

Das `clientSecret` wird nur einmal ausgegeben (gehasht gespeichert, siehe `modules/auth/credentials.ts`) — sofort sichern.

## Hintergrund-Jobs

Beide starten automatisch mit dem Server (`src/server.ts`), sauberer Shutdown über `close-with-grace`:

- **Expiry-Sweep** (`modules/expiry/worker.ts`, standardmäßig jede Minute): setzt abgelaufene `hazard_reports` auf `expired`, publiziert `ReportExpired` an WebSocket-Abonnenten.
- **Retention-Cleanup** (`modules/expiry/retention.ts`, standardmäßig stündlich): löscht Event-Log-Einträge außerhalb der Aufbewahrungsfenster sowie länger `expired`/`removed` `hazard_reports`-Zeilen.

## Tests

```bash
npm run test:unit          # keine Infrastruktur nötig
npm run test:integration   # startet einen postgis/postgis-Container über Testcontainers — braucht lokal Docker
npm test                   # beides
```

Integrationstests laufen automatisch in CI (`.github/workflows/server-ci.yml`, GitHub-Actions-Runner bringt Docker mit). Lokal ohne Docker Desktop lassen sich nur die Unit-Tests ausführen. WebSocket-Tests starten einen echten horchenden Server plus einen echten `ws`-Client (Fastifys `app.inject()` unterstützt kein WS-Upgrade).

## Meilensteine

| # | Inhalt | Status |
|---|---|---|
| P1.0 | Plattform-/Transport-/Tiling-/Stack-/API-Stil-Entscheidungen recherchiert und begründet, Plan vorgelegt | ✅ |
| P1.1 | Datenmodell + Migrations, Ereignisprotokoll + materialisierter Zustand | ✅ |
| P1.2 | Snapshot- und Delta-Mechanik, Lese-Endpunkte, Expiry-Sweep-Worker | ✅ |
| P1.3 | Moderationsgate, Schreib-Endpunkte für Hazard-Reports | ✅ |
| P1.4 | Blitzer-Namensraum, separat, standardmäßig deaktiviert | ✅ |
| P1.5 | Auth, Bulk-Import, WebSocket-Push, Retention-Cleanup, API-/Schema-Doku, vollständige Testsuite — **Phase-1-Abschluss** | ✅ |
