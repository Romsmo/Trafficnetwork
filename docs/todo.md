# ToDo: Verkehrsdaten-Backend

## Koordination laufender Sessions

Zwei Claude-Code-Sessions arbeiten gleichzeitig im selben Checkout (F-S und
F-C laufen parallel, siehe "Überarbeitung F" unten) — dieser Abschnitt ist
der gemeinsame Status, damit keine Session im Dunkeln tappt oder der anderen
in die Quere kommt. **Jede Session aktualisiert nur ihren eigenen Block**,
committet das für sich (kleine, isolierte Doku-Änderung) und pusht sofort,
um Konflikte mit der anderen Session zu vermeiden.

**F-S (Server, `server/`)** — Session "Trafficnetwork Backend"
- Branch: `rework/server-federation` (noch nicht nach `main` gemergt)
- Stand: F-S1 abgeschlossen und gepusht — Docker-Paketierung, Installation
  ohne Docker, `server/docs/threat-model.md` (Commit `e5e0592`, CI-Trigger
  für `rework/*`-Branches ergänzt in `17c4518`)
- Nächster Schritt: F-S2 (Identitäten & Kryptografie, gerätesignierte Auth,
  signierte Netzwerk-Konfiguration)

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
- [ ] F-S: Server-Überarbeitung (Docker/Apache/nginx/Caddy, Signaturen, Föderation, Reputation, Verzeichnis) — F-S0 (Plan), F-S1 (Docker/Compose/Installation ohne Docker) und F-S2 (Node-/Wurzelschlüssel + CLI, geräteseitig signierte Auth additiv, signierte Netzwerk-Konfiguration, siehe `server/docs/installation.md`/`api.md`/`schema.md`) fertig, F-S3–F-S5 offen, Branch `rework/server-federation`
- [ ] F-C: Client-Bibliothek-Überarbeitung (Discovery, Failover, Signaturprüfung, gerätesignierte Meldungen)
- [ ] Projekt-Domain registrieren, Platzhalter `trafficnetwork.example` ersetzen
- [ ] Netzwerk-Wurzelschlüssel erzeugen und offline sicher aufbewahren
- [ ] Mindestens zwei Seed-Server bei unterschiedlichen Anbietern bereitstellen
- [ ] Betreiberbedingungen für Server-Betreiber + `docs/privacy.md` um Föderation erweitern und rechtlich prüfen lassen

## Phase 3 — Ingestion-Programm (Grundstock-Befüllung) — startet erst nach Phase 2 und Überarbeitung F
- [ ] Claude-Code-Prompt generieren
- [ ] Quellenkatalog vervollständigen, Limits/Lizenzen mit Beleg dokumentieren
- [ ] OSM-Worker regionsparametrisiert bauen (Start: Europa-Extrakt, weitere Kontinente später per Konfiguration ergänzbar)
- [ ] API-Keys besorgen (HERE, TomTom, ggf. weitere)
- [ ] Kill-Switches gegen unerwartete Kosten einbauen
- [ ] Ausschließlich über die öffentliche Bulk-Import-API anbinden (kein privilegierter Zugriff)
- [ ] Grundbefüllung durchführen, danach Ingestion optional abschalten

## Danach / separate Projekte
- [ ] Flutter-App (eigenes Projekt, startet erst wenn Backend steht)
- [ ] ESP32-Firmware — bereits spezifiziert (`prompt-esp32-blitzer-display.md`), unverändert eigenständig
