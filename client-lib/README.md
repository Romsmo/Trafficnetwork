# client-lib

Client-Sync-Bibliothek: einbettbarer, maximal portabler Adapter für beliebige Apps. Lokaler Speicher, Sync-Engine (Snapshot/Paket-Bootstrap, Delta-Pull, WebSocket-Push, regionale Subscription), lokales Map-Matching, lokale Verfallsberechnung, Offline-Schreibpuffer.

Zielplattformen: Android (Kotlin), iOS/macOS (Swift), Flutter (Dart), React Native, Desktop/Server über C-ABI (inkl. Python, Node.js), Web-Browser (WASM).

**Status**: Phase 2 gestartet — Umsetzungsauftrag in [`docs/prompt-phase2-client-lib.md`](../docs/prompt-phase2-client-lib.md). Noch kein Code. Details siehe [`docs/concept.md`](../docs/concept.md) (Abschnitt 6) und [`docs/todo.md`](../docs/todo.md).

Hängt von der API aus `server/` ab (inkl. der Erweiterungen aus Meilenstein P2.0).
