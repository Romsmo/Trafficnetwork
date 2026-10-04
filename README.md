# Trafficnetwork

Offenes, quelloffenes Verkehrsdaten-Netzwerk (Local-First): Tempolimits, Verkehrszeichen und Live-Gefahrenmeldungen (Stau, Unfall, Baustelle, Glätte, Panne, Hindernis, Blitzer). Start-Scope: Europa, Architektur für weltweite Ausweitung vorbereitet.

## Schnellstart (eigener Server, Docker)

Vom geklonten Repo bis zum antwortenden Server, ohne echte Daten (leerer Server ist ein gültiger Zustand):

```bash
git clone https://github.com/Romsmo/Trafficnetwork.git
cd Trafficnetwork/server
cp .env.example .env
# .env: POSTGRES_PASSWORD und JWT_SECRET setzen (zwei Zeilen, alles andere hat einen sinnvollen Default)
docker compose up -d
curl http://localhost:3000/v1/health
# -> {"status":"ok","database":"ok"}
```

Damit laeuft ein einzelner, nicht foederierter Knoten mit eingebauter Weboberflaeche unter `http://localhost:3000/` (Karte, Melden, "Verbinden"-Seite) — Blitzer-Namensraum ist per Default aus. Ein eigenes Testgeraet anlegen und eine Meldung absetzen: im laufenden Docker-Stack ein Zugangsdaten-Paar mit dem kurzen Befehl aus [`server/docs/installation.md`](server/docs/installation.md) (Abschnitt "Create the first client") erzeugen (in einer Entwicklungsumgebung: `npm run create-client -- --name "mein-erster-client" --scope client` in `server/`), dann z. B. `tools/test-client/` (eigenes `README.md`) oder direkt gegen die API (`server/docs/api.md`). Vollstaendige Anleitung inkl. Betrieb ohne Docker, Foederation, Reverse-Proxy-Beispielen: [`server/docs/installation.md`](server/docs/installation.md), [`server/docs/operating.md`](server/docs/operating.md). Region mit echten Daten befuellen: [`ingestion/README.md`](ingestion/README.md) (optional, siehe unten).

Selbst nachvollzogen (frischer Klon, dieselben Schritte, 2026-09-27) — siehe [`docs/audit.md`](docs/audit.md) Abschnitt 2 für den vollständigen Durchstich inklusive Client-Bibliothek und Weboberfläche.

## Prinzip

Jedes Gerät hält seine Daten lokal und funktioniert offline. Der Server ist Vermittler und Moderator (Ereignisprotokoll, Snapshot/Delta-Sync), keine Live-Abfrage-API.

Jeder kann einen Server betreiben (Docker oder ohne Docker hinter Apache/nginx/Caddy). Server verbinden sich automatisch zu einem offenen, föderierten Netzwerk und teilen sich die Last; Clients finden Server selbst. Konzept: `docs/federation.md`.

## Struktur (Monorepo)

- `server/` - Relay-/Moderator-Server (Ereignisprotokoll, Snapshot/Delta-API, Moderationsgate)
- `client-lib/` - Client-Sync-Bibliothek (lokaler Speicher, Offline-Betrieb, einbettbar in beliebige Apps)
- `ingestion/` - optionales Ingestion-Programm zur Erstbefüllung. Kein Kernbestandteil - läuft nur als gewöhnlicher Client gegen die öffentliche API, jederzeit abschaltbar/ersetzbar.
- `docs/` - Konzept und offene Punkte

## Baureihenfolge

1. Server (inkl. API) - vollständig fertig
2. Client-Sync-Bibliothek
3. Überarbeitung F: Self-Hosting & Föderation (Server, dann Client-Bibliothek)
4. Ingestion-Programm - Grundstock-Befüllung

Details: siehe `docs/concept.md` und `docs/todo.md`.

## Lizenz

Apache License 2.0, siehe `LICENSE`.
