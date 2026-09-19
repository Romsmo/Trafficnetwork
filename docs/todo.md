# ToDo: Verkehrsdaten-Backend

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
- [ ] Stand von Phase 2 im Repo klären (auf GitHub ist `client-lib/` noch ohne Code — ggf. lokale Arbeit pushen)
- [ ] F-S: Server-Überarbeitung (Docker/Apache/nginx/Caddy, Signaturen, Föderation, Reputation, Verzeichnis)
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
