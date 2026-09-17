# client-lib

Client-Sync-Bibliothek: einbettbarer, maximal portabler Adapter für beliebige Apps. Lokaler Speicher, Sync-Engine (Snapshot/Paket-Bootstrap, Delta-Pull, WebSocket-Push, regionale Subscription), lokales Map-Matching, lokale Verfallsberechnung, Offline-Schreibpuffer.

Zielplattformen: Android (Kotlin), iOS/macOS (Swift), Flutter (Dart), React Native, Desktop/Server über C-ABI (inkl. Python, Node.js), Web-Browser (WASM).

**Status**: Meilenstein P2.0 (Server-Erweiterungen in `server/`: Geräteregistrierung, partitionierte statische Datenpakete, Config-Endpunkt) ist umgesetzt — siehe `server/docs/api.md`. P2.1 (Kern-Grundgerüst dieser Bibliothek) startet als Nächstes; noch kein Code hier in `client-lib/`. Details siehe [`docs/concept.md`](../docs/concept.md) (Abschnitt 6), [`docs/prompt-phase2-client-lib.md`](../docs/prompt-phase2-client-lib.md) und [`docs/todo.md`](../docs/todo.md).

**Geplante Überarbeitung (Phase F-Client, nach F-Server):** Server-Suche über Seeds + signiertes Verzeichnis, Mehrserver-Transport mit Failover, Signaturprüfung aller Daten, gerätesignierte Meldungen. Konzept: [`docs/federation.md`](../docs/federation.md), Auftrag: [`docs/prompt-rework-client-lib-federation.md`](../docs/prompt-rework-client-lib-federation.md).
