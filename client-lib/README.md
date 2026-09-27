# client-lib

Client-Sync-Bibliothek: einbettbarer, maximal portabler Adapter für beliebige Apps. Lokaler Speicher, Sync-Engine (Snapshot/Paket-Bootstrap, Delta-Pull, WebSocket-Push, regionale Subscription), lokales Map-Matching, lokale Verfallsberechnung, Offline-Schreibpuffer — jetzt von Anfang an föderationsfähig gebaut (Server-Discovery, Mehrserver-Failover, Signaturprüfung, gerätesignierte Meldungen), siehe "Föderation" unten.

Zielplattformen: Android (Kotlin), iOS/macOS (Swift), Flutter (Dart), React Native, Desktop/Server über C-ABI (inkl. Python, Node.js), Web-Browser (WASM).

**Status**: Meilenstein F-C3 abgeschlossen (Branch `rework/client-lib-federation`, noch nicht nach `main` gemergt). Details zum Gesamtplan siehe [`docs/concept.md`](../docs/concept.md) (Abschnitt 6/13), [`docs/federation.md`](../docs/federation.md), [`docs/prompt-phase2-client-lib.md`](../docs/prompt-phase2-client-lib.md) (ursprünglicher Basis-Auftrag), [`docs/prompt-rework-client-lib-federation.md`](../docs/prompt-rework-client-lib-federation.md) (Föderations-Auftrag) und [`docs/todo.md`](../docs/todo.md). Laufender Cross-Instanz-Status: [`docs/status.md`](../docs/status.md).

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

`core/src/platform/{clock,http,ws}.rs` sind die host-app-austauschbaren Seams (kein direkter Netzwerk-/Uhrzugriff im Kern); `ReqwestHttpTransport` ist der Standard und läuft unverändert nativ wie auf `wasm32-unknown-unknown` (reqwest wechselt selbst auf `fetch()` im Browser). `core/src/discovery/{types,scoring,pool,service}.rs` implementiert das oben Beschriebene — `ServerPool` und `discovery::scoring` sind pure, deterministisch unit-getestete Logik (Zeit/Zufall werden injiziert, nie intern gelesen), `DiscoveryService` verbindet sie mit dem Transport.

## Sync-Engine (F-C3)

`core/src/storage/mod.rs` definiert `Store` — die Persistenz-Seam (Cursor pro Server, Partitions-Hashes, Entitäten, Schreibpuffer), analog zu `Clock`/`HttpTransport`. `InMemoryStore` ist die Referenzimplementierung, gegen die die meisten Tests in diesem Crate laufen und die kleine Datenmengen (Tests, Prototypen) trägt; für echte Bestände gibt es seit Zusatz E Teil C den `SqliteStore` (nativ, siehe unten). Die Browser-Variante (`sqlite-wasm-rs`) ist **weiterhin auf F-C4 verschoben** — das ist eine Plattform-/Binding-Entscheidung, keine, die der plattformunabhängige Kern selbst treffen sollte.

`core/src/sync/engine.rs`s `SyncEngine` orchestriert `GET /v1/snapshot` (immer mit `staticData=false`, da statische Daten separat über die inhaltsadressierten Manifest-/Partitions-Endpunkte laufen), `GET /v1/delta` mit einem **pro-Server-Cursor** (ein `409 SNAPSHOT_REQUIRED` löst einen Neu-Snapshot beim selben Server aus, nie bei einem anderen — `since` ist serverlokal, siehe "Föderation" oben) und `GET /v1/static-data/{manifest,partitions/:tile}` (Hash-Vergleich vor jedem Nachladen). Dafür neu: `DiscoveryService::request_to_server()`, die Einzelserver-Variante von `request_with_failover` für genau diesen Fall, wo ein anderer Server bei Fehlschlag aktiv falsch wäre.

`core/src/sync/auth.rs` implementiert die Token-Flows (`POST /v1/auth/token`, `/v1/devices/register`, `/v1/devices/bind-key`, `/v1/auth/device-token`), die `SyncEngine` einen Bearer-Token liefern — Token-Beschaffung/-Erneuerung ist bewusst nicht Aufgabe der Engine selbst (dieselbe Grenze wie bei `Clock`/`HttpTransport`), sondern gehört zur künftigen öffentlichen API-Fassade.

`core/src/sync/writebuffer.rs` signiert **nicht** beim Einreihen in den Schreibpuffer, sondern frisch bei jedem Sendeversuch — `deviceAssertion`s Timestamp-Fenster ist nur 60 Sekunden, und ein Offline-Puffer muss genau das überdauern können.

`core/src/sync/{matching,expiry}.rs` sind reine, netzwerkfreie lokale Abfragen gegen bereits synchronisierte Daten: nächstgelegenes Tempolimit / Nahbereich-Meldungen (flache Projektion, für die Zehner-Meter-Skala ausreichend genau) bzw. Verfallsberechnung (liest `ClientConfig.hazard_expiry_ms_by_type` aus `GET /v1/config`, statt die Server-Konstanten zu duplizieren).

`core/src/sync/withholding.rs` ist die client-lokale Stichproben-Prüfung (Standard 10 % der Sync-Zyklen, F-C0-Plan §1.5): vergleicht die Delta-Antwort des Primärservers gegen einen Zweitserver für dieselbe `since`-Anfrage und verbucht eine gefundene Zurückhaltung als rein clientlokalen Reputations-Malus — in `SyncEngine` verankert, kein zusätzlicher Aufruf nötig.

`core/src/platform/ws.rs` (`WsConnection`/`WsTransport`) + `core/src/sync/realtime.rs`s `run()` treiben `GET /v1/ws` (Auth-Handshake, Tile-Subscriptions, Event-Dispatch über denselben `SyncEngine::apply_event`, den auch Delta-Pull nutzt) — vollständig getestet gegen eine simulierte Verbindung. **Ohne mitgelieferte Standardimplementierung**: anders als bei HTTP (`ReqwestHttpTransport`) ist ein echter WebSocket-Client eine Plattformentscheidung (`tokio-tungstenite` nativ, Browser-`WebSocket` auf `wasm32`), die sich ohne echte Toolchain nicht verifizieren lässt — bewusst auf F-C4 verschoben statt hier blind geraten.

## Falsche Tempolimits melden und korrigieren (Zusatz K, Teil C)

`core/src/sync/corrections.rs` macht das Melden eines falschen Tempolimits und das Bestätigen/Widersprechen aus Host-Apps möglich — gebaut gegen den tatsächlichen Server-Vertrag (`server/docs/api.md`, "Speed-limit corrections"; Plan mit allen Entscheidungen: `server/docs/speed-limit-corrections.md`).

- `report_wrong_speed_limit(store, clock, config, report)` (`WrongSpeedLimitReport { segment: Id | Position, proposed_value, unit, reason? }`) und `confirm_speed_limit_correction(store, clock, config, target, agrees)` **stellen nur in den Offline-Schreibpuffer ein** — gesendet und **beim Senden frisch signiert** (Zeitstempel ≤ 60 s) über dasselbe `flush_pending` wie Meldungen. Vor dem Einreihen prüft die Bibliothek dieselben Plausibilitätsregeln wie der Server (Bereich, Vielfache des Schritts, Einheit des Segments, Wert ≠ Import; aus `GET /v1/config` → `communityCorrections`). Bietet der Server die Funktion nicht an (älterer Server oder abgeschaltet), meldet der Aufruf `CorrectionError::NotOffered` — die App blendet die Funktion dann aus; das Senden gegen einen alten Server ist ebenfalls kein Fehler.
- **Überlagerung statt Überschreiben:** Ein Vorschlag bleibt als `LocalCorrectionProposal` neben dem synchronisierten Segment liegen — der importierte Wert wird nie verändert. Eine zurückgenommene Korrektur (das Segment kommt per Sync wieder ohne `correctedBy`) oder ein vom Server abgelehnter Vorschlag fällt deshalb von selbst auf den Import zurück. Ein Vorschlag, dessen Wert die Community inzwischen bestätigt hat, wird nach dem Sync entfernt (das Segment sagt dasselbe, mit der echten Zahl).
- **Herkunft beim Lesen:** `speed_limit_at()` / `nearest_speed_limit_with_proposals()` liefern zusätzlich `origin` (`Imported`, `LocallyProposed { confirmations }` = eigener, noch unbestätigter Vorschlag, `CommunityCorrected { confirmations, needs_review }`), `imported_speed_limit` und `segment_key`. Rangfolge: Community-Korrektur vor eigenem Vorschlag vor Import. Ein eigener Vorschlag gilt **lokal sofort** — die Herkunft macht ihn erkennbar; die App entscheidet, ob sie ihn so anzeigt. Bestehende Felder bleiben unverändert (rein additiv).
- **Zeilen-IDs sind pro Server zufällig**, `segmentKey` ist überall gleich: liefert ein Server für die ID ein `404`, sucht die Bibliothek dasselbe Segment dort über seinen `segmentKey` und sendet an dessen eigene ID. `429` (das strenge Geräte-Limit) wird später erneut versucht, jeder andere `4xx` ist endgültig und entfernt auch die lokale Überlagerung.
- `correction_id()` leitet die deterministische Korrektur-ID exakt wie der Server ab (Testvektoren unabhängig mit einer zweiten SHA-256-Implementierung berechnet), sodass ein Vorschlag seine ID schon vor dem Senden kennt. `fetch_corrections()` (`GET /v1/speed-limit-corrections?tiles=…`) liefert offene Vorschläge für „stimmt das noch?"; ein alter Server liefert `404` = leere Liste, kein Fehler.
- Widerspruch gegen den **eigenen** Vorschlag nimmt ihn sofort zurück (der Server entzieht einem Gerät bei Widerspruch die Zustimmung); war er noch nicht gesendet, wird er einfach verworfen und nichts gesendet.

## Online-Anzeige (Zusatz O, Teil C)

`core/src/status.rs` macht die Zahl „aktuell online" aus dem öffentlichen `GET /v1/stats/online` für Host-Apps verfügbar: `NetworkStatus { online_node, online_network, online_estimated, online_as_of }` (JSON: `onlineNode`, `onlineNetwork`, `onlineEstimated`, `onlineAsOf`). Rein additiv, alle Felder optional.

- **Nie blockierend:** `OnlineStatusService::network_status()` liest nur den Zwischenspeicher (30 s) und fasst das Netz nie an; `refresh()` ist, was der Takt der Host-App aufruft, und tut innerhalb des Zwischenspeicher-Fensters nichts — die Bibliothek plant nichts selbst (siehe `platform`-Modul).
- **Ältere Server** ohne den Endpunkt (404/405/410, 401/403) oder mit abgeschalteter Funktion (`{"enabled": false}`) lassen die Felder leer, ohne Fehler, und werden fünf Minuten lang nicht erneut gefragt. Ein kurzer Ausfall behält die zuletzt bekannten Werte.
- **Zwei Zusicherungen, die nicht vom Server abhängen:** Eine exakte Zahl unter `minDisplayThreshold` wird als `Below(N)` („weniger als N") weitergegeben, nie als Zahl; die netzweite Zahl ist immer `estimated`, was der Knoten auch behauptet (fremde Zahlen sind Behauptungen).
- Die Bibliothek sendet dafür nichts Zusätzliches — die Zählung passiert serverseitig anhand bestehender Verbindungen/Anfragen.
- `getNetworkStatus()` als öffentliche Fassade gibt es noch nicht (F-C4/F-C5); `NetworkStatus` ist dessen erste Heimat, die übrigen Felder aus dem F-C0-Plan (bekannte/aktive Knoten, Verzeichnis-/Config-Version) kommen dort dazu.
- Gebaut gegen das im Auftrag vorgeschlagene Antwortformat `{ node: { online, windowSeconds }, network?: { online, nodes, estimated, asOf }, minDisplayThreshold }` mit `online: null` + `below: N` unter dem Schwellenwert; **der Server-Teil (A) steht noch aus** — weicht er ab, genügt eine Anpassung von `parse_online_stats` samt Tests.

## Grundstock in großem Maßstab (Zusatz E, Teil C)

Vorbereitung und Messung für den Europa-Grundstock ("alles auf jedem Gerät"). **Rein additiv** — keine bestehende API ändert sich; die Entscheidung "alles auf jedem Gerät" bleibt, bis der Nutzer sie ändert. Messwerte und Bewertung: [`docs/bootstrap-measurements.md`](docs/bootstrap-measurements.md).

- **`SqliteStore`** (`core/src/storage/sqlite.rs`, nativ; nicht für `wasm32`): Datei-Datenbank (WAL) mit R*Tree über den Segment-Boxen, Geometrie als `i32`-Mikrograd-BLOB (± 1 cm), Schema-Version über `user_version`. Ortsabfragen (`speed_limit_at`, Korrektur-Suche, Vorschlags-Bereinigung) laden nur noch Segmente in der Nähe, nicht mehr den ganzen Bestand — der `InMemoryStore` hätte bei Millionen Segmenten quadratisch skaliert. Alle `Store`-Implementierungen laufen gegen dieselbe Vertragstest-Suite (`storage/contract.rs`).
- **Wiederaufnahme:** Jede statische Partition wird **zusammen mit ihrem Hash in einer Transaktion** geschrieben (`Store::upsert_static_partition`). Ein Abbruch (Prozess beendet, Verbindung weg, Akku leer) lässt daher nie eine halbe Partition zurück; der nächste Lauf lädt nur die noch fehlenden/veränderten Partitionen. Getestet inkl. simuliertem Prozess-Kill und Wiedereröffnen der Datei.
- **Zu wenig Speicher:** Ein volles Dateisystem wird zu `SyncError::StorageFull` (ein eigener, abfangbarer Fehler statt Absturz oder allgemeinem Fehler); die letzte vollständig geschriebene Partition bleibt erhalten, der Lauf kann nach Platzschaffen fortgesetzt werden. Vorab prüfen lässt es sich mit `SyncEngine::plan_static_bootstrap(token) -> BootstrapPlan { partitions_total, partitions_pending, bytes_total, bytes_pending }` — holt nur das Manifest (wenige KB) und sagt, wie viel noch zu laden ist, bevor irgendetwas übertragen wird.
- **Fortschritt:** `SyncEngine::with_observer(Arc<dyn SyncObserver>)` meldet nach jeder Partition `BootstrapProgress { partitions_total, partitions_done, bytes_total, bytes_done }`. `SyncEngine::sync_static_data(token)` führt nur den statischen Teil aus (der reguläre `sync` ruft ihn ebenfalls).
- **Messwerkzeug:** `core/examples/measure_bootstrap.rs` — misst gegen einen echten Server (`--server URL --client-id … --client-secret …`) oder gegen synthetische, an die echte Bayern-Form angelehnte Daten (`--synthetic-segments N`): übertragene Bytes, gzip-Schätzung, Dauer (Transport vs. Verarbeitung), Datenbankgröße, Speicherspitze des Prozesses, Zeit bis zur ersten Abfrage, Latenzverteilung der Ortsabfragen nach Neustart. Ein Windows-Build liegt als Artefakt des Workflows `client-lib-bench.yml` (siehe unten).

## Öffentliche API, C-ABI, erstes Binding (Zusatz F-C4, angefangen)

`core/src/api/` ist die eine öffentliche Fassade, die jedes Binding freigibt: `TrafficNetworkClient` (Rust) bzw. `call(methode, argumenteJson) -> ergebnisJson` (jedes andere Binding) über `bindings/c-abi/src/client.rs`s C-ABI (`tn_client_new`/`tn_client_call`/`tn_client_call_async`/`tn_client_free`, plus `tn_client_new_with_secure_store` für einen App-eigenen sicheren Speicher und `tn_client_set_event_callback`). Vollständige Methodenreferenz: [`docs/api.md`](docs/api.md).

- **Init-Optionen** (`ClientOptions`): `nodes`/`discovery`/`seeds` wie im F-C0-Plan skizziert, dazu `networkRootKey` (Netzwerk-Konfiguration nur mit Schlüssel verifizierbar, ohne Schlüssel wird sie ignoriert — nie blind vertraut), `credentials` (fertiges `client`-Credential oder App-Schlüssel, der das Gerät beim ersten Gebrauch selbst registriert und das Ergebnis in den sicheren Speicher legt), `cameraNamespaceEnabled`, `syncIntervalSeconds`.
- **Lesend, nie netzwerkgebunden:** `getSpeedLimitAt`/`getNearby` beantworten sich ausschließlich aus dem lokalen Speicher (Sub-Millisekunde, siehe `bootstrap-measurements.md`); `getNearby` dedupliziert dieselbe Meldung von zwei Servern (unterschiedliche Zeilen-IDs) und zeigt eigene, noch nicht gesendete Meldungen sofort (`pending: true`).
- **Schreibend:** `submitReport`/`confirmReport`/`reportCameraRemoved` reihen nur ein; `reportWrongSpeedLimit`/`confirmSpeedLimitCorrection` nutzen dieselbe Überlagerung wie K-C. Gesendet wird ausschließlich durch `sync()`/`tick()` — nichts läuft von selbst.
- **Blitzer-Namensraum:** dreifaches Ja (Server-Flag **und** verifizierte Netzwerk-Konfiguration **und** `cameraNamespaceEnabled` der Host-App) — die Netzwerk-Konfiguration kann nur einschränken, nie freigeben.
- **`sync()`** trennt den statischen vom dynamischen Teil (ein unterbrochener Grundstock-Download blockiert nie frische Meldungen) und lässt einen ausgefallenen Pool-Server die anderen nicht aufhalten; scheitert nur bei fehlenden Zugangsdaten, keinem erreichbaren Server oder vollem Speicher (`storageFull`) — jeder Teilfehler steht im zurückgegebenen `SyncReport`, wird nicht geworfen.
- **Gefundene und behobene Lücken in F-C2 beim Aufbau der Fassade:** ein Verzeichnis nennt nur die *anderen* Knoten, nie sich selbst — ein Kaltstart mit nur einem Seed landete deshalb mit leerem Pool; jetzt trägt sich der antwortende Server selbst ein. Und: geriet der (einzige) Server in Backoff, blieb der Pool leer und nichts wurde je wieder versucht — jetzt wird bei leerem Pool der Server mit der nächsten Erholungszeit trotzdem versucht.
- **Erstes Binding:** `bindings/python/` (reines `ctypes`, keine Abhängigkeiten). **Konformität:** `client-lib/conformance/` — ein Satz Szenarien (`scenarios.json`) gegen einen geskripteten Server (`mock-server.mjs`, echtes Ed25519/RFC 8785, unabhängig vom echten Server-Code), aktuell mit einem Python-Runner, CI-Job `conformance-python`.
- **Bewusst noch offen** (siehe Meilensteine): WASM/Browser-Speicher, Node/Dart/Kotlin/Swift-Wrapper samt eigener Konformitätsläufe, React-Native-Modul, Android-AAR/iOS-XCFramework-Paketierung, eine WebSocket-Standardimplementierung (nur der Protokolltreiber aus F-C3 existiert), Mehrknoten-Integrationstests gegen echte Server (F-C5).

## Bauen & Testen

Rust ist auf der Entwicklungsmaschine dieser Session nicht installiert — Verifikation ausschließlich über `.github/workflows/client-lib-ci.yml` (native build+test+clippy+fmt als eigener Job, `wasm32-unknown-unknown`-Build, Cross-Language-Krypto-Vektor, cbindgen-Header-Generierung, `conformance-python` gegen den geskripteten Server). Mit lokalem Rust: `cargo build --workspace`, `cargo test --workspace` in `client-lib/`.

## Meilensteine

| # | Inhalt | Status |
|---|---|---|
| F-C0 | Stand geprüft, Entscheidungen (Server-Auswahl, Failover, Sync beim Serverwechsel, Stichproben-Prüfung, Verzeichnis-Cache), Architektur-Skizze, Plan | ✅ |
| F-C1 | Kryptografie im Kern + gerätesignierte Datenstrukturen, Cargo-Workspace, C-ABI-Skelett, CI-Matrix | ✅ |
| F-C2 | Discovery-Modul + Mehrserver-Transport-Pool + Failover | ✅ |
| F-C3 | Sync-Engine (Bootstrap/Delta/Pakete/WebSocket, pro-Server-Cursor), Offline-Schreibpuffer, Map-Matching, Verfallsberechnung, Stichproben-Prüfung | ✅ |
| F-C4 | Öffentliche API + C-ABI + Python-Binding + Konformitätsrahmen fertig; **WASM, Node, Dart, Kotlin, Swift, React Native, Paketierung offen** | 🟡 |
| F-C5 | Mehrknoten-Integrationstests grün, Doku, Pull Request — **Abschluss** | |
