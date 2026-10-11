# Changelog

Versionierung je Paket, kein gemeinsames Release-Datum oder gemeinsame Versionsnummer: `server/` (inklusive der eingebauten Weboberfläche), `ingestion/` und `client-lib/` folgen SemVer eigenständig.

## server — Unreleased (1.1.0)

Rein additiv: `apiVersion`, bestehende Endpunkte und Ergebnisformate ändern sich nicht; ältere Clients und Knoten funktionieren weiter. Keine Datenbankmigration.

- **Verfallszeiten:** mobiler Blitzer **3 Stunden** (vorher 12 Minuten), Anhänger (`trailerCamera`) **14 Tage** mit eigenem Wert statt des kurzen Bands. Alle anderen Typen unverändert. Bereits aktive Meldungen behalten ihr Ende; nur neue oder bestätigte Meldungen nutzen die neuen Werte.
- **Eigene Ablaufzeit:** `POST /v1/hazard-reports` nimmt optional `expiresInSeconds`. Grenzen je Typ stehen in `GET /v1/config` → `reportExpiry`; außerhalb wird **abgelehnt** (`400 EXPIRY_OUT_OF_RANGE` mit Standard, Minimum, Maximum), nicht still gekappt. Das Feld ist Teil des gerätesignierten Inhalts (`DeviceCreateEvent.expiresInSeconds`), nicht für feste Blitzer.
- **Gleiches Ende auf jedem Knoten:** `expiresAt = signierter Zeitstempel + Dauer`. Bisher zählte bei föderierten Meldungen die Ankunftszeit am jeweiligen Knoten und die lokale Env — Knoten wichen ab. Eine föderierte Meldung, deren eigene Laufzeit schon vorbei ist, wird abgelehnt (`stale_timestamp`, ohne Reputationsstrafe), statt mit frischer Laufzeit aufzuleben.
- **Eine Quelle der Wahrheit:** signierte Netzwerk-Konfiguration (neues optionales Feld `reportExpiry`) → `REPORT_EXPIRY_OVERRIDES` → `HAZARD_EXPIRY_*` → eingebaute Tabelle. Neu: `npm run network:sign-config -- … --report-expiry '<json>'`. Eine unlesbare Angabe stoppt den Knoten. Ohne signierte Konfiguration muss **nichts** neu signiert werden.
- **Bestätigung verkürzt nie:** „noch da" setzt auf `max(bisher, jetzt + Standard)`; ein Zusammenführen in 500 m nimmt das spätere Ende.
- **„Nicht mehr da" beendet temporäre Kameras vorzeitig:** mobil, Anhänger, Rotlicht- und Abstandsmeldung enden, sobald `HAZARD_GONE_THRESHOLD_CAMERA` (Standard 2) verschiedene Geräte „gone" melden und es mindestens so viele sind wie die, die „noch da" sagten (Melder eingerechnet). Status `expired`, Ereignis `ReportExpired` — nichts Neues für Clients. Stimmen bleiben knotenlokal.
- **Achtung beim Update:** `.env`-Dateien, die aus der alten `.env.example` kopiert wurden, enthalten `HAZARD_EXPIRY_SHORT_MINUTES=12`. Das gilt jetzt nur noch für Rotlicht-/Abstandsmeldungen (und lässt die 3 h/14 d unberührt); die Vorlage hat die Zeile auskommentiert. Alle Knoten eines Netzes aktualisieren, bevor man sich auf Dauern verlässt: ein Knoten < 1.1.0 ignoriert das Feld.
- Doku: [`server/docs/report-expiry.md`](server/docs/report-expiry.md), `api.md`, `federation-protocol.md` (4.4b, 5), `operating.md`, `docs/concept.md` 3.2.

## client-lib v1.1.0 — 2026-10-04

**Blitzer nach Land** (Teil C des Zusatzauftrags „Blitzer-Funktion aktivierbar machen — länderabhängig“; Teil A ist der Server, Teil B die Weboberfläche). Rein additiv: `apiVersion` bleibt `1`, bestehende Aufrufe und Ergebnisse ändern sich nicht.

- **Politik übernommen und eingehalten:** `GET /v1/config` liefert je Land eine Stufe — `full` (Einzelstandorte wie jede andere Kategorie), `zones` (nur grobe Gefahrenbereiche) oder `off` (nichts) — plus Notbremse. Die Bibliothek nimmt das Strengere aus dem Wort des Knotens und der **verifizierten** signierten Netzwerk-Konfiguration; fehlende, unlesbare oder unbekannte Werte lesen sich als `off`, nichts wird von der Bibliothek freigegeben.
- **Für die Host-App:** neue Methode `getCameraPolicy()` (geltende Stufen, Schalter der Host-App, Rechtshinweis — Wortlaut des Knotens, sonst ein eingebauter deutscher und englischer Text). Der Schalter der Host-App (`cameraNamespaceEnabled`) steht weiterhin **standardmäßig auf aus**; die App muss ihn bewusst einschalten, so wie der Nutzer in der Weboberfläche den Haken setzt.
- **Zonen:** neues `NearbyItem` `cameraZone` — eine Fläche (H3-Zelle) statt einer Nadel, ohne Einzelstandort, Id, Zähler oder Zeit einer Kamera. Gespeichert in allen drei Speichern (Memory, SQLite, IndexedDB), synchronisiert über Snapshot, statische Pakete, Delta und Push.
- **Verschärfung wirkt lokal:** wird die Politik strenger (Notbremse, ein Land oder die Voreinstellung bekommt eine kleinere Stufe), entfernt die Bibliothek alle gespeicherten Kameras, Zonen und Kamera-Meldungen, lädt die Pakete, die Kameras enthielten, neu und lernt die Live-Meldungen per Snapshot neu. Auch jede andere Änderung der Politik löst einen frischen Snapshot aus (kein Ereignis meldet, was nun erlaubt ist).
- **Schneller informiert:** neue Option `configRefreshSeconds` (Standard 120 s statt fest 10 Minuten); ändert sich die Paket-Version des Servers, wird die Konfiguration sofort neu gelesen.
- **Beim Bau gefunden und behoben:** die Signatur der Netzwerk-Konfiguration wurde über die *typisierte* Struktur der Bibliothek geprüft, nicht über das, was signiert wurde. Ein vom Unterzeichner weggelassenes Feld oder das neue `cameraPolicyByCountry` ließ die Prüfung scheitern — und eine gescheiterte Prüfung heißt „keine Netzwerk-Konfiguration“. Geprüft wird jetzt der signierte Inhalt selbst; neue Felder der Konfiguration stören nie mehr.
- **Belegt:** Unit- und Vertragstests; sechs neue Konformitätsszenarien (Zonen, `full`, Host-Schalter, signierte Politik nur strenger, Verschärfung, Notbremse) über alle Anbindungen mit dem Szenarien-Runner; ein Mehrknoten-Test gegen einen echten Server mit DE `full`, FR `zones`, CH `off`, der die Politik ohne Neustart verschärft. **Nicht belegt:** ein echter Server mit echten Ländergrenzen (die Tests nutzen die synthetischen Rechtecke des Servers).
- **Grenzen, offen benannt:** die Bibliothek kennt keine Landesgrenzen — welche Stufe eine einzelne Kamera hat, entscheidet der Server; sie zeigt, was geliefert wurde, solange die Politik irgendwo etwas durchlässt. Das Land des Fahrers berücksichtigt weder Server noch Bibliothek: eine Host-App, die es kennt, kann es mit `byCountry` selbst nutzen. Die Politik wird von dem Knoten gelesen, der `GET /v1/config` beantwortet.

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

**Abnahme vom frischen Klon:** Server in Docker (`docker compose up -d`), echte API-Aufrufe, Weboberfläche und die Bibliothek über zwei Anbindungen (Python/C-ABI und Browser, aus den Release-Dateien) mit Registrieren, Bootstrap, Tempolimit, Meldung, Push und Offline-Puffer sowie dem Zusammenspiel mit der Weboberfläche — Befehle, Ausgaben und Bilder in [`docs/final-report.md`](docs/final-report.md), Abschnitt 4.

**Unterwegs gefunden und behoben:**
- **TLS auf Android:** reqwest 0.13 prüft Zertifikate standardmäßig mit dem Plattform-Verifier, der auf Android nur mit Handarbeit in jeder App funktioniert — ein AAR ohne Zusatz-Setup wäre auf Android nicht benutzbar gewesen. Der HTTP-Transport vertraut jetzt den eingebauten Mozilla-Wurzeln (der WebSocket-Transport tat es schon). Preis: ein Server mit privater CA wird nicht vertraut.
- Aufrufe laufen auf Threads der Bibliothek mit 8-MiB-Stack, nicht auf denen des Hosts (Android-/JVM-/macOS-Threads haben 0,5–1 MiB) — vorher ein SIGSEGV im Node-Lauf.
- `libc` 0.2.190 bricht `backtrace` (Abhängigkeit von `flutter_rust_bridge`) auf iOS; gehalten unter 0.2.190, mit Begründung im Manifest.
- `initialize()` des Dart-Pakets war nicht idempotent (vom Emulator-Lauf gefunden).
- Ergebnis-Umschlag, `call_json` und `open_native` liegen einmal im Kern statt je Anbindung.
- **Echtzeit-Push erreichte einen echten Server nie** (vom Ende-zu-Ende-Lauf gegen den Docker-Server gefunden, in keinem Mock-Test sichtbar): die Bibliothek öffnete `http://…/v1/ws` statt `ws://`/`wss://` und ging in den Backoff. Behoben im Kern (alle Anbindungen), abgesichert durch URL-Tests und einen Mehrknoten-Test, der eine Meldung *während der Verbindung* über den echten WebSocket eines echten Servers ankommen lässt.
- **Erster Zugang im Docker-Stack fehlte in der Anleitung:** `server/scripts/` liegt nicht im Image. `server/docs/installation.md` beschreibt jetzt den Weg („Create the first client“), die Integrationsanleitungen verweisen darauf. Außerdem: die „Verbinden“-Seite der Weboberfläche versprach noch Codebeispiele „sobald die Bindings fertig sind“ — Text korrigiert (nur Text in `server/web`, keine Serverlogik).

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
