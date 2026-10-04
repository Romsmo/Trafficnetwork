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

Damit läuft ein einzelner, nicht föderierter Knoten mit eingebauter Weboberfläche unter `http://localhost:3000/` (Karte, Melden, „Verbinden"-Seite). Blitzer-Kategorien sind freigeschaltet (Standard in jedem Land `full`), in der Weboberfläche und in der Client-Bibliothek aber beim ersten Besuch ausgeblendet; einzelne Länder lassen sich per signierter Politik auf `zones` oder `off` setzen, ohne Code zu ändern ([`server/docs/operating.md`](server/docs/operating.md), „Camera policy").

Zugangsdaten für ein Testgerät legst du im Docker-Stack nicht mit `npm run create-client` an (das braucht einen Datenbankzugang von außen), sondern mit dem Befehl aus [`server/docs/installation.md`](server/docs/installation.md), Abschnitt „Create the first client". Danach z. B. `tools/test-client/` (eigenes `README.md`), eine der Client-Bibliotheken ([`client-lib/README.md`](client-lib/README.md), Anleitung je Plattform) oder direkt die API (`server/docs/api.md`). Vollständige Anleitung inkl. Betrieb ohne Docker, Föderation, Reverse-Proxy-Beispielen: [`server/docs/installation.md`](server/docs/installation.md), [`server/docs/operating.md`](server/docs/operating.md). Region mit echten Daten befüllen: [`ingestion/README.md`](ingestion/README.md) (optional).

Die Schritte oben sind aus einem frischen Klon durchgespielt (Befehle, Ausgaben und Belege: [`docs/final-report.md`](docs/final-report.md)). Fertige Server- und Ingestion-Images mit Prüfsummen hängen an den GitHub-Releases (`server-v…`, `ingestion-v…`, `client-lib-v…`); offene Punkte stehen in [`docs/todo.md`](docs/todo.md).

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
