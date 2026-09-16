# server

Relay-/Moderator-Server: Ereignisprotokoll, materialisierter Zustand (PostGIS), Snapshot-/Delta-API, Moderationsgate, Blitzer-Namensraum (standardmäßig deaktiviert).

**Status**: Phase 1, Meilenstein P1.1 abgeschlossen (Schema + Migrations + `appendEvent`-Helper + Health-Endpoint). Details siehe [`docs/concept.md`](../docs/concept.md) und [`docs/prompt-phase1-server.md`](../docs/prompt-phase1-server.md).

Muss vollständig fertig sein, bevor Phase 2 (`client-lib/`) beginnt.

## Tech-Stack

Node.js + TypeScript + [Fastify](https://fastify.dev/) + [Drizzle ORM](https://orm.drizzle.team/) gegen Postgres/PostGIS (empfohlen: [Neon](https://neon.com/)). Begründung der Plattform-/Protokoll-/Tiling-Entscheidungen: siehe Plan-Dokument dieser Session bzw. `docs/prompt-phase1-server.md` Abschnitt 2.

## Setup

```bash
npm install
cp .env.example .env
# .env ausfüllen: DATABASE_URL (Neon-Connection-String), JWT_SECRET
npm run db:migrate
npm run dev
```

`GET /v1/health` prüft Erreichbarkeit der Datenbank.

## Umgebungsvariablen

Siehe [`.env.example`](.env.example) — alle Werte sind dokumentiert und haben sinnvolle Defaults, insbesondere:

- `SPEED_CAMERA_NAMESPACE_ENABLED` — globaler Kill-Switch für den Blitzer-Namensraum, **muss** `false` bleiben, bis der Betreiber nach rechtlicher Prüfung (§23 Abs. 1b StVO, siehe `docs/concept.md` Abschnitt 8) grünes Licht gibt.
- `EVENT_LOG_RETENTION_DAYS_DYNAMIC` / `_STATIC` — Aufbewahrungsfenster für das Ereignisprotokoll.
- Moderationsgate-Parameter (`REPORT_RATE_LIMIT_*`, `DUPLICATE_MERGE_RADIUS_METERS`, `SPEED_KMH_*`).

## Datenbank / Migrations

Schema liegt in `src/db/schema/`, Migrations werden mit [drizzle-kit](https://orm.drizzle.team/kit-docs/overview) erzeugt:

```bash
npm run db:generate   # neue Migration aus Schema-Änderungen generieren
npm run db:migrate    # ausstehende Migrations gegen DATABASE_URL anwenden
```

Die erste Migration (`0000_enable_postgis.sql`) aktiviert die PostGIS-Extension und muss vor der Schema-Migration laufen — das ist bereits so in der Migrationsreihenfolge hinterlegt.

**Hinweis zu Geometrie-Spalten**: Alle `geometry`-Spalten nutzen einen eigenen Custom-Type (`src/db/schema/geometry.ts`) statt Drizzles eingebauten `geometry()`-Helper, weil dessen `getSQLType()` in der hier gepinnten Drizzle-Version den SRID stillschweigend ignoriert und immer unqualifiziertes `geometry(point)` erzeugt — das hätte SRID-Mismatch-Fehler bei jedem `ST_DWithin`/`ST_MakePoint(...,4326)`-Vergleich verursacht. Lesen/Schreiben über diese Spalten läuft daher immer über rohe `sql`-Templates, nicht über Drizzles typisierte Insert/Select-Helfer.

## Tests

```bash
npm run test:unit          # keine Infrastruktur nötig
npm run test:integration   # startet einen postgis/postgis-Container über Testcontainers — braucht lokal Docker
npm test                   # beides
```

Integrationstests laufen automatisch in CI (`.github/workflows/server-ci.yml`, GitHub-Actions-Runner bringt Docker mit). Lokal ohne Docker Desktop lassen sich nur die Unit-Tests ausführen.

## Client-Provisionierung

Kein Admin-HTTP-API in Phase 1 (bewusste Vereinfachung für Einzelbetreiber). Clients werden lokal gegen die DB angelegt:

```bash
npm run create-client -- --name "mein-erster-client" --scope client
npm run create-client -- --name "ingestion-worker" --scope bulk-import
```

*(Skript folgt in Meilenstein P1.5, zusammen mit dem Auth-Modul.)*

## Meilensteine

| # | Inhalt | Status |
|---|---|---|
| P1.0 | Plattform-/Transport-/Tiling-/Stack-/API-Stil-Entscheidungen recherchiert und begründet, Plan vorgelegt | ✅ |
| P1.1 | Datenmodell + Migrations, Ereignisprotokoll + materialisierter Zustand | ✅ |
| P1.2 | Snapshot- und Delta-Mechanik | ⬜ |
| P1.3 | Moderationsgate | ⬜ |
| P1.4 | Blitzer-Namensraum, separat, standardmäßig deaktiviert | ⬜ |
| P1.5 | API vollständig, dokumentiert und getestet — **Phase-1-Abschluss** | ⬜ |
