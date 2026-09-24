# ToDo: Verkehrsdaten-Backend

## Koordination laufender Sessions

Zwei Claude-Code-Sessions arbeiten gleichzeitig im selben Checkout (F-S und
F-C laufen parallel, siehe "Überarbeitung F" unten) — dieser Abschnitt ist
der gemeinsame Status, damit keine Session im Dunkeln tappt oder der anderen
in die Quere kommt. **Jede Session aktualisiert nur ihren eigenen Block**,
committet das für sich (kleine, isolierte Doku-Änderung) und pusht sofort,
um Konflikte mit der anderen Session zu vermeiden.

**F-S (Server, `server/`)** — Session "Trafficnetwork Backend"
- Branch: `rework/server-federation` — Pull Request nach `main` eingereicht,
  noch nicht gemergt (wartet auf Freigabe)
- Stand: F-S0–F-S5 vollständig abgeschlossen und gepusht. Laufender,
  detaillierter Stand steht ab jetzt in [`docs/status.md`](status.md) statt
  hier (dieser Abschnitt wird nicht mehr laufend aktualisiert)
- Nächster Schritt: wartet auf PR-Review/Merge-Freigabe; danach ggf. F-C
  (Client-Bibliothek) gegen die jetzt stabile, gemergte API weiterführen

**F-C (Client-Bibliothek, `client-lib/`)** — Session "Client-Sync-Bibliothek Phase 2"
- Branch: `rework/client-lib-federation`
- Stand: wartet bewusst auf F-S-Fortschritt (F-C ist laut
  `docs/prompt-rework-client-lib-federation.md` von der Server-Föderation
  abhängig — Protokoll/API der Server-Seite müssen erst stehen); bislang nur
  P2.0 (nicht-föderierte Server-Erweiterungen, siehe unten) umgesetzt, noch
  kein Code in `client-lib/` selbst
- Nächster Schritt: F-S-Fortschritt weiter beobachten; F-C0 (Stand prüfen,
  Entscheidungen, Plan) beginnt, sobald F-S so weit steht, dass Protokoll/API
  sich nicht mehr grundlegend ändern (spätestens nach F-S2, ggf. früher in
  Absprache)

_Zuletzt aktualisiert: 2026-09-17 von der F-C-Session._

## Vor der Prompt-Erstellung — offene Entscheidungen
- [x] GitHub-Repo-Struktur: ein Monorepo für Server, Client-Bibliothek, Ingestion
- [x] Geografischer Start-Scope: Europa, Architektur weltweit-fähig ausgelegt
- [x] Region-Tiling-Schema: global durchgängig (Geohash/H3/S2) — konkrete Wahl + Kachelgröße: Claude Code entscheidet mit Begründung
- [x] Log-Aufbewahrungsfenster: Claude Code entscheidet mit Begründung (kein fester Wert vorgegeben)
- [x] Regionale Filterung dynamischer Daten: bestätigt (statisch global, dynamisch nur nahe Umgebung) — Umsetzungsdetails: Claude Code
- [x] Open-Source-Lizenz: Apache License 2.0
- [x] Baureihenfolge: Server (inkl. API) vollständig → Client-Sync-Bibliothek → Ingestion/Grundstock

## Rechtliches — parallel, vor Launch
- [ ] Autobahn-API: Lizenz direkt bei Autobahn GmbH/BMV erfragen (aktuell „ungeklärt")
- [ ] `docs/privacy.md` (DSGVO) fertigstellen, bevor echte Nutzermeldungen angenommen werden
- [ ] Rechtliche Beratung zum Blitzer-Betreiberrisiko einholen, bevor das Blitzer-Flag je aktiviert wird

## Phase 1 — Server (Relay/Moderator + API) — muss vollständig fertig sein, bevor Phase 2 beginnt
- [x] Claude-Code-Prompt aus dem Konzept generieren (`docs/prompt-phase1-server.md`)
- [x] Plattform gewählt: Neon (siehe `server/README.md`, Begründung in `docs/prompt-phase1-server.md` Abschnitt 2)
- [x] Schema + Ereignisprotokoll + materialisierter Zustand
- [x] Snapshot- und Delta-Mechanik
- [x] Moderationsgate (Rate-Limit, Duplikat-Erkennung, Reputation)
- [x] Transport-Protokoll gewählt: WebSocket (siehe Begründung im Server-Plan)
- [x] Blitzer-Namensraum gebaut — standardmäßig deaktiviert
- [x] API vollständig dokumentiert und getestet (Bulk-Import-Endpunkt, Auth, Rate-Limits) — **Phase-1-Abschluss erreicht**

## Phase 2 — Client-Sync-Bibliothek — gestartet (Phase 1 abgeschlossen)
- [x] Claude-Code-Prompt generieren (`docs/prompt-phase2-client-lib.md`)
- [x] Portabilität entschieden: plattformunabhängiger Kern + dünne Bindings (Android, iOS, Flutter, React Native, Desktop/Server über C-ABI inkl. Python/Node, Web/WASM)
- [x] Geräte-Identität entschieden: anonyme Geräteregistrierung per App-Schlüssel (Server-Erweiterung in P2.0)
- [x] P2.0 Server-Erweiterungen: Geräteregistrierung, partitionierte/versionierte statische Datenpakete + Manifest, Config-Endpunkt
- [ ] Kernsprache/Toolchain + Speicher/Geo-Index wählen lassen (SpatiaLite-Verfügbarkeit auf allen Zielen prüfen)
- [ ] Lokaler Speicher + Migrationen
- [ ] Sync-Engine (Registrierung/Token, Bootstrap, Delta inkl. 409-Fallback, WebSocket-Push, regionale Subscription, Paket-Updates)
- [ ] Lokales Map-Matching für Tempolimits
- [ ] Lokale Verfallsberechnung
- [ ] Offline-Schreibpuffer + Reconciliation
- [ ] Bindings + Konformitätstests für alle Zielplattformen
- [ ] Öffentliche lokale API + Integrations-Guides dokumentieren — **Phase-2-Abschluss**

## Vor produktivem Einsatz von Phase 2
- [ ] Letzten `server-ci`-Lauf prüfen (Integrationstests grün)
- [ ] `docs/privacy.md` (DSGVO) fertig — Geräteregistrierung und Positions-Tiles berücksichtigen

## Überarbeitung F — Self-Hosting & Föderation (nach Phase 2, vor Phase 3)
- [x] Konzept erstellt (`docs/federation.md`), Entscheidung: offene Mitgliedschaft mit Reputation
- [x] Claude-Code-Prompts erstellt (`docs/prompt-rework-server-federation.md`, `docs/prompt-rework-client-lib-federation.md`)
- [x] Stand von Phase 2 im Repo klären: P2.0 (Server-Erweiterungen für client-lib) ist auf GitHub; `client-lib/` selbst enthält bewusst noch keinen Code — das ist die eigentliche Phase-2-Client-Bibliothek, eigener, noch nicht gestarteter Auftrag
- [x] F-S: Server-Überarbeitung (Docker/Apache/nginx/Caddy, Signaturen, Föderation, Reputation, Verzeichnis) — F-S0–F-S5 vollständig umgesetzt (Docker/Compose/Installation ohne Docker, Node-/Wurzelschlüssel + CLI, geräteseitig signierte Auth, signierte Netzwerk-Konfiguration, Beitritt über Seeds, Peer-Verzeichnis + Gossip, signierte Heartbeats, Push/Pull-Replikation geräteseitig signierter Meldungserstellungen, Reputationsstufen, `GET /v1/network/directory` + Export-Skript, Überlast-Signal, echtes Mehrknoten-Testnetz), Doku vollständig (`server/docs/{installation,operating,api,schema,threat-model,federation-protocol}.md`), Branch `rework/server-federation`, Pull Request nach `main` eingereicht
- [ ] F-C: Client-Bibliothek-Überarbeitung (Discovery, Failover, Signaturprüfung, gerätesignierte Meldungen)
- [ ] Projekt-Domain registrieren, Platzhalter `trafficnetwork.example` ersetzen
- [ ] Netzwerk-Wurzelschlüssel erzeugen und offline sicher aufbewahren
- [ ] Mindestens zwei Seed-Server bei unterschiedlichen Anbietern bereitstellen
- [ ] Betreiberbedingungen für Server-Betreiber + `docs/privacy.md` um Föderation erweitern und rechtlich prüfen lassen

## Phase 3 — Ingestion-Programm (Grundstock-Befüllung) — nach Überarbeitung F
- [x] Claude-Code-Prompt erstellt (`docs/prompt-phase3-ingestion.md`)
- [x] Umfang der Erstbefüllung entschieden: **zuerst eine einzelne Region** (Bundesland-Extrakt, ~100 MB); Deutschland/Europa später per Konfiguration
- [ ] Quellenkatalog vervollständigen, Limits/Lizenzen mit Beleg dokumentieren
- [ ] OSM-Worker regionsparametrisiert bauen, Wiederaufnahme nach Abbruch
- [ ] Weitere Quellen hinter Schaltern inkl. Kill-Switches (HERE/TomTom standardmäßig aus)
- [ ] Ausschließlich über die öffentliche Bulk-Import-API anbinden (kein privilegierter Zugriff)
- [ ] Grundbefüllung durchführen, danach Ingestion optional abschalten

## Launch L — Lokaler Testbetrieb auf dem Windows-PC (Docker)
- [x] Claude-Code-Prompt erstellt (`docs/prompt-launch-local-test.md`)
- [ ] L1: Docker Desktop (WSL2) einrichten, Compose-Stack starten
- [ ] L2: Testschlüssel, signierte Netzwerk-Konfiguration, Client-Zugänge (Blitzer-Flag bleibt aus)
- [ ] L3: Region importieren und verifizieren
- [ ] L4: Testwerkzeug `tools/test-client/` (Kommandozeile + kleine Weboberfläche) auf Basis der Client-Bibliothek
- [ ] L5: Abnahmetest inkl. zweitem lokalen Knoten und Failover, Ergebnis in `docs/launch-checklist.md`

## Zusatz W — Weboberfläche des Servers (Karte, Melden, Anleitung)
- [x] Claude-Code-Prompt erstellt (`docs/prompt-server-web-ui.md`) — reine Ergänzung, API bleibt unverändert
- [ ] W1: Auslieferung durch den Server (`WEB_UI_ENABLED`), Grundgerüst, GitHub-Link in der Fußzeile, Deutsch/Englisch
- [ ] W2: Karte (OpenStreetMap) mit Meldungen und Tempolimit-Abfrage, Live-Aktualisierung
- [ ] W3: Melden und Bestätigen aus dem Browser, ohne Geheimnis im Quelltext, mit eigener Begrenzung
- [ ] W4: Seiten „Verbinden" (App, eigener Knoten, API) und „Über das Projekt"
- [ ] W5: E2E-Tests, `server/docs/web-ui.md`, Pull Request

## Zusatz O — Anzeige „aktuell online" (Server + Web + Client-Bibliothek)
- [x] Zusatz-Prompts erstellt (`docs/prompt-addon-online-counter.md`)
- [ ] O-A Server: `GET /v1/stats/online`, eigene Zahl im Heartbeat, Schwellenwert gegen Rückschlüsse
- [ ] O-B Web: Anzeige unten rechts, Aktualisierung, Textfall unter dem Schwellenwert
- [x] O-C Client-Bibliothek: `NetworkStatus`-Felder `onlineNode`/`onlineNetwork`/`onlineEstimated`/`onlineAsOf` + `OnlineStatusService` (Branch `rework/client-lib-online-counter`, CI grün; gegen das vorgeschlagene Format gebaut, O-A steht noch aus; `getNetworkStatus()` als Fassade folgt mit F-C4/F-C5)

## Zusatz K — Falsche Tempolimits melden und korrigieren
- [x] Zusatz-Prompts erstellt (`docs/prompt-addon-speed-limit-corrections.md`)
- [ ] K-A Server: Korrektur als überlagernder Datensatz (Import bleibt erhalten), Schwellenwert, Widerspruch, Verteilung über Pakete/Events, Betreiber kann zurücksetzen
- [ ] K-B Web: „Stimmt nicht?"-Formular, Herkunft des Werts sichtbar
- [ ] K-C Client-Bibliothek: `reportWrongSpeedLimit()` über den Offline-Puffer, Herkunft in `getSpeedLimitAt()`
- [x] Schwellenwert entschieden: **3 verschiedene Geräte** (Konfigurationswert, Standard 3)
- [ ] Wertebereich für Korrekturen festlegen (Plausibilitätsgrenzen)

## Zusatz E — Grundstock ganz Europa (einmalig, aktueller Stand)
- [x] Entschieden: ganz Europa, **einmaliger** Import des aktuellsten Stands; kein wiederkehrender Update-Lauf vorerst
- [x] Entschieden: statische Daten weiterhin **vollständig an jedes Gerät** — Machbarkeit wird nach dem Import gemessen, nicht geraten
- [x] Zusatz-Prompts erstellt (`docs/prompt-addon-europe-basemap.md`)
- [ ] E-A Ingestion: Machbarkeitsbericht (Platz, RAM, Dauer), dann Europa-Import in Abschnitten, Update-Weg nur dokumentiert
- [ ] E-B Server: Größen und Antwortzeiten messen, Pakete/Manifest bei Europa-Größe, zwischenspeicherbare Auslieferung
- [ ] E-C Client-Bibliothek: vollständigen Bootstrap messen und berichten (Datenmenge, Dauer, Speicher)
- [ ] E-D Web: Startansicht Europa, nur sichtbaren Ausschnitt laden, Cluster bei kleiner Zoomstufe
- [ ] Nach den Messungen entscheiden, ob „alles auf jedem Gerät" so bleibt

## Launch P — Öffentlicher Betrieb (gemieteter Server + Domain)
- [x] Claude-Code-Prompt erstellt (`docs/prompt-launch-public-server.md`)
- [ ] Server und Domain besorgen
- [ ] Echten Netzwerk-Wurzelschlüssel offline erzeugen und verwahren
- [ ] Knoten öffentlich betreiben, zweiten Knoten beitreten lassen
- [ ] Backups mit belegtem Wiederherstellungstest, Überwachung, Update-Weg
- [ ] Betreiberbedingungen + `docs/privacy.md` fertig und rechtlich geprüft — **vor der ersten echten Nutzermeldung**
## Danach / separate Projekte
- [ ] Flutter-App (eigenes Projekt, startet erst wenn Backend steht)
- [ ] ESP32-Firmware — bereits spezifiziert (`prompt-esp32-blitzer-display.md`), unverändert eigenständig
