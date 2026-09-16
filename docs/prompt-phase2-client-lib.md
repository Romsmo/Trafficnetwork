# Prompt für Claude Code — Phase 2: Client-Sync-Bibliothek (+ nötige Server-Erweiterungen)

> **Scope dieses Prompts:** Das Paket `client-lib/` im Monorepo `https://github.com/Romsmo/Trafficnetwork` (privat, Owner: Romsmo) — plus **eng begrenzte** Erweiterungen in `server/` (Meilenstein P2.0, siehe Abschnitt 4), ohne die die Bibliothek nicht sinnvoll funktioniert. Phase 1 (`server/`) ist abgeschlossen; maßgebliche Referenzen: `docs/concept.md` (Abschnitt 6), `server/README.md`, `server/docs/api.md`, `server/docs/schema.md`. **Lies alle vier vollständig, bevor du planst.**
>
> **Nicht Teil dieses Prompts:** `ingestion/` (Phase 3), Flutter-App, ESP32-Firmware. Die Bibliothek darf nie annehmen, dass ein Ingestion-Programm existiert oder je gelaufen ist — ein leerer Server ist ein gültiger Zustand (Test!).

---

## 0. SETUP — REPO SELBST KLONEN

Stelle das Repo **selbstständig** bereit, bevor du irgendetwas anderes tust (vom Plan-Modus ausgenommen):

1. Prüfe, ob du bereits in einem Klon von `Romsmo/Trafficnetwork` bist (`git remote -v`). Falls ja: `git checkout main && git pull`, weiter mit Schritt 4.
2. Falls nicht: `git clone https://github.com/Romsmo/Trafficnetwork.git` (alternativ `gh repo clone Romsmo/Trafficnetwork` oder SSH `git@github.com:Romsmo/Trafficnetwork.git`), dann `cd Trafficnetwork`.
3. Das Repo ist **privat**. Schlägt der Clone mangels Authentifizierung fehl: zeig mir die Fehlermeldung und nenne die Optionen (`gh auth login`, SSH-Key, PAT über Credential-Helper). Frag nie nach Passwörtern/Tokens im Chat, lege keine Zugangsdaten in Dateien ab.
4. Prüfe die erwartete Struktur (`docs/concept.md`, `docs/todo.md`, `server/` mit `docs/api.md`, `client-lib/`, `ingestion/`, `.github/workflows/`). Fehlt etwas, melde es mir.
5. Prüfe, ob der letzte CI-Lauf von `server-ci` grün ist (`gh run list` o. Ä.). Falls rot: zuerst mir melden, nicht auf kaputter Basis weiterbauen.
6. Alle Commits gehen in diesen Klon und werden nach jedem Meilenstein nach `origin` gepusht.

---

## ROLLE & ARBEITSWEISE

Du baust eine **einbettbare, maximal portable Client-Sync-Bibliothek**: einen Adapter, den beliebige Apps (native Mobile, Cross-Platform, Desktop, Server, Browser) einbinden, um das Verkehrsdaten-Netzwerk **lokal und offline** zu nutzen. Die Host-App fragt ausschließlich die lokale Bibliothek ab (`getSpeedLimitAt`, `getNearby`, …) — nie direkt den Server. Die Bibliothek kümmert sich selbst um Speicherung, Synchronisation, Push-Empfang und Offline-Puffer.

Arbeitsregeln:

1. **Erst planen, dann bauen.** Plan-Modus zuerst: Doku lesen, Abschnitt 2 recherchieren und entscheiden, Plan + Meilensteine vorlegen, auf Freigabe warten.
2. **Bei offenen Fragen: frag mich** — konkrete Optionen mit Empfehlung.
3. **Nichts erfinden.** Bibliotheks-/Toolchain-Fähigkeiten (z. B. ob SpatiaLite unter WASM/iOS verfügbar ist, Binding-Generator-Unterstützung) mit Beleg (Link/Datum) dokumentieren.
4. **Inkrementell und grün.** Nach jedem Meilenstein: Build + Tests grün (auch in CI), Commit + Push, `client-lib/README.md` aktualisieren, kurze Zusammenfassung an mich.
5. **Sprache:** Code, Kommentare, Commits, README, Doku auf Englisch. Rückfragen an mich auf Deutsch.
6. **Server-Änderungen nur im Rahmen von P2.0** (Abschnitt 4), rückwärtskompatibel oder sauber versioniert, mit Tests und aktualisierter `server/docs/api.md` / `schema.md`. Keine Änderung an bestehender Server-Semantik ohne Rückfrage.

---

## 1. ANFORDERUNG „MAXIMAL KOMPATIBEL" (verbindlich)

Die Bibliothek muss als Adapter auf **allen** folgenden Zielen einsetzbar sein:

| Ziel | Mindestens |
|---|---|
| Android | Kotlin/Java-Binding (AAR) |
| iOS (+ macOS) | Swift-Binding (XCFramework / Swift Package) |
| Flutter | Dart-Package |
| React Native | JS/TS-Modul (Turbo/Native Module) |
| Desktop/Server | stabile **C-ABI** (Header + shared/static lib) für Windows, macOS, Linux; darauf aufbauend mind. Python und Node.js; .NET optional über die C-ABI |
| Web-Browser | WebAssembly-Build mit TS-Typen (Einschränkungen erlaubt, aber dokumentiert) |

Daraus folgt:

- **Ein gemeinsamer, plattformunabhängiger Kern** (Speicher, Sync, Map-Matching, Verfall, Offline-Puffer) — **keine** Logik-Duplikate pro Plattform. Bindings sind dünn.
- **Kein UI, kein Hintergrund-Scheduling im Kern.** Plattformspezifisches (Hintergrundausführung, Netzwerkstatus, Standort) liefert die Host-App über klar definierte Callbacks/Interfaces hinein bzw. die Bibliothek bietet `tick()`/`sync()`-Aufrufe an, die die Host-App zu ihren Bedingungen auslöst.
- **Transport austauschbar:** Standard-HTTP/WebSocket-Implementierung im Kern, aber per Interface ersetzbar (z. B. wenn eine Host-App einen eigenen HTTP-Stack/Proxy nutzen muss oder im Browser `fetch`/`WebSocket` verwendet werden müssen).
- **Speicher austauschbar hinter einem Interface**, damit der Browser-Build ein anderes Backend nutzen kann (z. B. SQLite-WASM mit OPFS), ohne den Rest zu verändern.
- **Stabile, versionierte öffentliche API** (SemVer), gleiche Semantik über alle Bindings, ein gemeinsamer Satz Konformitätstests, der gegen mehrere Bindings läuft.
- **Kleine Abhängigkeitsfläche**, permissive Lizenzen kompatibel zu Apache 2.0 (jede Abhängigkeit mit Lizenz dokumentieren).
- **Datenschutz by design:** Standort verlässt das Gerät nur in Form von H3-Tile-IDs (Subscriptions) und bei aktiven Meldungen; keine Telemetrie.

---

## 2. OFFENE ENTSCHEIDUNGEN, DIE DU TRIFFST (mit Begründung + Beleg im Plan)

1. **Kernsprache + Binding-Toolchain** (z. B. Rust + UniFFI/flutter_rust_bridge/wasm-bindgen + cbindgen, Kotlin Multiplatform, C++ mit SWIG/djinni, …). Kriterium ist Abschnitt 1 — alle sechs Ziele müssen realistisch abgedeckt sein.
2. **Lokaler Speicher / Geo-Index**: `docs/concept.md` nennt SQLite + SpatiaLite. Prüfe, ob SpatiaLite auf **allen** Zielen (insb. iOS, WASM) praktikabel ist. Wenn nicht: begründete Alternative (z. B. SQLite + R*Tree-Modul + H3 + eigene Geometrie-Routinen) — einheitlich über alle Ziele bevorzugt.
3. **Map-Matching-Verfahren** für `getSpeedLimitAt` (leichtgewichtig, offline, optional mit Fahrtrichtung/Heading und Positionshistorie zur Stabilisierung).
4. **Umfang des Web-Builds** (welche Features voll, welche eingeschränkt) und Speicherbudget-Strategie im Browser.
5. **Paketierung/Distribution** pro Ziel (Maven/AAR, SwiftPM, pub.dev, npm, PyPI, …) — Veröffentlichung selbst erst nach meiner Freigabe; Build-Artefakte in CI reichen.
6. **Regionale Subscription-Strategie**: Tile-Radius `k` abhängig von Geschwindigkeit/Route, Hysterese beim Tile-Wechsel.

---

## 3. FUNKTIONSUMFANG DER BIBLIOTHEK

### 3.1 Lokaler Speicher
Spiegel des Server-Datenmodells (`server/docs/schema.md`): `SpeedLimitSegment`, `StaticSign`, `FixedSpeedCamera`, `HazardReport` inkl. Provenienz-Feldern (`source`, `sourceLicense`, `importedAt`). Schema-Migrationen für künftige Bibliotheksversionen. Speicher-Verzeichnis/Datei gibt die Host-App vor.

### 3.2 Sync-Engine
- **Bootstrap**: statische Daten über den (in P2.0 erweiterten) Paket-/Kachel-Mechanismus laden, dynamische Daten per `/v1/snapshot?tiles=…`.
- **Delta**: `/v1/delta?since=…` mit Pagination (`nextSince`/`hasMore`); bei **409 `SNAPSHOT_REQUIRED`** automatischer Fallback auf Snapshot.
- **Push**: WebSocket `/v1/ws` (Auth per erster Nachricht, `subscribe`/`unsubscribe` auf H3-Res-7-Tiles mit `k`), automatische Reconnects mit Backoff; nach Reconnect Lücke per Delta schließen.
- Einspielen immer **transaktional**, idempotent (Sequenznummern), robust gegen doppelte/umsortierte Events.
- **Statische Aktualisierungen erkennen** über die Versionsinformation aus P2.0 und nur geänderte Teile nachladen.
- Token-Handling: Token holen/erneuern (siehe P2.0 Geräteregistrierung), Secrets nur im von der Host-App bereitgestellten sicheren Speicher (Interface), nie im Klartext in der DB.

### 3.3 Lokale Logik
- **Map-Matching** (`getSpeedLimitAt`), Einheit wie gespeichert (`kmh`/`mph`), nicht umrechnen.
- **Verfallsberechnung** lokal aus Zeitstempeln + Regeln. Die Regeln (Grundverfallszeiten, Verlängerung) dürfen nicht hart von Server-Env-Werten abweichen: Wenn der Server sie nicht ausliefert, in P2.0 einen Konfigurations-Endpunkt ergänzen (z. B. `GET /v1/config`), den die Bibliothek cached.
- **Blitzer-Namensraum**: Die Bibliothek zeigt Blitzer-Daten nur, wenn der Server sie liefert (Server-Flag) **und** die Host-App sie nicht per Option deaktiviert hat (Standard der Option: aus). Isoliert im Code wie auf dem Server.

### 3.4 Offline-Schreibpuffer
`submitReport`/`confirmReport`/Blitzer-Entfernungsmeldung werden lokal sofort optimistisch übernommen, persistent gepuffert, bei Verbindung in Reihenfolge gesendet. Reconciliation mit der Server-Antwort (`merged`, `recorded`, 429 → Backoff, 4xx → verwerfen + Status an Host melden). Lokale IDs ↔ Server-IDs sauber abbilden.

### 3.5 Öffentliche API (Skizze, final im Plan)
```
init(config: { baseUrl, storagePath, appKey, options... }, platform: { secureStore, httpTransport?, clock?, logger? })
getSpeedLimitAt(position, heading?) -> { value, unit, segmentId, confidence } | null
getNearby(position, radiusM, categories[]) -> Item[]        // Hazards, Schilder, (Blitzer nur wenn erlaubt)
submitReport(type, position, speedKmh?) -> localReportId
confirmReport(reportId, stillThere: bool)
reportCameraRemoved(cameraId)
updatePosition(position, speedKmh?, heading?)                // steuert Tile-Subscriptions
sync() / tick()                                              // von der Host-App ausgelöst
getSyncStatus() -> { lastSyncedAt, pendingWrites, subscribedTiles[], staticDataVersion, connection }
onEvent(listener)                                            // Änderungen für UI/Warnungen
close()
```
Alle Aufrufe threadsicher; asynchron dort, wo die Zielplattform das erwartet (Futures/Promises/suspend/async).

---

## 4. MEILENSTEIN P2.0 — SERVER-ERWEITERUNGEN (vor der Bibliothek)

Nötig, weil die Phase-1-API zwei Lücken für Local-First-Clients hat. Umsetzung in `server/`, getestet, dokumentiert, CI grün.

1. **Anonyme Geräteregistrierung** (Entscheidung von mir getroffen):
   - Neuer Endpunkt (z. B. `POST /v1/devices/register`), der mit einem **App-Schlüssel** (pro einbindender App, per `create-client` o. Ä. provisioniert, eigener Scope z. B. `device-registration`) ein **pseudonymes Geräte-Credential** ausstellt → daraus Tokens mit eigener Reporter-ID pro Gerät.
   - Rate-Limit und Missbrauchsschutz auf der Registrierung (pro App-Schlüssel und IP), App-Schlüssel widerrufbar, Geräte-Credentials widerrufbar.
   - Keine personenbezogenen Daten bei der Registrierung (DSGVO, `docs/privacy.md` folgt).
   - Bestehende Client-Credentials (`client`, `bulk-import`) bleiben unverändert funktionsfähig.
2. **Skalierbare Auslieferung statischer Daten**:
   - `/v1/snapshot` liefert statische Daten aktuell vollständig in einer JSON-Antwort — für Europa (mehrere GB) nicht tragfähig. Ergänze eine **partitionierte, versionierte** Auslieferung (z. B. statische Daten nach grober H3-Auflösung oder Region in Pakete geteilt, pro Paket Version/Hash, komprimiert, ggf. als vorab erzeugte Dateien/CDN-fähig), plus einen Manifest-Endpunkt, über den Clients geänderte Pakete erkennen.
   - Bulk-Importe erzeugen bewusst keine Events — daher muss die Paketversion bei Bulk-Import (und bei `StaticDataUpdated`/`Removed`) zuverlässig steigen.
   - Bestehendes `/v1/snapshot`-Verhalten nicht brechen (ggf. Parameter, um statische Daten auszulassen).
3. **Konfigurations-Endpunkt** (falls nötig, siehe 3.3): Verfallsregeln, Tile-Auflösung, Blitzer-Flag-Status, Limits — damit Client und Server nie auseinanderlaufen.

Wenn du beim Planen weitere Lücken findest, die die Bibliothek blockieren: auflisten und mich fragen, nicht eigenmächtig erweitern.

---

## 5. TESTS & CI

- Unit-Tests im Kern (Map-Matching, Verfall, Tile-Logik, Reconciliation, Migrations).
- Integrationstests gegen einen **echten Server aus `server/`** (in CI, Docker/Testcontainers wie in `server-ci`), inkl.: leerer Server, Bootstrap → Delta → Push, 409-Fallback, Offline-Puffer über Verbindungsabbruch, Geräteregistrierung, Paket-Update nach Bulk-Import, Blitzer-Flag an/aus.
- **Konformitätstests über Bindings**: derselbe Szenario-Satz mindestens gegen C-ABI, eine Mobile-Plattform-Binding (auf CI-fähigem Runner) und WASM.
- Eigener CI-Workflow (`.github/workflows/client-lib-ci.yml`) mit Build-Matrix für die Zielplattformen (soweit auf GitHub-Runnern möglich; Nicht-Mögliches dokumentieren).

---

## 6. NICHT-ZIELE

- Keine Host-App/UI, keine Flutter-App, keine ESP32-Firmware.
- Kein Ingestion-Code.
- Keine Veröffentlichung in öffentlichen Paket-Registries ohne meine Freigabe.
- Keine Vertiefung der Reputationslogik.
- Kein Aktivieren des Blitzer-Flags auf dem Server.

---

## 7. MEILENSTEINE

| # | Inhalt |
|---|---|
| P2.0 | Server-Erweiterungen: Geräteregistrierung, partitionierte/versionierte statische Daten + Manifest, ggf. Config-Endpunkt — getestet, dokumentiert |
| P2.1 | Kern-Grundgerüst + Toolchain, lokaler Speicher + Migrationen, C-ABI-Skelett, CI-Matrix läuft |
| P2.2 | Sync-Engine: Registrierung/Token, Bootstrap, Delta (inkl. 409-Fallback), WebSocket-Push, regionale Subscription, statische Paket-Updates |
| P2.3 | Lokale Logik: Map-Matching, Verfall, Blitzer-Isolation; Offline-Schreibpuffer + Reconciliation |
| P2.4 | Bindings: Kotlin, Swift, Dart, React Native, Python, Node, WASM/TS — dünn, mit Konformitätstests |
| P2.5 | Öffentliche API + Doku (`client-lib/docs/api.md`, Integrations-Guide pro Plattform, Beispiel-Minimal-Integration je Plattform), vollständige Testsuite grün — **Phase-2-Abschluss** |

Nach jedem Meilenstein: `client-lib/README.md` aktualisieren, `docs/todo.md` abhaken, Commit + Push, kurze Zusammenfassung an mich.

---

## 8. WAS ICH VON DIR ERWARTE, BEVOR DU CODE SCHREIBST

1. Bestätigung, dass du `docs/concept.md`, `server/README.md`, `server/docs/api.md`, `server/docs/schema.md` gelesen hast, plus Widersprüche/Lücken, die dir auffallen.
2. Deine Entscheidungen zu Abschnitt 2, jeweils mit Begründung und Beleg.
3. Entwurf der P2.0-Server-Erweiterungen (Endpunkte, Schemaänderungen, Kompatibilität).
4. Architektur-Skizze des Kerns (Module, Interfaces für Plattform-Callbacks, Speicherschema).
5. Finale öffentliche API-Skizze und Binding-Strategie pro Plattform.
6. **Deine Liste offener Fragen an mich.**
