# ToDo: Verkehrsdaten-Backend

## Koordination laufender Sessions

Mehrere Claude-Code-Sessions arbeiten gleichzeitig im selben Checkout auf
getrennten Branches (Server/Föderation, Client-Bibliothek, Ingestion). Der
laufende, detaillierte Stand jeder Session lebt in
[`docs/status.md`](status.md) (bewusst auf `main`, nicht auf einem
Feature-Branch, damit er immer ohne Branch-Wechsel sichtbar ist) — dieser
Abschnitt hier wird nicht mehr laufend aktualisiert, siehe dortige Historie
für den Verlauf.

**Veraltet (Stand 2026-09-17, hier nur noch als Historie stehen gelassen):**
frühere Fassungen dieses Abschnitts gingen davon aus, dass F-C auf F-S
wartet und noch keinen Code hat. Tatsächlicher Stand seither: Server und
Weboberfläche sind vollständig fertig und auf `main` gemergt. Die
Client-Bibliothek hat ihren Kern, echten WebSocket-Push, ein C-ABI/Python-
Binding fertig und ist gegen ein echtes Mehrknoten-Testnetz verifiziert;
weitere Anbindungen (WASM/JS-TS, Kotlin, Swift, Dart, React Native) und
Konformitätstests darüber stehen noch aus — Einzelheiten in
`client-lib/README.md` ("Was heute geht" / "Was noch fehlt") und in
[`docs/status.md`](status.md).

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
- [ ] F-C: Client-Bibliothek-Überarbeitung (Discovery, Failover, Signaturprüfung, gerätesignierte Meldungen) — Kern, echter WebSocket-Push, C-ABI mit Python-/Node.js-Binding, WebAssembly für den Browser (B3), Kotlin/Android, Swift/iOS/macOS und Dart/Flutter (B4; derselbe Szenariensatz über alle sechs Anbindungen) und die Verifikation gegen ein echtes Mehrknoten-Testnetz sind fertig, siehe `client-lib/README.md`; React Native, die Paketierung als Build-Artefakte, die C-ABI-Builds für Windows/macOS und die zusammengeführte Konformität sind mit B5 fertig (PR gestapelt auf B4); das Setzen auf 1.0.0 folgt im Abschluss-PR
- [ ] Domain `trafficnetwork.info` (entschieden 2026-09-27) registrieren und DNS betreiben — Platzhalter in Code/Doku sind bereits ersetzt
- [ ] Netzwerk-Wurzelschlüssel erzeugen und offline sicher aufbewahren
- [ ] Mindestens zwei Seed-Server bei unterschiedlichen Anbietern bereitstellen
- [ ] Betreiberbedingungen für Server-Betreiber + `docs/privacy.md` um Föderation erweitern und rechtlich prüfen lassen

## Phase 3 — Ingestion-Programm (Grundstock-Befüllung) — nach Überarbeitung F
- [x] Claude-Code-Prompt erstellt (`docs/prompt-phase3-ingestion.md`)
- [x] Umfang der Erstbefüllung entschieden: **zuerst eine einzelne Region** (Bundesland-Extrakt, ~100 MB); Deutschland/Europa später per Konfiguration
- [x] Quellenkatalog vervollständigen, Limits/Lizenzen mit Beleg dokumentieren (`ingestion/docs/sources.md`)
- [x] OSM-Worker regionsparametrisiert bauen, Wiederaufnahme nach Abbruch
- [x] Weitere Quellen hinter Schaltern inkl. Kill-Switches (HERE/TomTom standardmäßig aus, nur katalogisiert; Baustellen-Feeds und NVDB Norwegen je eigener Schalter)
- [x] Ausschließlich über die öffentliche Bulk-Import-API anbinden (kein privilegierter Zugriff)
- [x] Grundbefüllung durchführen, danach Ingestion optional abschalten (Bayern in Launch L, ganz Europa in Zusatz A)

## Launch L — Lokaler Testbetrieb auf dem Windows-PC (Docker)
- [x] Claude-Code-Prompt erstellt (`docs/prompt-launch-local-test.md`)
- [ ] L1: Docker Desktop (WSL2) einrichten, Compose-Stack starten
- [ ] L2: Testschlüssel, signierte Netzwerk-Konfiguration, Client-Zugänge (Blitzer-Flag bleibt aus)
- [ ] L3: Region importieren und verifizieren
- [ ] L4: Testwerkzeug `tools/test-client/` (Kommandozeile + kleine Weboberfläche) auf Basis der Client-Bibliothek
- [ ] L5: Abnahmetest inkl. zweitem lokalen Knoten und Failover, Ergebnis in `docs/launch-checklist.md`

## Zusatz W — Weboberfläche des Servers (Karte, Melden, Anleitung)
- [x] Claude-Code-Prompt erstellt (`docs/prompt-server-web-ui.md`) — reine Ergänzung, API bleibt unverändert
- [x] W1: Auslieferung durch den Server (`WEB_UI_ENABLED`), Grundgerüst, GitHub-Link in der Fußzeile, Deutsch/Englisch
- [x] W2: Karte (OpenStreetMap) mit Meldungen und Tempolimit-Abfrage, Live-Aktualisierung
- [x] W3: Melden und Bestätigen aus dem Browser, ohne Geheimnis im Quelltext, mit eigener Begrenzung
- [x] W4: Seiten „Verbinden" (App, eigener Knoten, API) und „Über das Projekt"
- [x] W5: E2E-Tests (Playwright), `server/docs/web-ui.md`, `docs/privacy.md` (Entwurf) — Branch `feature/server-web-ui`
- [x] W-PR: Pull Request #8 offen (CI grün, Lauf #30), Merge-Hinweise im PR; der Performance-Fix ist PR #4 (Stapel der Server-Instanz)

## Zusatz O — Anzeige „aktuell online" (Server + Web + Client-Bibliothek)
- [x] Zusatz-Prompts erstellt (`docs/prompt-addon-online-counter.md`)
- [x] O-A Server: `GET /v1/stats/online`, eigene Zahl im Heartbeat (`onlineCount`), Schwellenwert gegen Rückschlüsse (Branch `feature/online-counter`, lokal 295/295, PR wartet auf Freigabe; Antwortformat entspricht dem von O-B/O-C erwarteten)
- [x] O-B Web: Anzeige unten rechts, Aktualisierung, Textfall unter dem Schwellenwert — gebaut und getestet (Branch `feature/server-web-ui`, Unit + Playwright), gegen den echten O-A-Endpunkt geprüft (Trial-Merge-Prüfung siehe `docs/status.md`, Abschnitt "Server-Weboberfläche (W)")
- [x] O-C Client-Bibliothek: `NetworkStatus`-Felder `onlineNode`/`onlineNetwork`/`onlineEstimated`/`onlineAsOf` + `OnlineStatusService` (Branch `rework/client-lib-online-counter`, CI grün; gegen das vorgeschlagene Format gebaut, O-A steht noch aus; `getNetworkStatus()` als Fassade jetzt Teil der öffentlichen API in `rework/client-lib-europe-scale`, siehe Zusatz E unten)

## Zusatz K — Falsche Tempolimits melden und korrigieren
- [x] Zusatz-Prompts erstellt (`docs/prompt-addon-speed-limit-corrections.md`)
- [x] K-A Server: Korrektur als überlagernder Datensatz (Import bleibt erhalten), Schwellenwert, Widerspruch, Verteilung über Pakete/Events und Föderation, Betreiber kann zurücksetzen (Branch `feature/speed-limit-corrections`, lokal 339 Tests grün (Gesamtlauf 338/339, der eine Fehler war eine veraltete Testerwartung, behoben und nachgelaufen), PR wartet auf Freigabe; Plan: `server/docs/speed-limit-corrections.md`; **Migration 0007 schreibt `speed_limit_segments` einmalig um, ~20 s pro Mio. Segmente** — Backup + Wartungsfenster einplanen)
- [ ] K-B Web: „Stimmt nicht?"-Formular, Herkunft des Werts sichtbar (Hinweise im Status-Abschnitt "Zusatz K-A") — **Allowlist-Seite erledigt** (`feature/server-web-ui`: die vier Korrektur-Pfade sind für Web-Sitzungen offen, unsigniert und knotenlokal); Formular und Herkunftsanzeige stehen aus
- [x] K-C Client-Bibliothek: `report_wrong_speed_limit`/`confirm_speed_limit_correction` über den Offline-Puffer (beim Senden signiert), Überlagerung statt Überschreiben, Herkunft in `speed_limit_at()` (Branch `rework/client-lib-speed-corrections`, CI grün; gegen den dokumentierten Server-Vertrag gebaut; öffentliche Fassade `getSpeedLimitAt()`/`reportWrongSpeedLimit()` jetzt Teil der öffentlichen API in `rework/client-lib-europe-scale`, siehe Zusatz E unten)
- [x] Schwellenwert entschieden: **3 verschiedene Geräte** (Konfigurationswert, Standard 3)
- [x] Wertebereich für Korrekturen festgelegt: ganzzahlig, **5–150 km/h bzw. 5–85 mph**, nur Vielfache von **5**, in der Einheit des Segments (alles per Umgebungsvariable änderbar); Gleichstand ⇒ kein Gewinner; Importänderung ⇒ Korrektur bleibt, Markierung „zu prüfen"
- [ ] Folgeaufgaben K-A (nicht Teil des Auftrags): temporäre Korrekturen (Baustelle) automatisch auslaufen lassen; `deviceAssertion` bei Meldungen an den gebundenen Schlüssel knüpfen (siehe Nebenbefund im Status); Stimmen nach Ruf des weiterleitenden Knotens gewichten

## Zusatz E — Grundstock ganz Europa (einmalig, aktueller Stand)
- [x] Entschieden: ganz Europa, **einmaliger** Import des aktuellsten Stands; kein wiederkehrender Update-Lauf vorerst
- [x] Entschieden: statische Daten weiterhin **vollständig an jedes Gerät** — Machbarkeit wird nach dem Import gemessen, nicht geraten
- [x] Zusatz-Prompts erstellt (`docs/prompt-addon-europe-basemap.md`)
- [x] E-A Ingestion: Machbarkeitsbericht, Europa-Import (13,68 Mio. Zeilen, 4,1 GB) und Bericht (`ingestion/docs/europe-feasibility.md`, `europe-run-report.md`), Update-Weg nur dokumentiert
- [x] E-B Server: fertig und gemergt (vorgebaute, streamende, zwischenspeicherbare Pakete, Batch-Import, Snapshot-Schutz, `?since=`, Range). Auflösung 4 ist Code-Standard, `partitionResolution` steht im Manifest; die vollständige Messung auf einer Kopie des echten Bestands liegt in `server/docs/europe-scale.md`. **Offen bleibt nur der Betreiber-Schritt:** Migration + Paketbau auf `tn-europe` selbst (siehe "Offen (Betreiber)" weiter unten, Zusatz Q)
- [x] E-C Client-Bibliothek: vollständigen Bootstrap gemessen und berichtet (`client-lib/docs/bootstrap-measurements.md`: echtes Bayern über einen echten Server, synthetisch bis 20 Mio. Segmente, Abbruch/Fortsetzen, Bandbreiten-Rechnung) — dabei `SqliteStore` (R*Tree, wiederaufnehmbarer Bootstrap, `SyncError::StorageFull`, Paket-Hashprüfung, `partitionResolution`-Abgleich mit E-B) und `plan_static_bootstrap`/`SyncObserver` als Vorab-Check bzw. Fortschritt gebaut. Branch `rework/client-lib-europe-scale`, CI grün, PR noch nicht geöffnet. Empfehlung an den Nutzer: erst E-A/E-B-Zahlen abwarten, dann Server-seitige Kompression + kleinere Partitionen + Streaming-Parser messen, bevor „alles auf jedem Gerät" infrage gestellt wird — nichts davon wurde umgestellt
- [ ] E-D Web: Startansicht Europa, nur sichtbaren Ausschnitt laden, Cluster bei kleiner Zoomstufe
- [ ] Nach den Messungen entscheiden, ob „alles auf jedem Gerät" so bleibt

## Zusatz D — Dauerhafte Überwachungsanlagen (Rotlicht, Abstand)
- [x] Entschieden: bestehende Tabelle `fixed_speed_cameras` verallgemeinern (Spalte `camera_type`), keine neue Tabelle je Bauart; Altbestand muss unversehrt bleiben
- [x] Zusatz-Prompt erstellt (`docs/prompt-addon-persistent-cameras.md`) — für den Server-Chat
- [x] D0 Plan (Server, `server/docs/persistent-enforcement-devices.md`): Migration gemessen (5 ms bei 1 Mio. Zeilen, kein Fenster), Schema/Rückrollen, API-Auswirkung belegt, Befund „feste Blitzer werden nicht föderiert", Abschnittskontrolle-Vorschlag
- [x] D1 Migration + Migrationstest mit Altbestand (Zeilenzahl vorher/nachher, Rückrollen) — fertig und gemergt
- [x] D2 API additiv (`cameraType`, neues Snapshot-Feld, Bulk-Import-Feld) — fertig und gemergt
- [x] D3 Föderation und statische Pakete, Mehrknoten-Test — fertig und gemergt; **die acht offenen Fragen aus D0 §10 sind mit den dort genannten Standardwerten gebaut**, jede bleibt eine kleine, spätere Änderung (siehe `docs/audit.md`)
- [ ] Offen: Abschnittskontrolle (`enforcement=average_speed`) — Vorschlag abwarten, noch nicht bauen
- [ ] Offen: Soll es „dauerhaft gemeldet" durch Nutzer geben (Schwelle), oder bleiben Nutzermeldungen immer verfallend?

## Zusatz Q — Quellenkatalog (Blitzer, Baustellen, Verkehrsschilder)
- [x] Recherche des Betreibers liegt vor (Rechtslage, OSM, DATEX II/NAPCORE, nordische Behördenquellen)
- [x] Zusatz-Prompt erstellt (`docs/prompt-addon-source-catalogue.md`) — für den Ingestion-Chat
- [x] Q0 Quellenkatalog mit belegten Lizenzen + Ampel je Quelle (`ingestion/docs/sources.md`)
- [x] Q1 Blitzer aus OSM (Namensraum bleibt deaktiviert; Test `camera-namespace.test.ts`)
- [x] Q2 Verkehrsschilder aus OSM, Codes länderoffen
- [x] Q3 Baustellen: DATEX-II-Leser + Autobahn GmbH, periodisch lauffähig (`ingestion/docs/roadworks.md`; Frankreich an, NL/DE aus)
- [x] Q4 Eine amtliche Schildquelle inkl. Mapping-Tabelle: **NVDB Norwegen** (Schwedens offene API enthält keine Schilder, Digiroad ist abgeschaltet)
- [x] Entschieden: Baustellen-Anbinder läuft dauerhaft (Zeitplan extern, Kosten in `ingestion/docs/roadworks.md`); Länder: Frankreich an, Niederlande und Deutschland aus bis zur Lizenzklärung
- [ ] Entscheiden: Mapillary/KartaView einbinden? (erst nach belegter Lizenzprüfung, standardmäßig aus)
- [ ] Attribution aus `ingestion/docs/attribution.md` in die Weboberfläche übernehmen (Web-Instanz; dazu braucht die Hazard-API das Feld `source_feed`, Server-Instanz)
- [ ] Offen (Betreiber): Lizenz von NDW klären, danach `nl-ndw` einschalten; Entscheidung zur Autobahn-API (`de-autobahn`, Lizenz ungeklärt)
- [ ] Offen (Betreiber): NVDB-Norwegen-Vollimport ausführen (`--region norway`, geschätzt 20–40 min, auf einem Knoten mit den Europa-Daten nur mit `--allow-non-empty`)
- [ ] Offen (Betreiber): NVDB Schweden nur, wenn ein Lastkajen-Zugang samt Beispieldatei vorliegt
- [ ] Offen (Betreiber): die 2.000 doppelt importierten Segmente auf `tn-europe` entfernen (SQL im Europa-Bericht), danach `pg_dump` als Grundstock

## Zusatz fix/api-serialization — Cross-Language-Fehler aus der Client-Bibliothek-B2-Mehrknoten-Suite
- [x] Ursache gefunden (Drizzles Postgres.js-Treiber schaltet den `timestamptz`-Parser global ab; `int8` hat in `postgres.js` keinen Standard-Parser) und an der Wurzel behoben (`server/src/db/raw-sql-types.ts`), nicht an den ~19 einzelnen Aufrufstellen
- [x] Zwei alte Aufrufstellen-Workarounds entfernt (`server/src/db/sql-iso.ts`, redundante `Number(row.seq)`-Stellen)
- [x] Konformitätstest gegen `server/docs/api.md` (Typ und Format, nicht nur Vorhandensein): `server/tests/integration/api-serialization.test.ts`
- [x] `server/docs/api.md`-Hinweis „bekannte Abweichung" entfernt; `docs/status.md` aktualisiert
- [ ] Offen (Betreiber/Reviewer): PR #13 grün prüfen und mergen — lokal durch abstürzendes Docker Desktop nicht vollständig durchgelaufen, siehe Lagebericht in `docs/status.md`

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

## Zusatz Blitzer-Funktion länderabhängig

- [x] Teil A (Server, `feature/camera-country-policy`): Blitzer freigeschaltet, Standard `full` je Land, Notbremse `SPEED_CAMERA_NAMESPACE_ENABLED` Standard `true`; Länder-Ausnahmen `cameraPolicyByCountry` (`zones`/`off`), zentrale Ausliefer-Schicht, Zonen, Richtlinienwechsel ohne Neustart, Doku, Tests — gepusht, PR wartet auf Freigabe
- [ ] Teil B (Web, `feature/camera-ui`): Kategorien mit Filter, beim ersten Besuch aus; Fläche statt Nadel bei `zones`; Kategorie fehlt bei `off`; Rechtshinweis beim Anhaken (`cameraPolicy.notice`)
- [ ] Teil C (Client-Bibliothek, `feature/camera-policy`): Politik aus `GET /v1/config`, lokale Daten bei Verschärfung entfernen, Stufe + Hinweis in der öffentlichen API, Host-Option „Blitzer anzeigen“ Standard aus
- [ ] Betreiber: rechtliche Einschätzung je Land (Schweiz, Frankreich zuerst), ggf. Grenzdatensatz laden und Einschränkungen signieren (`server/docs/operating.md`, „Camera policy“); `docs/launch-checklist.md` Punkt 7 anpassen
