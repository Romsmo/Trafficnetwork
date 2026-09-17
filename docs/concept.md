# Konzept: Offenes Verkehrsdaten-Backend (Local-First)

> **Scope dieses Dokuments:** Nur das Backend-System — Relay-/Moderator-Server, Client-Sync-Bibliothek, Ingestion-Programm. **Nicht enthalten**: die Flutter-App und das ESP32-Display (eigene, bereits an anderer Stelle behandelte Projekte). Dieses Dokument ist die konsolidierte Grundlage, aus der später ein oder mehrere Claude-Code-Prompts generiert werden — es ersetzt die vorherigen Einzeldokumente `prompt-verkehrsdaten-db.md` und `prompt-verkehrsdaten-ingestion.md` konzeptionell, da sich die Architektur seitdem auf „Local-First" verschoben hat.

---

## 1. Vision

Ein offenes, quelloffenes Verkehrsdaten-Netzwerk für Tempolimits, statische Verkehrszeichen und Live-Meldungen (Stau, Unfall, Baustelle, Glätte, Panne, Hindernis, Blitzer). Jedes Gerät hält eine lokale Kopie der für es relevanten Daten und funktioniert damit vollständig offline — Anzeige und Warnung hängen nie von einer Live-Verbindung ab. Ein zentraler Server vermittelt und moderiert Änderungen zwischen den Geräten, ist aber nicht die Quelle, die bei jeder Positionsprüfung angefragt wird.

Initial gefüttert aus kostenlos zugänglichen Quellen (unabhängig von deren Weiterverteilungs-Lizenz, siehe Abschnitt 4 — bewusste Entscheidung), langfristig getragen durch Meldungen und Bestätigungen der eigenen Nutzer. Alle drei Komponenten (Server, Client-Bibliothek, Ingestion-Programm) sind quelloffen und unabhängig von einer konkreten App nutzbar — die Client-Bibliothek ist explizit dafür gedacht, in verschiedene Apps eingebunden zu werden, nicht nur in eine.

**Geografischer Geltungsbereich**: Initial ganz Europa, die Architektur ist aber von Anfang an auf eine spätere weltweite Ausweitung ausgelegt, nicht nur auf Deutschland/Europa fest verdrahtet (Details siehe Abschnitt 3.4).

---

## 2. Architekturübersicht

### 2.1 Repository-Struktur

Ein einzelnes GitHub-Repository (Monorepo) für das gesamte Backend-System — Server, Client-Bibliothek und Ingestion-Programm liegen als eigene Pakete/Ordner nebeneinander (z. B. `/server`, `/client-lib`, `/ingestion`, `/docs`), jeweils mit eigenem Build/eigener CI-Pipeline. Das steht nicht im Widerspruch zur Entkopplung aus Abschnitt 7: Die Trennung „kein privilegierter Zugriff, nur öffentliche API" ist eine **Architektur-Regel auf Code-Ebene**, keine Repo-Grenze — ein gemeinsames Repo erleichtert konsistente Versionierung von Schema und API-Verträgen zwischen den Paketen, ohne die Unabhängigkeit der Komponenten zur Laufzeit aufzuheben. Root-Ebene enthält gemeinsame Doku, Lizenz (Apache License 2.0, siehe Abschnitt 10) und die Definition der öffentlichen API/des Schemas als „Contract", gegen den alle Pakete getestet werden.

```
[Ingestion-Programm]
        │  (Bulk-Import als Seed-Events)
        ▼
[Relay-/Moderator-Server]
   ├─ Ereignisprotokoll (append-only, zeitlich begrenzt aufbewahrt)
   ├─ Materialisierter aktueller Zustand (PostGIS)
   ├─ Moderationsgate (Rate-Limit, Duplikat-Erkennung, Reputation)
   └─ Snapshot-Erzeugung (versioniert)
        │  (Snapshot beim Erststart, danach Delta-Sync / Pub-Sub-Push)
        ▼
[Client-Sync-Bibliothek]  ← eingebettet in beliebige Host-App
   ├─ Lokaler Speicher (SQLite + SpatiaLite)
   ├─ Sync-Engine (Snapshot-Bootstrap, Delta-Pull, regionale Subscription)
   ├─ Lokales Map-Matching, lokale Verfallsberechnung
   └─ Offline-Schreibpuffer
        │  (lokale Abfrage-API: getNearby, getSpeedLimitAt, submitReport, …)
        ▼
[Host-App]  ← z. B. die künftige Blitzer-Display-App, oder eine fremde App
```

Rückkanal: Eine Meldung/Bestätigung, die eine Host-App über die Client-Bibliothek erzeugt, wird lokal sofort übernommen (optimistisches Update), bei bestehender Verbindung sofort, sonst beim nächsten Verbindungsaufbau an den Server gesendet, dort moderiert und als Ereignis an alle betroffenen Geräte verteilt.

**Wichtig zur Stellung des Ingestion-Programms:** Es ist im Diagramm bewusst als externer Client gezeichnet, der denselben öffentlichen Bulk-Import-Endpunkt nutzt wie jeder andere autorisierte Client auch — es ist kein Kernbestandteil des Systems. Details und Begründung in Abschnitt 7.

---

## 3. Datenmodell

Zwei grundverschiedene Lebenszyklen — getrennt modelliert, sowohl serverseitig als auch im lokalen Client-Speicher.

### 3.1 Statische/semi-statische Entitäten

Ändern sich selten, werden **vollständig und global** synchronisiert (klein genug, siehe Abschnitt 3.3).

```
SpeedLimitSegment:
  id, geometry, speedLimit, speedLimitUnit (kmh|mph),
  source, sourceLicense, importedAt, lastConfirmedAt

StaticSign:
  id, position, signType (länderpräfigierte Katalog-Referenz, z. B. "DE:274" — nicht auf StVO/Deutschland beschränkt),
  source, sourceLicense, importedAt

FixedSpeedCamera:            // eigener Namensraum, siehe Abschnitt 8
  id, position, source, sourceLicense, importedAt, removalReports[]
```

### 3.2 Dynamische Live-Meldungen

Zeitlich verfallend, werden **regional gefiltert** synchronisiert (siehe Abschnitt 3.3), leben von Bestätigung/Widerspruch der Community.

```
HazardReport:
  id, type, position, reportedAt, reporterId,
  confirmations: [{reporterId, timestamp, "stillThere" | "gone"}],
  speedKmh?,
  expiresAt,                 // lokal berechnet: Grundverfallszeit + Verlängerung durch Bestätigungen
  status: active | expired | removed,
  source: "community" | "seed",
  sourceLicense?,
  regionTile                 // für regionale Sync-Filterung, siehe 3.3

HazardType-Enum:
  traffic, ice, accident, construction, breakdown, obstacle,
  fixedSpeedCamera, mobileSpeedCamera, trailerCamera, redLightCamera, distanceControl
```

**Verfallszeiten pro Typ** (Startwerte, konfigurierbar, keine Magic Numbers im Code):

| Typ | Grundverfallszeit | Verlängerung durch Bestätigung |
|---|---|---|
| Mobiler Blitzer / Rotlicht / Abstand | ~10–15 min | Ja |
| Stau, Unfall, Panne, Hindernis | ~20–30 min | Ja |
| Baustelle | Tage/Wochen (Enddatum falls bekannt) | Community kann „beendet" melden |
| Fester Blitzer | Kein automatischer Verfall | Nur durch gehäufte „nicht mehr da"-Meldungen entfernt |

**Provenienz-Metadaten sind Pflicht auf jedem Datensatz** (`source`, `sourceLicense`, `importedAt`) — unabhängig von der Ingestion-Strategie aus Abschnitt 4. Kostet beim Bauen nichts, erlaubt aber eine spätere gezielte Bereinigung nach Quelle in einer einzigen Query.

### 3.3 Synchronisationsumfang: global vs. regional

- **Statische Daten**: vollständig, global, an jedes Gerät — realistisch geschätzt niedriger einstelliger GB-Bereich für ganz Europa (siehe Abschnitt 6, Größenabschätzung), unproblematisch für jedes Gerät.
- **Dynamische Live-Meldungen**: nur für die aktuelle Umgebung/Fahrtroute des Geräts abonniert (Geo-Tiling, grobe Rasterung oder administrative Regionen als `regionTile`). Grund: nicht Speicherplatz, sondern Bandbreite/Akku — eine Live-Meldung aus einer anderen Region ist ohnehin meist verfallen, bevor das Gerät sie je erreicht. Das Gerät wechselt sein Abonnement dynamisch mit der Position.
- **Granularität der Region-Tiles** (z. B. Verwaltungsgrenzen vs. festes Raster): festes, global durchgängiges Raster (einfacher zu implementieren, unabhängig von Ländergrenzen, siehe 3.4) — konkrete Kachelgröße entscheidet Claude Code mit Begründung, zusammen mit der Wahl des Indexierungsschemas (Abschnitt 3.4).

### 3.4 Geografischer Geltungsbereich: Europa zuerst, weltweit vorgesehen

Der Start-Datenbestand deckt Europa ab, die Architektur ist aber so ausgelegt, dass eine spätere Ausweitung eine Konfigurationsänderung ist, kein Umbau:

- **Region-Tiling global, nicht Europa-spezifisch.** Für die `regionTile`-Rasterung aus Abschnitt 3.3 sollte ein etabliertes, weltweit durchgängiges räumliches Indexierungsschema verwendet werden (Kandidaten: Geohash, H3, S2 — alle Open Source, alle ohne Sonderfall an Kontinent-/Ländergrenzen), keine eigens für Europa gebaute Rasterung. Konkrete Wahl mit Begründung im späteren Server-Prompt.
- **OSM-Ingestion regionsparametrisiert.** Geofabrik stellt Extrakte pro Kontinent/Land bereit (aktuell z. B. Europa ~32,6 GB, Deutschland ~4,5 GB als Rohdaten). Der OSM-Worker im Ingestion-Programm (Abschnitt 7) wird so gebaut, dass die zu ladenden Extrakte über Konfiguration wählbar sind — weitere Kontinente lassen sich später ergänzen, ohne den Worker neu zu schreiben.
- **Schildtypen länderoffen modelliert.** `StaticSign.signType` nutzt eine länderpräfigierte Referenz (analog zu OSMs `traffic_sign=DE:*`, `FR:*`, …) statt fest auf den deutschen StVO-Katalog zu verweisen — andere Länder werden einfach als weitere Präfixe ergänzt.
- **HERE/TomTom sind ohnehin global verfügbar** — deren Anbindung im Ingestion-Programm braucht für eine Ausweitung keine strukturelle Änderung, nur ggf. mehr abgefragte Regionen/höheres Kontingent.
- **Amtliche Einzelquellen sind länderspezifisch und müssen pro Land neu recherchiert werden**, wenn die Abdeckung über Europa hinausgeht (die Autobahn-API/Mobilithek-Recherche gilt nur für Deutschland) — das ist ein bewusst späterer Schritt, kein Teil des jetzigen Scopes.
- **Rechtlicher Hinweis**: Die Blitzer-Rechtslage (§23 Abs. 1b StVO, Abschnitt 8) ist deutsches/teils EU-weit uneinheitliches Recht. Bei einer Ausweitung über Europa hinaus kann sich die Einschätzung pro Land unterscheiden — das globale Deaktivierungs-Flag reicht für den jetzigen Scope, eine feinere Länder-für-Länder-Steuerung wäre erst bei tatsächlicher weltweiter Aktivierung relevant und ist bewusst nicht Teil des jetzigen Konzepts.

---

## 4. Lizenz- & Quellen-Strategie

**Grundsatz, unverändert aus den Vorgesprächen:** „Kostenlos abrufbar" ≠ „darf weiterverteilt werden". Jeder Datensatz trägt Provenienz-Metadaten (Abschnitt 3), damit eine spätere Bereinigung nach Quelle möglich bleibt.

**Explizite Entscheidung zur Ingestion-Reichweite** (bewusst getroffen, siehe frühere Rückfrage): Das Ingestion-Programm ist **nicht** auf lizenzrechtlich unbedenkliche Quellen beschränkt. Es nutzt jede kostenlos zugängliche Quelle so weit wie möglich aus, einschließlich kommerzieller Freikontingente (HERE, TomTom u. a.), deren Nutzungsbedingungen Zwischenspeichern/Weiterverteilen typischerweise einschränken. Das ist ein akzeptiertes rechtliches Risiko für die Weiterverteilung dieser konkreten Datensätze über das offene Netzwerk — die Provenienz-Kennzeichnung bleibt trotzdem Pflicht, damit dieses Risiko später gezielt reduzierbar ist, falls gewünscht.

**Vorläufige Einschätzung der bisher recherchierten Quellen:**

| Quelle | Einschätzung | Status |
|---|---|---|
| OpenStreetMap (`maxspeed`, `traffic_sign`) | ODbL, Weiterverteilung mit Attribution/Share-Alike erlaubt | Unbedenklich |
| Deutsche Behörden-Open-Data (Mobilithek/MDM) | Oft DL-DE-BY, aber nicht pauschal anzunehmen | Pro Datensatz zu prüfen |
| Autobahn-API (bundesAPI/autobahn-api) | Keine explizite Lizenzangabe im Wrapper-Repo gefunden | Ungeklärt — wird trotzdem genutzt (siehe oben), Kennzeichnung als „ungeklärt" |
| HERE (Traffic API v7, Route Matching API v8) | AGB untersagen i. d. R. Caching/Weiterverteilung; 250.000 Transaktionen/Monat frei, danach 1 $/1.000 | Wird trotzdem genutzt, mit Kill-Switch (Abschnitt 7) |
| TomTom (Traffic Incidents/Flow API) | Ähnliche Einschränkung, mehrere Freikontingente unterschiedlicher Endpunkte | Wird trotzdem genutzt, mit Kill-Switch |

---

## 5. Server: Relay-/Moderator-System

### 5.1 Ereignisprotokoll

Append-only, jedes Ereignis mit: `id/sequence`, `timestamp`, `type` (`ReportCreated`, `ReportConfirmed`, `ReportDenied`, `ReportExpired`, `StaticDataUpdated`, `StaticDataRemoved`), `payload`, `regionTile`, `moderationStatus`, `source`.

**Aufbewahrung begrenzt**: Für normales Nachholen reicht ein Fenster von wenigen Tagen. Ein Gerät, das deutlich länger offline war, fordert stattdessen einen frischen Snapshot an, statt eine große Historie nachzuspielen. Statische Änderungen werden länger aufbewahrt (geringes Volumen).

### 5.2 Materialisierter Zustand

Postgres/PostGIS-Tabellen, die den aktuellen Stand abbilden (Spiegel des Datenmodells aus Abschnitt 3) — werden transaktional gemeinsam mit dem Ereignisprotokoll fortgeschrieben. Dient als Quelle für Snapshot-Erzeugung und als Kontext für die Moderation (z. B. „gibt es in der Nähe schon eine aktive Meldung desselben Typs").

### 5.3 Snapshot- und Delta-Mechanik

- **Snapshot**: periodisch oder on-demand erzeugter, versionierter Export des aktuellen Zustands (statische Daten vollständig; dynamische Daten optional nach `regionTile` gefiltert für Bootstrap eines neuen Geräts, das bereits eine Region kennt).
- **Delta**: „Ereignisse seit Sequenznummer X" — vom Client nach jedem Verbindungsaufbau angefragt.
- Neues Gerät ohne vorherigen Stand: lädt zunächst den aktuellen Snapshot, danach nur noch Deltas.

### 5.4 Moderationsgate

- **Synchron bei Schreibzugriff**: Rate-Limit pro Gerät/Reporter, Plausibilitätsprüfung (Position, Wertebereich), Duplikat-Erkennung (mehrere Meldungen desselben Typs in engem Radius/Zeitfenster werden zu Bestätigungen zusammengeführt statt als Einzelmeldungen verteilt).
- **Asynchron/nachgelagert**: Reputationsbewertung des Reporters, beeinflusst die Vertrauensstufe, mit der eine Meldung auf anderen Geräten angezeigt wird (z. B. „unbestätigt" vs. „mehrfach bestätigt") — kein manueller Prüfprozess, dafür sind Echtzeitdaten zu schnelllebig.
- **Pflicht-Vorstufe für den Blitzer-Namensraum**: siehe Abschnitt 8.

### 5.5 Transport

- **Push-Verteilung** (Server → Geräte): Publish/Subscribe-Protokoll, Kandidat MQTT (offene Broker wie Mosquitto/EMQX, für genau dieses Szenario — viele mobile Clients, wechselnde Konnektivität, themenbasierte Verteilung nach `regionTile` — ausgelegt) oder ein einfacherer WebSocket-Kanal.
- **Snapshot/Delta-Abruf**: einfaches HTTP.
- **Schreibzugriff** (Gerät → Server): HTTP POST an den Moderationsgate-Endpunkt.
- **Entscheidung, mit Begründung im späteren Prompt zu treffen**: MQTT vs. WebSocket vs. anderer Ansatz.

### 5.6 Plattform

Gleiche Anforderungen wie zuvor besprochen, aber entschärft: Der Server muss nicht mehr eine Live-Abfrage pro Fahrzeug pro Sekunde abfedern (das übernimmt jetzt der lokale Speicher jedes Geräts) — die Last besteht aus periodischen Sync-Zyklen vieler Geräte plus Schreibzugriffen. Kriterien bleiben: PostGIS-Unterstützung, migrationsfreier Upgrade-Pfad, kein Hard-Vendor-Lock-in. Konkrete Plattform-Wahl (Supabase, Neon, selbst gehostetes Postgres o. Ä.) bleibt offen für den späteren Prompt.

**Update (Föderation):** Der Server ist selbst hostbar (Docker oder ohne Docker hinter Apache/nginx/Caddy) und Teil eines offenen, föderierten Server-Netzwerks — Details in `docs/federation.md` (Abschnitt 13). Neon bleibt optional, Standard ist PostgreSQL+PostGIS im Compose-Stack.

---

## 6. Client-Sync-Bibliothek

- **Lokaler Speicher**: SQLite + SpatiaLite — leichtgewichtig, läuft auf Mobilgeräten, unterstützt Geo-Abfragen offline.
- **Größenabschätzung** (zur Einordnung, keine exakte Zusage): Der volle OSM-Rohdatensatz für Deutschland liegt bei 4,5 GB, für Europa bei 32,6 GB (Stand der Recherche) — enthält aber auch Gebäude, POIs, Landnutzung. Ein auf Straßengeometrie + Tempolimit-/Schild-Tags reduzierter Ausschnitt liegt realistisch deutlich darunter (grobe Schätzung: niedriger einstelliger GB-Bereich für ganz Europa). Live-Meldungen sind pro Datensatz klein (wenige hundert Byte) und durch die regionale Filterung (Abschnitt 3.3) ohnehin begrenzt.
- **Sync-Engine**: hält die letzte gesehene Sequenznummer, fordert bei Verbindungsaufbau Deltas an, spielt sie transaktional in den lokalen Speicher ein; bei zu großem Rückstand Fallback auf neuen Snapshot.
- **Regionale Subscription**: abonniert/deabonniert `regionTile`s dynamisch anhand der aktuellen Position (und optional gespeicherter Strecken).
- **Lokales Map-Matching**: leichtgewichtiger Algorithmus, der die aktuelle Position auf das wahrscheinlichste gespeicherte Straßensegment snappt, um das richtige Tempolimit zu bestimmen — kein volles Routing nötig.
- **Lokale Verfallsberechnung**: aus gespeichertem Zeitstempel + Regel, ohne Server-Roundtrip.
- **Offline-Schreibpuffer**: Meldungen/Bestätigungen werden bei fehlender Verbindung lokal vorgehalten und bei Wiederverbindung nachgereicht (optimistisches lokales Update, serverseitige Moderation greift verzögert).
- **Öffentliche lokale API** (Skizze, von einer Host-App aufgerufen):
  ```
  getNearby(position, radiusM, categories[]) -> HazardReport[]
  getSpeedLimitAt(position) -> { value, unit }
  submitReport(type, position, speedKmh?) -> reportId
  confirmReport(reportId, stillThere: bool)
  getSyncStatus() -> { lastSyncedAt, pendingWrites, subscribedTiles[] }
  ```
- **Portabilität** (**entschieden**): plattformunabhängiger Kern mit dünnen Bindings — Android, iOS/macOS, Flutter, React Native, Desktop/Server (C-ABI, Python, Node.js) und Web-Browser (WASM). Die Bibliothek ist ein Adapter, den beliebige Apps einbinden. Kernsprache/Toolchain und Speicher-Backend (SpatiaLite nur, wenn auf allen Zielen praktikabel) entscheidet Claude Code mit Begründung (siehe `docs/prompt-phase2-client-lib.md`).
- **Geräte-Identität** (**entschieden**): anonyme Geräteregistrierung — eine App authentifiziert sich mit einem App-Schlüssel und erhält pro Gerät ein pseudonymes Credential, damit Rate-Limit, Duplikat-Erkennung und Reputation pro Gerät greifen.
- **Statische Daten in Paketen** (**entschieden**): statt eines einzigen Voll-Snapshots werden statische Daten partitioniert und versioniert ausgeliefert (Manifest + Pakete), damit Geräte Änderungen — auch aus Bulk-Importen — erkennen und nur geänderte Teile laden.

---

## 7. Ingestion-Programm

**Architekturprinzip: Das Ingestion-Programm ist ein optionaler, austauschbarer Client — kein Kernbestandteil des Systems.** Es dient der Erstbefüllung (und optional gelegentlichen Auffrischung) der Datenbank, danach kann es beliebig deaktiviert, entfernt oder durch ein anderes/eigenes Füllprogramm ersetzt werden, ohne dass Server oder Client-Bibliothek angepasst werden müssen. Das ergibt sich zwingend aus dem Rest der Architektur, muss aber beim Bauen konsequent durchgehalten werden:

- **Kein privilegierter interner Zugang.** Das Programm authentifiziert sich über denselben Client-Credential-Mechanismus wie jeder andere Client (Abschnitt 5.4/5.5) — nur mit einer erweiterten Berechtigungsstufe („bulk-import" statt „einzelne Meldung"). Kein direkter Datenbankzugriff, keine Sonderschnittstelle, kein Hardcoding im Server, das speziell auf dieses eine Programm zugeschnitten ist.
- **Der Bulk-Import-Endpunkt ist öffentlich dokumentiert und für jeden autorisierten Client nutzbar** — nicht exklusiv für „das" Ingestion-Programm reserviert. Grundsätzlich könnte jemand anderes eine eigene, alternative Ingestion-Implementierung gegen dieselbe API schreiben.
- **Server und Client-Bibliothek dürfen keine Annahme treffen, dass das Ingestion-Programm läuft oder je gelaufen ist.** Ein frisch aufgesetzter Server mit leerer Datenbank ist ein gültiger, funktionierender Zustand — er liefert eben (noch) keine Daten aus. Das muss in Tests abgedeckt sein (Server/Client-Bibliothek laufen und starten fehlerfrei auch ohne je einen Ingestion-Lauf gesehen zu haben).
- **Betriebsmodell ist eine Entscheidung des Betreibers, nicht der Architektur**: einmalig für die Erstbefüllung laufen lassen und danach abschalten, periodisch zur Auffrischung weiterlaufen lassen (z. B. weil sich Tempolimits/Baustellen ändern und Community-Meldungen diese Lücke allein nicht zuverlässig schließen), oder von Anfang an komplett weglassen und die Datenbank ausschließlich über Community-Meldungen wachsen lassen — alle drei Betriebsarten müssen ohne Codeänderung an Server/Client-Bibliothek funktionieren.

Der übrige Aufbau bleibt gegenüber der Vorfassung unverändert:

- Ein Worker pro Quelle, Quellenkatalog eigenständig recherchiert und erweitert (Startpunkt: OSM, Autobahn-API, HERE Traffic API v7 + Route Matching API v8, TomTom, Mobilithek/MDM — Liste kein Deckel).
- Quota-Maximierung: Kontingent gleichmäßig über das Zeitfenster verteilt, exponentielles Backoff bei 429, strukturiertes Logging pro Quelle.
- **Kill-Switch** pro Quelle mit Pay-as-you-go jenseits des Freikontingents (v. a. HERE: 250.000/Monat frei, danach 1 $/1.000) — stoppt automatisch vor unerwarteten Kosten, sofern nicht ausdrücklich anders gewünscht.
- Normalisierung: Mapping-Modul pro Quelle auf das gemeinsame Schema (Abschnitt 3), inkl. Einheiten-Handling (Tempolimits in der vom Schild vorgegebenen Einheit übernehmen, nicht pauschal umrechnen).
- Läuft als eigenständiger Prozess/eigenes Repo, spricht ausschließlich über die öffentliche Bulk-Import-API des Servers.

---

## 8. Blitzer-Namensraum (rechtlich verbindlich)

- Blitzer-Kategorien (`fixedSpeedCamera`, `mobileSpeedCamera`, `trailerCamera`, `redLightCamera`, `distanceControl`) leben in einem eigenen Namensraum, über eine einzige globale Konfiguration deaktivierbar.
- **Standardmäßig deaktiviert.** Der Server filtert diese Kategorien aus Snapshots/Deltas heraus, solange das Flag aus ist.
- Grund: Sobald dieses Netzwerk Blitzer-Standorte verteilt, ist der Betreiber potenziell selbst Betreiber einer Verkehrsüberwachungs-Warninfrastruktur im Sinne von §23 Abs. 1b StVO — eine rechtlich ungeklärte Position für Plattformbetreiber. Diese Entscheidung wird erst nach rechtlicher Beratung getroffen, nicht eigenständig vom umsetzenden Code aktiviert.
- Modul wird vollständig gebaut und getestet — nur der Schalter für „live an andere ausliefern" bleibt aus, bis ausdrücklich freigegeben.

---

## 9. Weitere rechtliche Rahmenbedingungen

- **DSGVO**: Der Relay-Server verarbeitet zentral Positions- und pseudonyme Reporter-Daten (jede Meldung läuft durch ihn). Aufbewahrungsfristen, Zweckbindung, Datenschutzerklärung müssen vor der ersten echten Nutzermeldung stehen (`docs/privacy.md`).
- **Lizenzrisiko der Ingestion**: siehe Abschnitt 4 — bewusst akzeptiertes Risiko, durch Provenienz-Kennzeichnung eingrenzbar.
- **Blitzer-Betreiberrisiko**: siehe Abschnitt 8.

---

## 10. Offene Entscheidungen vor Prompt-Erstellung

| # | Entscheidung | Vorschlag | Status |
|---|---|---|---|
| 1 | Region-Tiling-Schema | Global durchgängiges Schema (Geohash/H3/S2), kein Europa-Sonderfall | Claude Code wählt konkretes Schema mit Begründung |
| 2 | Transport-Protokoll (Push) | MQTT | Claude Code entscheidet mit Begründung |
| 3 | Server-Plattform | Supabase/Neon/andere | Claude Code entscheidet mit Begründung |
| 4 | Tech-Stack API-Service | — | Claude Code entscheidet mit Begründung |
| 5 | Client-Bibliothek: portabler Kern vs. Flutter-spezifisch | Portabler Kern, alle Zielplattformen (Abschnitt 6) | **Entschieden** — Kernsprache/Toolchain entscheidet Claude Code |
| 6 | Log-Aufbewahrungsfenster (Tage) | — | Claude Code entscheidet mit Begründung |
| 7 | Repository-Struktur | Ein GitHub-Monorepo mit Paketen `/server`, `/client-lib`, `/ingestion` | **Entschieden** |
| 8 | Geografischer Start-Scope | Europa, Architektur weltweit-fähig (Abschnitt 3.4) | **Entschieden** |
| 9 | Open-Source-Lizenz für den Code | Apache License 2.0 | **Entschieden** |
| 10 | Baureihenfolge der drei Komponenten | Server (inkl. API) vollständig → Client-Sync-Bibliothek → Ingestion/Grundstock-Befüllung (siehe Abschnitt 11) | **Entschieden** |
| 11 | Regionale Filterung dynamischer Daten (Abschnitt 3.3) | Statisch global vollständig, dynamisch nur regional (`regionTile`-Abonnement) | **Entschieden** — Umsetzungsdetails entscheidet Claude Code |

---

## 11. Meilensteinplan — in drei Phasen, strikt sequenziert

**Baureihenfolge (verbindlich, bestätigt):** Phase 1 (Server samt API) wird vollständig fertiggestellt, bevor Phase 2 (Client-Sync-Bibliothek) beginnt. Phase 3 (Ingestion-Programm/Grundstock-Befüllung) kommt bewusst zuletzt. Das ist unabhängig von der technischen Abhängigkeit: Ingestion braucht architektonisch nur die stabile Server-API (Abschnitt 7), nicht die Client-Bibliothek — die Reihenfolge Server → Client-lib → Ingestion ist eine bewusste Priorisierung des Betreibers, keine technische Notwendigkeit.

### Phase 1 — Server (Relay/Moderator + API), vollständig

| # | Inhalt |
|---|---|
| P1.0 | Plattform-/Transport-/Tiling-/Stack-Entscheidungen recherchiert und begründet, offene Fragen an mich |
| P1.1 | Datenmodell + Migrations, Ereignisprotokoll + materialisierter Zustand |
| P1.2 | Snapshot-/Delta-Mechanik |
| P1.3 | Moderationsgate (synchrone Prüfungen) |
| P1.4 | Blitzer-Namensraum (separat, standardmäßig deaktiviert) |
| P1.5 | API vollständig (Bulk-Import-Endpunkt, Auth/Client-Credentials, Rate-Limits), dokumentiert und getestet — **Phase-1-Abschluss** |

### Phase 2 — Client-Sync-Bibliothek, startet erst nach Phase 1 (Phase 1 abgeschlossen)

| # | Inhalt |
|---|---|
| P2.0 | Server-Erweiterungen: anonyme Geräteregistrierung, partitionierte/versionierte statische Datenpakete + Manifest, ggf. Config-Endpunkt |
| P2.1 | Kern-Grundgerüst, lokaler Speicher, C-ABI-Skelett, CI-Matrix |
| P2.2 | Sync-Engine, WebSocket-Push, regionale Subscription, Paket-Updates |
| P2.3 | Lokales Map-Matching, lokale Verfallsberechnung, offline Schreibpuffer |
| P2.4 | Bindings für alle Zielplattformen + Konformitätstests |
| P2.5 | Öffentliche lokale API + Doku für Nachnutzer anderer Apps — **Phase-2-Abschluss** |

### Überarbeitung F — Self-Hosting & Föderation, nach Phase 2, vor Phase 3

| # | Inhalt |
|---|---|
| F-S0–F-S5 | Server: Docker + klassische Installation, Identitäten & Signaturen, Föderation, Reputation, Verzeichnis, Mehrknoten-Tests (`docs/prompt-rework-server-federation.md`) |
| F-C0–F-C5 | Client-Bibliothek: Signaturprüfung, gerätesignierte Identität, Discovery, Mehrserver-Transport, Failover (`docs/prompt-rework-client-lib-federation.md`) |

### Phase 3 — Ingestion-Programm (Grundstock-Befüllung), startet erst nach Phase 2

| # | Inhalt |
|---|---|
| P3.1 | Quellenkatalog recherchiert und mit Belegen dokumentiert |
| P3.2 | OSM-Worker zuerst (regionsparametrisiert, Start Europa) |
| P3.3 | Weitere Quellen (Autobahn-API, HERE, TomTom, ggf. weitere) inkl. Kill-Switches |
| P3.4 | Grundbefüllung durchgeführt — Ingestion-Programm danach optional abschaltbar (siehe Abschnitt 7), kein weiterer Zwang zum Dauerbetrieb |

### Begleitend, kein fester Phasenbezug

- Reputationsbewertung (nachgelagert)
- `docs/privacy.md` — vor der ersten echten Nutzermeldung über eine Host-App, also spätestens vor produktivem Einsatz von Phase 2
- Tests/CI durchgängig je Phase

---

## 12. Leitprinzipien für jeden künftigen Prompt

1. Erst planen, dann bauen — Plan-Modus, Rückfragen bei Unklarheit statt Annahmen.
2. Nichts erfinden — Lizenzen, Limits, API-Details mit Beleg dokumentieren.
3. Server ist Vermittler/Moderator/Bootstrap-Quelle, nicht Live-Abfrage-API.
4. Jeder Datensatz trägt Provenienz-Metadaten, unabhängig von der Ingestion-Reichweite.
5. Blitzer-Namensraum bleibt technisch isoliert und standardmäßig deaktiviert.
6. Statische Daten global vollständig, dynamische Daten regional gefiltert synchronisieren.
7. Das Ingestion-Programm ist ein optionaler, jederzeit abschaltbarer Client wie jeder andere — Server und Client-Bibliothek dürfen keine Abhängigkeit davon haben, dass es existiert oder läuft.
8. Code/Doku auf Englisch, dieses Konzept und Prompts auf Deutsch.
9. Vertraue Signaturen, nicht Servern: Jeder Server kann fremd sein — Daten werden kryptografisch geprüft, nicht wegen ihrer Herkunft akzeptiert (siehe Abschnitt 13).

---

## 13. Self-Hosting & Föderation

Entschieden: Jeder kann einen Server betreiben (Docker oder klassisch hinter Apache/nginx/Caddy). Neue Server treten dem Netzwerk automatisch bei (**offene Mitgliedschaft mit Reputation**), replizieren Daten und übernehmen Last. Clients finden Server über eine eingebaute Seed-Liste und ein signiertes Server-Verzeichnis, verteilen Anfragen und wechseln bei Ausfall automatisch. Jeder Server hat seine eigene HTTPS-Adresse; die (noch zu registrierende) Projekt-Domain dient nur als Anker für Verzeichnis, Seeds und optionale Node-Subdomains.

Konsequenzen:

- Gerätemeldungen werden **auf dem Gerät signiert** (asymmetrische Geräte-Identität statt gemeinsamem JWT-Secret).
- Statische Datenpakete sind inhaltsadressiert und signiert; Netzwerk-Konfiguration (inkl. Blitzer-Flag) ist vom Netzwerk-Wurzelschlüssel des Projektinhabers signiert.
- Replikationsmodell für dynamische Daten entscheidet Claude Code mit Begründung.
- Jeder Betreiber ist datenschutzrechtlich selbst verantwortlich → Betreiberbedingungen + erweiterte `docs/privacy.md`.

Vollständiges Konzept inkl. Vergleich der Domain-/Discovery-Optionen: `docs/federation.md`. Umsetzung: `docs/prompt-rework-server-federation.md` (zuerst), danach `docs/prompt-rework-client-lib-federation.md`.
