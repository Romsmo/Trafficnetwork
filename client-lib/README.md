# client-lib

Client-Sync-Bibliothek: einbettbarer, maximal portabler Adapter für beliebige Apps. Lokaler Speicher, Sync-Engine (Snapshot/Paket-Bootstrap, Delta-Pull, WebSocket-Push, regionale Subscription), lokales Map-Matching, lokale Verfallsberechnung, Offline-Schreibpuffer — jetzt von Anfang an föderationsfähig gebaut (Server-Discovery, Mehrserver-Failover, Signaturprüfung, gerätesignierte Meldungen), siehe "Föderation" unten.

Zielplattformen: Android (Kotlin), iOS/macOS (Swift), Flutter (Dart), React Native, Desktop/Server über C-ABI (inkl. Python, Node.js), Web-Browser (WASM).

**Status**: Meilenstein F-C1 abgeschlossen (Branch `rework/client-lib-federation`, noch nicht nach `main` gemergt). Details zum Gesamtplan siehe [`docs/concept.md`](../docs/concept.md) (Abschnitt 6/13), [`docs/federation.md`](../docs/federation.md), [`docs/prompt-phase2-client-lib.md`](../docs/prompt-phase2-client-lib.md) (ursprünglicher Basis-Auftrag), [`docs/prompt-rework-client-lib-federation.md`](../docs/prompt-rework-client-lib-federation.md) (Föderations-Auftrag) und [`docs/todo.md`](../docs/todo.md). Laufender Cross-Instanz-Status: [`docs/status.md`](../docs/status.md).

## Warum Basis und Föderation zusammen

`client-lib/` hatte noch keinen Code, als die Server-Föderation (F-S) fertig wurde — statt erst das ursprüngliche, nicht-föderierte P2.1–P2.5 zu bauen und danach umzubauen, entwirft der F-C0-Plan **eine** Bibliothek, die beides von Anfang an vereint. Kein Migrationspfad nötig, da es keine bestehende Integration gibt.

## Toolchain

Rust-Kern (`core/`) + dünne Bindings pro Plattform (`bindings/`): UniFFI (Android/iOS), flutter_rust_bridge (Flutter), uniffi-bindgen-react-native (React Native), cbindgen + PyO3 + napi-rs (C-ABI/Python/Node.js), wasm-bindgen (Web). Speicher: `rusqlite`/`sqlite-wasm-rs` (SQLite, kein SpatiaLite — Begründung im F-C0-Plan). Tiling: `h3o` (reines Rust, gleiche H3-Resolution-7-Semantik wie der Server). Kryptografie: `ed25519-dalek` + `serde_json_canonicalizer` (RFC 8785) — siehe "Kryptografie" unten.

## Kryptografie

`core/src/crypto/{canonical,keys,envelope}.rs` bildet `server/src/modules/crypto/*.ts` feldgleich nach: RFC-8785-kanonisches JSON, rohe 32-Byte-Ed25519-Schlüssel (base64url, unpadded), `SignedEnvelope<T> = { payload, keyId, signature }`. Das ist keine Selbstverständlichkeit — eine in Rust erzeugte Signatur muss unter Node.js' `canonicalize` + `node:crypto` verifizieren, sonst könnte kein Server je eine geräteseitig erzeugte Meldung prüfen. Deshalb gibt es einen echten Cross-Language-Test statt nur In-Prozess-Selbsttests:

```bash
cargo run -p trafficnetwork-core --example gen_vector | node fixtures/verify-vector.mjs
```

`core/examples/gen_vector.rs` erzeugt ein Schlüsselpaar und signiert eine Testnutzlast; `fixtures/verify-vector.mjs` kanonisiert und verifiziert sie unabhängig mit dem serverseitigen Stack — läuft in CI als eigener Job.

## Föderation

Server-Discovery über `GET /v1/network/directory` (eingebaute Seed-Liste als Startpunkt), Mehrserver-Pool mit clientseitig gemessener Latenz + Reputationsstufe für die Auswahl (das Verzeichnis liefert keine Geo-Angabe — "Nähe" wird gemessen, nicht behauptet), Failover mit exponentiellem Backoff, pro-Server-Sync-Cursor (da `/v1/delta`s `since` serverseitig weiterhin lokal ist), client-lokale Stichproben-Prüfung gegen Zurückhalten (serverseitig nicht implementiert, siehe `server/docs/federation-protocol.md` §7). Details/Begründung: F-C0-Plan-Abschnitt dieser Session, konsolidiert in `docs/status.md`.

## Bauen & Testen

Rust ist auf der Entwicklungsmaschine dieser Session nicht installiert — Verifikation ausschließlich über `.github/workflows/client-lib-ci.yml` (native build+test+clippy+fmt, `wasm32-unknown-unknown`-Build, Cross-Language-Krypto-Vektor, cbindgen-Header-Generierung). Mit lokalem Rust: `cargo build --workspace`, `cargo test --workspace` in `client-lib/`.

## Meilensteine

| # | Inhalt | Status |
|---|---|---|
| F-C0 | Stand geprüft, Entscheidungen (Server-Auswahl, Failover, Sync beim Serverwechsel, Stichproben-Prüfung, Verzeichnis-Cache), Architektur-Skizze, Plan | ✅ |
| F-C1 | Kryptografie im Kern + gerätesignierte Datenstrukturen, Cargo-Workspace, C-ABI-Skelett, CI-Matrix | ✅ |
| F-C2 | Discovery-Modul + Mehrserver-Transport-Pool + Failover | 🔜 |
| F-C3 | Sync-Engine (Bootstrap/Delta/Pakete/WebSocket, pro-Server-Cursor), Offline-Schreibpuffer, Map-Matching, Verfallsberechnung, Stichproben-Prüfung | |
| F-C4 | Bindings für alle Zielplattformen + Konformitätstests | |
| F-C5 | Mehrknoten-Integrationstests grün, Doku, Pull Request — **Abschluss** | |
