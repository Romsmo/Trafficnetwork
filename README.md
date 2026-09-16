# Trafficnetwork

Offenes, quelloffenes Verkehrsdaten-Netzwerk (Local-First): Tempolimits, Verkehrszeichen und Live-Gefahrenmeldungen (Stau, Unfall, Baustelle, Glaette, Panne, Hindernis, Blitzer). Start-Scope: Europa, Architektur fuer weltweite Ausweitung vorbereitet.

## Prinzip

Jedes Geraet haelt seine Daten lokal und funktioniert offline. Der Server ist Vermittler und Moderator (Ereignisprotokoll, Snapshot/Delta-Sync), keine Live-Abfrage-API.

## Struktur (Monorepo)

- `server/` - Relay-/Moderator-Server (Ereignisprotokoll, Snapshot/Delta-API, Moderationsgate)
- `client-lib/` - Client-Sync-Bibliothek (lokaler Speicher, Offline-Betrieb, einbettbar in beliebige Apps)
- `ingestion/` - optionales Ingestion-Programm zur Erstbefuellung. Kein Kernbestandteil - laeuft nur als gewoehnlicher Client gegen die oeffentliche API, jederzeit abschaltbar/ersetzbar.
- `docs/` - Konzept und offene Punkte

## Baureihenfolge

1. Server (inkl. API) - vollstaendig fertig
2. Client-Sync-Bibliothek
3. Ingestion-Programm - Grundstock-Befuellung

Details: siehe `docs/concept.md` und `docs/todo.md`.

## Lizenz

Apache License 2.0, siehe `LICENSE`.
