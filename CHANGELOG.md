# Changelog

Versionierung je Paket, kein gemeinsames Release-Datum oder gemeinsame Versionsnummer: `server/` (inklusive der eingebauten Weboberfläche), `ingestion/` und `client-lib/` folgen SemVer eigenständig.

## client-lib v1.0.0 — 2026-10-03

Erster stabiler Release der Client-Bibliothek: **ein Rust-Kern, dünne Anbindungen, überall gleiches Verhalten** — an einem gemeinsamen Szenariensatz über sechs Anbindungen gemessen, nicht angenommen. Die öffentliche API (`call(methode, argumenteJson)`, Methodenreferenz in [`client-lib/docs/api.md`](client-lib/docs/api.md)) folgt ab jetzt SemVer: `apiVersion` steigt nur bei einer inkompatiblen Änderung einer Methode oder eines Ergebnisformats.

**Kern:** Kryptografie (Ed25519, RFC-8785-kanonisches JSON, gegen den Server verifiziert), Server-Discovery mit Mehrserver-Failover, Sync-Engine (Snapshot-Bootstrap, Delta-Pull, inhaltsadressierte Statikdaten-Pakete, echter WebSocket-Push mit Wiederverbindung und Lückenschluss), Offline-Schreibpuffer, lokales Map-Matching, Verfallsberechnung, Stichproben-Prüfung gegen zurückgehaltene Daten, Tempolimit-Korrekturen, „aktuell online"-Anzeige; SQLite mit R\*Tree auf nativen Plattformen, IndexedDB im Browser. Gegen ein echtes Mehrknoten-Testnetz verifiziert (Kaltstart, Serverausfall mitten im Sync, Duplikate über zwei Server, bösartige Antworten).

**Anbindungen** — jede mit Integrationsanleitung und Minimalbeispiel in `client-lib/docs/`, das in CI gebaut bzw. ausgeführt wird:

| Plattform | Anbindung | in CI |
|---|---|---|
| C-ABI | `libtrafficnetwork` (Linux, macOS universal, Windows) | gebaut, getestet, Beispiel ausgeführt — alle drei Systeme |
| Python | `ctypes`-Wrapper über das C-ABI | Konformität + Beispiel — Linux, macOS, Windows |
| Node.js | `koffi` über das C-ABI, TypeScript-Typen | Konformität + Beispiel, als Tarball aus leerem Projekt |
| Browser | WebAssembly (`wasm-bindgen`), Speicher in IndexedDB, TypeScript-Typen | Konformität in Headless-Chrome + Beispielseite, als Tarball aus leerem Projekt |
| Android | Kotlin über UniFFI, AAR (4 ABIs) | Konformität (JVM), AAR + Beispiel-App gebaut |
| iOS / macOS | Swift über UniFFI, XCFramework (iOS Gerät/Simulator, macOS) | Konformität (macOS), für iOS-Gerät und -Simulator gebaut |
| Flutter / Dart | `flutter_rust_bridge`; Plugin mit gebündelter Bibliothek | Konformität (Dart-VM); frisch erzeugte Flutter-Apps für Android und iOS gebaut; **App läuft auf einem Android-Emulator** |
| React Native | `uniffi-bindgen-react-native` aus demselben UniFFI-Crate | Bibliothek + Beispiel-App für Android und iOS gebaut |

**Konformität:** derselbe Szenariensatz (`client-lib/conformance/scenarios.json`, 9 Szenarien, geskripteter Server mit echtem Ed25519/RFC 8785, unabhängig vom echten Server-Code) läuft mit gleichem Ergebnis über Python (drei Betriebssysteme), Node.js, WebAssembly, Kotlin, Swift und Dart; Kotlin, Swift und Dart über je eine kleine Brücke, die der **eine** Szenarien-Runner antreibt — die Szenarien werden nicht pro Sprache neu geschrieben. Jede Brücke läuft auch mit einem vom Host implementierten `SecureStore`. Keine Abweichung zwischen den Anbindungen gefunden; plattformbedingte Unterschiede (Speicher im Browser, Geheimnisse, Hintergrund) stehen in den Anleitungen.

**Unterwegs gefunden und behoben:**
- **TLS auf Android:** reqwest 0.13 prüft Zertifikate standardmäßig mit dem Plattform-Verifier, der auf Android nur mit Handarbeit in jeder App funktioniert — ein AAR ohne Zusatz-Setup wäre auf Android nicht benutzbar gewesen. Der HTTP-Transport vertraut jetzt den eingebauten Mozilla-Wurzeln (der WebSocket-Transport tat es schon). Preis: ein Server mit privater CA wird nicht vertraut.
- Aufrufe laufen auf Threads der Bibliothek mit 8-MiB-Stack, nicht auf denen des Hosts (Android-/JVM-/macOS-Threads haben 0,5–1 MiB) — vorher ein SIGSEGV im Node-Lauf.
- `libc` 0.2.190 bricht `backtrace` (Abhängigkeit von `flutter_rust_bridge`) auf iOS; gehalten unter 0.2.190, mit Begründung im Manifest.
- `initialize()` des Dart-Pakets war nicht idempotent (vom Emulator-Lauf gefunden).
- Ergebnis-Umschlag, `call_json` und `open_native` liegen einmal im Kern statt je Anbindung.

**Bekannt offen, kein Grund gegen dieses 1.0 (siehe [`docs/todo.md`](docs/todo.md)):**
- *Ausgeführt* wird nur die Flutter-App auf einem Android-Emulator; Kotlin/Android, Swift/iOS und React Native werden gebaut und gelinkt (Konformität: JVM/macOS), aber nicht auf Gerät, Emulator oder iOS-Simulator ausgeführt; das erzeugte React-Native-JSI-Zwischenstück läuft in keinem Test. Flutter auf iOS: gebaut, nicht ausgeführt.
- Alle Tests laufen gegen `http://`-Mocks: ein echter TLS-Handshake gegen einen Server ist nirgends getestet.
- Browser-Grenzen (Persistenz hinkt dem Speicher hinterher, ganzer Speicher im RAM, ein Tab je Datenbank, Geheimnisse in `localStorage`, keine Hintergrund-Synchronisation) stehen offen in `client-lib/docs/integration-web.md`.
- Nichts ist in einer Registry veröffentlicht (npm, Maven, pub.dev, CocoaPods): die Pakete sind `"private"` bzw. `publish_to: none`; ein Release hängt die Artefakte mit Prüfsummen an ein GitHub-Release (`client-lib-v*`, `release.yml`), das Auslösen ist eine eigene Entscheidung.
- Das Flutter-Plugin bündelt die Bibliothek für Android und iOS, nicht für Desktop; React Native folgt dem neuesten React Native und einem jungen Generator (alle Werkzeugversionen festgenagelt).

## server v1.0.0 — 2026-09-28

Erster stabiler Release: self-hostbarer Relay-/Moderator-Server mit Föderation, eingebauter Weboberfläche und optionalen Zusatzfunktionen. Vollständig unabhängig geprüft, siehe [`docs/audit.md`](docs/audit.md).

**Kern (Phase 1):** Ereignisprotokoll, Snapshot-/Delta-Sync, Moderationsgate, Blitzer-Namensraum (standardmäßig aus), Client-Credential-Auth, Bulk-Import, WebSocket-Push.

**Self-Hosting & Föderation:** Docker-Image (Multi-Arch amd64+arm64) und Installation ohne Docker (Apache/nginx/Caddy); offene Mitgliedschaft mit Reputation, signierte Peer-Daten, Server-Verzeichnis, geräteseitig signierte Auth als additive Alternative zum gemeinsamen `JWT_SECRET`; echtes Mehrknoten-Testnetz in CI.

**Eingebaute Weboberfläche:** Karte mit Live-Meldungen, Tempolimit per Klick/als Straßenfarben, Melden und Bestätigen, Seiten „Verbinden" und „Über das Projekt", Deutsch/Englisch, mobil und tastaturbedienbar, abschaltbar (`WEB_UI_ENABLED=false`).

**Weitere Zusatzfunktionen:**
- „Aktuell online"-Anzeige (`GET /v1/stats/online`), datensparsam (keine IP/Position gespeichert)
- Community-Korrekturen falscher Tempolimits — Vorschlagen/Bestätigen/Widersprechen, überlagert den Import, ändert ihn nie
- Europa-Maßstab: vorgebaute, inhaltsadressierte, komprimierte Statikdaten-Pakete statt Berechnung pro Anfrage
- Dauerhafte Überwachungsanlagen (Rotlicht-/Abstandskontrolle) als additive Erweiterung der bestehenden Blitzer-Tabelle
- Performance: räumlicher Index statt Sequential Scan für Tempolimit-/Umgebungsabfragen (≈ 40× schneller gemessen)

**Zwei Fehler behoben**, die zunächst nur clientseitig toleriert wurden, nicht an der Wurzel: Zeitstempel-Felder (`reportedAt`/`expiresAt`/`occurredAt`) kamen bei Roh-SQL-Lesepfaden als Postgres-eigenes `timestamptz`-Textformat statt dem dokumentierten RFC 3339 zurück; `sequence`/`snapshotSequence`/`nextSince` kamen als JSON-*String* statt Zahl zurück. Beide durch eigene Postgres-Parser für die betroffenen zwei Spaltentypen behoben (`server/src/db/raw-sql-types.ts`), nicht durch Nacharbeit an jeder einzelnen Abfragestelle.

**Bekannt offen, kein Grund gegen dieses 1.0 (siehe [`docs/todo.md`](docs/todo.md), [`docs/audit.md`](docs/audit.md) Abschnitt 10):** `docs/privacy.md` ist ein Entwurf ohne rechtliche Prüfung; Betreiberbedingungen für fremde Knoten fehlen; der Blitzer-Namensraum bleibt bis zur rechtlichen Prüfung aus; die Autobahn-API-Lizenz ist ungeklärt (Quelle bleibt abgeschaltet). Alles Betreiber-/Rechtsfragen, keine Code-Mängel.

## ingestion v0.2.0 — 2026-09-28

**Bewusst kein `1.0.0`:** Das Paket ist ein optionaler, austauschbarer Client gegen die öffentliche Bulk-Import-API, kein Kernbestandteil. Der Quellenkatalog ist noch in Bewegung (mehrere Quellen mangels geklärter Lizenz abgeschaltet), ein wiederkehrender Aktualisierungslauf ist bewusst nicht Teil dieses Stands — eine `1.0` wäre ein Stabilitätsversprechen, das dieses Paket noch nicht geben will.

- OSM-Bulk-Import, regionsparametrisiert, mit Wiederaufnahme nach Abbruch und `DE:*`-Sonderfällen für implizite Tempolimits
- Europa-Grundstock einmalig importiert (13,68 Mio. Zeilen, Bericht in `ingestion/docs/europe-run-report.md`)
- Quellenkatalog: Baustellen (DATEX II v2/v3, Autobahn-JSON), amtliche Verkehrszeichen (NVDB Norwegen)
- Qualitätsbericht (`npm run report:quality`), vollständige Quellen-Attribution
- HERE/TomTom/Mobilithek katalogisiert, standardmäßig abgeschaltet (keine Zugänge bzw. keine Lizenzentscheidung)
