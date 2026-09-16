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
- [ ] Plattform wählen lassen (Supabase/Neon/andere, Claude Code entscheidet mit Begründung)
- [ ] Schema + Ereignisprotokoll + materialisierter Zustand
- [ ] Snapshot- und Delta-Mechanik
- [ ] Moderationsgate (Rate-Limit, Duplikat-Erkennung, Reputation)
- [ ] Transport-Protokoll wählen (MQTT vs. WebSocket)
- [ ] Blitzer-Namensraum bauen — standardmäßig deaktiviert
- [ ] API vollständig dokumentiert und getestet (Bulk-Import-Endpunkt, Auth, Rate-Limits) — **Phase-1-Abschluss**

## Phase 2 — Client-Sync-Bibliothek — startet erst nach Phase 1
- [ ] Claude-Code-Prompt generieren
- [ ] Portabilität entscheiden (plattformunabhängiger Kern vs. Flutter-spezifisch)
- [ ] Lokaler Speicher (SQLite + SpatiaLite)
- [ ] Sync-Engine (Bootstrap-Snapshot, Delta-Pull, regionale Subscription)
- [ ] Lokales Map-Matching für Tempolimits
- [ ] Lokale Verfallsberechnung
- [ ] Offline-Schreibpuffer + Reconciliation
- [ ] Öffentliche lokale API dokumentieren (`getNearby`, `getSpeedLimitAt`, `submitReport`, …)

## Phase 3 — Ingestion-Programm (Grundstock-Befüllung) — startet erst nach Phase 2
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
