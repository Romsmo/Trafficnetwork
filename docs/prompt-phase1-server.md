# Prompt für Claude Code — Phase 1: Server (Relay-/Moderator-System + API)

> **Scope dieses Prompts:** Ausschließlich das Paket `server/` im bestehenden Monorepo `https://github.com/Romsmo/Trafficnetwork` (privat, Owner: Romsmo). Das Repo enthält bereits: root `README.md`, root `LICENSE` (Apache License 2.0), root `.gitignore`, `docs/concept.md` (vollständiges Architekturkonzept — **lies dieses Dokument zuerst, vollständig**), `docs/todo.md`, sowie Platzhalter-`README.md` in `server/`, `client-lib/` und `ingestion/`. Arbeite ausschließlich innerhalb von `server/`; die anderen Ordner nicht anfassen außer der bestehenden `server/README.md` (aktualisieren, sobald der Server steht).
>
> **Nicht Teil dieses Prompts:** `client-lib/` (Phase 2, eigener künftiger Prompt), `ingestion/` (Phase 3, eigener künftiger Prompt), Flutter-App, ESP32-Firmware — alles eigenständige, an anderer Stelle behandelte Projekte. Der Server darf zu keinem Zeitpunkt annehmen, dass `client-lib/` oder `ingestion/` existieren oder je laufen (siehe `docs/concept.md`, Abschnitt 7 und 12).

---

## 0. SETUP — REPO SELBST KLONEN

Du startest möglicherweise in einem leeren Arbeitsverzeichnis. Stelle das Repo **selbstständig** bereit, bevor du irgendetwas anderes tust (dieser Schritt ist vom Plan-Modus ausgenommen):

1. Prüfe, ob du dich bereits in einem Klon von `Romsmo/Trafficnetwork` befindest (`git remote -v`). Falls ja: `git checkout main && git pull`, weiter mit Schritt 4.
2. Falls nicht: klone das Repo selbst — `git clone https://github.com/Romsmo/Trafficnetwork.git` (alternativ `gh repo clone Romsmo/Trafficnetwork` oder per SSH `git@github.com:Romsmo/Trafficnetwork.git`) — und wechsle in das Verzeichnis `Trafficnetwork`.
3. Das Repo ist **privat**. Schlägt der Clone mangels Authentifizierung fehl: zeig mir die konkrete Fehlermeldung und nenne die Optionen (z. B. `gh auth login`, SSH-Key, Personal Access Token über den Git-Credential-Helper). Frag mich nie nach Passwörtern oder Tokens im Chat und lege keine Zugangsdaten im Repo oder in Dateien ab.
4. Prüfe, dass die erwartete Struktur vorhanden ist (`docs/concept.md`, `docs/todo.md`, `server/`, `client-lib/`, `ingestion/`). Fehlt etwas, melde es mir, statt es selbst anzulegen.
5. Danach weiter mit „Rolle & Arbeitsweise“. Alle Commits gehen in diesen Klon und werden nach jedem Meilenstein nach `origin` gepusht.

---

## ROLLE & ARBEITSWEISE

Du baust das Relay-/Moderator-Backend eines offenen, dezentralen Verkehrsdaten-Netzwerks (Local-First-Architektur): Der Server ist **nicht** die Quelle, die Endgeräte bei jeder Positionsprüfung live abfragen — das übernimmt später die lokale Speicherung jedes Geräts (`client-lib/`, Phase 2). Der Server vermittelt und moderiert Änderungen zwischen Geräten über ein Ereignisprotokoll plus Snapshot-/Delta-Sync.

Arbeitsregeln für die gesamte Session:

1. **Erst planen, dann bauen.** Plan-Modus zuerst. Lies `docs/concept.md` vollständig, recherchiere die offenen Entscheidungen (Abschnitt „Offene Entscheidungen, die du triffst" unten) eigenständig, lege mir Plan + Meilensteine vor, warte auf Freigabe.
2. **Bei offenen Fragen: frag mich.** Konkrete Optionen mit Empfehlung, nicht raten.
3. **Nichts erfinden.** Keine angenommenen Preise/Limits/API-Verhalten einer Plattform oder Bibliothek — mit Beleg (Link/Datum) dokumentieren, da sich Free-Tier-Konditionen und APIs ändern.
4. **Inkrementell und grün.** Nach jedem Meilenstein: Build läuft, Tests laufen, Commit + Push, kurze Zusammenfassung.
5. **Sprache:** Code, Kommentare, Commit-Messages, README, `docs/` auf Englisch. Dieser Prompt und deine Rückfragen an mich auf Deutsch.
6. **Keine Annahme, dass Ingestion oder Client-Bibliothek existieren.** Ein frisch aufgesetzter Server mit leerer Datenbank ist ein gültiger, funktionierender Zustand (liefert einfach noch keine Daten aus) — das muss durch einen Test abgedeckt sein.

---

## 1. ARCHITEKTUR-LEITPLANKEN (verbindlich, aus `docs/concept.md`)

- Der Server ist **Vermittler/Moderator/Bootstrap-Quelle**, keine Live-Abfrage-API für Einzelfahrzeuge — die Last besteht aus periodischen Sync-Zyklen vieler Geräte plus Schreibzugriffen, nicht aus einer Live-Abfrage pro Fahrzeug pro Sekunde.
- **Jeder Datensatz trägt Provenienz-Metadaten** (`source`, `sourceLicense`, `importedAt`) — unabhängig davon, ob die Daten je über ein Ingestion-Programm eingespielt wurden oder ausschließlich aus Community-Meldungen stammen.
- **Statische Daten vollständig und global**, **dynamische Live-Meldungen nur regional gefiltert** synchronisiert (siehe Abschnitt 3 unten).
- **Blitzer-Namensraum bleibt technisch isoliert und standardmäßig deaktiviert** (siehe Abschnitt 6).
- **Der Bulk-Import-Endpunkt ist ein normaler, öffentlich dokumentierter API-Endpunkt** mit erweiterter Berechtigungsstufe — kein Sonderzugang, kein Hardcoding auf ein bestimmtes künftiges Ingestion-Programm. Jeder authentifizierte Client mit der passenden Berechtigung darf ihn nutzen.
- **Geografischer Scope**: Datenmodell und Tiling von Anfang an weltweit-fähig auslegen, auch wenn der tatsächliche Datenbestand zunächst nur Europa abdeckt (siehe Abschnitt 3 und `docs/concept.md` Abschnitt 3.4). Das betrifft insbesondere: kein Europa-spezifisches Tiling-Schema, `StaticSign.signType` länderpräfigiert statt hart auf die deutsche StVO verdrahtet.

---

## 2. OFFENE ENTSCHEIDUNGEN, DIE DU TRIFFST (mit Begründung im Plan)

Alle folgenden Punkte sind bewusst an dich delegiert — ich möchte keine Rückfrage dazu, sondern deine recherchierte Entscheidung samt Begründung im Plan:

1. **Region-Tiling-Schema**: konkretes global durchgängiges räumliches Indexierungsschema (Kandidaten: Geohash, H3, S2) inklusive konkreter Kachel-/Auflösungsstufe für `regionTile`. Muss weltweit ohne Sonderfall an Kontinent-/Ländergrenzen funktionieren.
2. **Transport-Protokoll für Push-Verteilung** (Server → Geräte): MQTT (z. B. Mosquitto/EMQX) vs. WebSocket vs. anderer Ansatz.
3. **Server-Plattform**: Supabase, Neon, oder selbst gehostetes Postgres+PostGIS — anhand der Kriterien in Abschnitt 4.
4. **Tech-Stack für den API-Service**: von einer Einzelperson betreibbar, kein Overengineering für ein MVP mit anfangs wenigen Nutzern, aber ohne Sackgasse beim späteren Hochskalieren.
5. **API-Stil**: REST oder GraphQL.
6. **Log-Aufbewahrungsfenster** für das Ereignisprotokoll (wie viele Tage Delta-Nachholbarkeit, bevor ein Client auf einen neuen Snapshot zurückfällt) — konfigurierbarer Wert, keine Magic Number im Code.

---

## 3. DATENMODELL

Zwei grundverschiedene Lebenszyklen — getrennt modellieren.

### 3.1 Statische/semi-statische Entitäten (vollständig, global synchronisiert)

```
SpeedLimitSegment:
  id, geometry (Straßensegment), speedLimit, speedLimitUnit (kmh|mph),
  source, sourceLicense, importedAt, lastConfirmedAt

StaticSign:
  id, position, signType (länderpräfigierte Katalog-Referenz, z. B. "DE:274", "FR:..."
    — analog zu OSMs traffic_sign=DE:*/FR:* — NICHT hart auf den deutschen
    StVO-Katalog verdrahtet),
  source, sourceLicense, importedAt

FixedSpeedCamera:            // eigener Namensraum, siehe Abschnitt 6
  id, position, source, sourceLicense, importedAt, removalReports[]
```

### 3.2 Dynamische Live-Meldungen (regional gefiltert synchronisiert)

```
HazardReport:
  id, type, position, reportedAt, reporterId,
  confirmations: [{reporterId, timestamp, "stillThere" | "gone"}],
  speedKmh?,                 // bei mobilen Geschwindigkeitskontrollen
  expiresAt,                 // berechnet: Grundverfallszeit + Verlängerung durch Bestätigungen
  status: active | expired | removed,
  source: "community" | "seed",
  sourceLicense?,             // nur bei seed relevant
  regionTile                  // Tiling-Schema: deine Entscheidung, Abschnitt 2.1

HazardType-Enum (fixiert, Reihenfolge nicht ändern, nur anhängen):
  traffic, ice, accident, construction, breakdown, obstacle,
  fixedSpeedCamera, mobileSpeedCamera, trailerCamera, redLightCamera, distanceControl
```

**Verfallszeiten pro Typ** (Startwerte, konfigurierbar halten, keine Magic Numbers im Code):

| Typ | Grundverfallszeit | Verlängerung durch Bestätigung |
|---|---|---|
| Mobiler Blitzer / Rotlicht / Abstand | ~10–15 min | Ja |
| Stau, Unfall, Panne, Hindernis | ~20–30 min | Ja |
| Baustelle | Tage/Wochen (Enddatum falls aus Quelle bekannt) | Community kann „beendet" melden |
| Fester Blitzer | Kein automatischer Verfall | Nur durch gehäufte „nicht mehr da"-Meldungen entfernt |

**Einheiten-Handling**: Tempolimits werden in der Einheit übernommen, die die Quelle/das Schild vorgibt (`speedLimitUnit`), nicht pauschal in km/h umgerechnet.

---

## 4. PLATTFORM-ANFORDERUNGEN

- **PostGIS-fähig** (oder gleichwertige Geo-Erweiterung) für Nearest-Neighbor-/Bounding-Box-/`regionTile`-Abfragen.
- **Kein Totalverlust bei Inaktivität**: Falls die Plattform bei Inaktivität pausiert, muss der Zustand beim Aufwachen erhalten bleiben.
- **Migrationsfreier Upgrade-Pfad**: Wachstum von „ein Test-Nutzer" zu „viele gleichzeitige Nutzer" darf keine Datenmigration/Plattformwechsel erzwingen.
- **Kein Hard-Vendor-Lock-in**: Standard-Postgres-Wire-Protokoll, Daten jederzeit exportierbar.
- Verbindungsmanagement für periodische Sync-Zyklen vieler Geräte ausgelegt — nicht für eine Live-Abfrage pro Fahrzeug pro Sekunde (das entfällt durch die Local-First-Architektur).

Entscheidungskriterien in dieser Reihenfolge: (1) PostGIS-Unterstützung, (2) migrationsfreier Upgrade-Pfad, (3) nutzbarer Free-Tier fürs MVP, (4) Vendor-Lock-in-Risiko.

---

## 5. SERVER-KERNMECHANIK

### 5.1 Ereignisprotokoll

Append-only, jedes Ereignis mit: `id/sequence`, `timestamp`, `type` (`ReportCreated`, `ReportConfirmed`, `ReportDenied`, `ReportExpired`, `StaticDataUpdated`, `StaticDataRemoved`), `payload`, `regionTile`, `moderationStatus`, `source`.

Aufbewahrung begrenzt auf das von dir festgelegte Fenster (Abschnitt 2, Punkt 6). Ein Gerät, das deutlich länger offline war, fordert einen frischen Snapshot an statt eine große Historie nachzuspielen. Statische Änderungen länger aufbewahren (geringes Volumen).

### 5.2 Materialisierter Zustand

Postgres/PostGIS-Tabellen, die den aktuellen Stand abbilden (Spiegel des Datenmodells aus Abschnitt 3) — transaktional gemeinsam mit dem Ereignisprotokoll fortgeschrieben. Dient als Quelle für Snapshot-Erzeugung und als Kontext für die Moderation.

### 5.3 Snapshot- und Delta-Mechanik

- **Snapshot**: periodisch oder on-demand erzeugter, versionierter Export des aktuellen Zustands (statische Daten vollständig; dynamische Daten nach `regionTile` gefiltert).
- **Delta**: „Ereignisse seit Sequenznummer X" — vom Client nach jedem Verbindungsaufbau angefragt.
- Neues Gerät ohne vorherigen Stand lädt zunächst den aktuellen Snapshot, danach nur noch Deltas.

### 5.4 Moderationsgate

- **Synchron bei Schreibzugriff**: Rate-Limit pro Gerät/Reporter, Plausibilitätsprüfung (Position, Wertebereich), Duplikat-Erkennung (mehrere Meldungen desselben Typs in engem Radius/Zeitfenster werden zu Bestätigungen zusammengeführt statt als Einzelmeldungen verteilt).
- **Asynchron/nachgelagert**: Reputationsbewertung des Reporters (grob genügt fürs MVP; kein manueller Prüfprozess, dafür sind Echtzeitdaten zu schnelllebig), beeinflusst die Vertrauensstufe, mit der eine Meldung angezeigt wird.
- **Pflicht-Vorstufe für den Blitzer-Namensraum**: siehe Abschnitt 6.

### 5.5 Transport

- **Push-Verteilung** (Server → Geräte): deine Entscheidung, Abschnitt 2, Punkt 2.
- **Snapshot/Delta-Abruf**: einfaches HTTP.
- **Schreibzugriff** (Gerät → Server): HTTP POST an den Moderationsgate-Endpunkt.

---

## 6. BLITZER-NAMENSRAUM (RECHTLICH VERBINDLICH)

- Kategorien `fixedSpeedCamera`, `mobileSpeedCamera`, `trailerCamera`, `redLightCamera`, `distanceControl` leben in einem **eigenen Namensraum/Modul**, über eine einzige globale Konfiguration deaktivierbar.
- **Standardmäßig deaktiviert.** Der Server filtert diese Kategorien aus Snapshots/Deltas/API-Antworten heraus, solange das Flag aus ist.
- Grund: Sobald dieses Netzwerk live Blitzer-Standorte verteilt, ist der Betreiber potenziell selbst Betreiber einer Verkehrsüberwachungs-Warninfrastruktur im Sinne von §23 Abs. 1b StVO — eine rechtlich ungeklärte Position, zu der ich erst nach eigener rechtlicher Beratung eine Entscheidung treffe. **Du aktivierst dieses Flag nicht eigenständig für den produktiven Betrieb.**
- Baue und teste das Modul trotzdem vollständig — nur der Schalter für „live an andere ausliefern" bleibt aus.

---

## 7. API-DESIGN

Stil: deine Entscheidung (Abschnitt 2, Punkt 5).

**Lesen:**
- Gefahren/Tempolimits nahe Position (Radius) oder nach `regionTile`, gefiltert nach Kategorie (Blitzer-Kategorien nur wenn Flag aktiv, siehe Abschnitt 6)
- Einzelabfrage: Tempolimit für genaue Position
- Snapshot-Abruf (aktueller Zustand, versioniert)
- Delta-Abruf (Ereignisse seit Sequenznummer X)

**Schreiben:**
- Meldung erstellen (`HazardReport`)
- Meldung bestätigen/verwerfen (`stillThere`/`gone`)
- **Bulk-Import-Endpunkt**: öffentlich dokumentiert, authentifiziert, erweiterte Berechtigungsstufe („bulk-import"-Scope statt „einzelne Meldung"). Wird später von einem noch nicht existierenden Ingestion-Programm (Phase 3) genutzt — der Server darf dafür **keine** Sonderlogik enthalten, die nur für dieses eine künftige Programm gedacht ist. Baue und teste den Endpunkt trotzdem vollständig, z. B. mit einem Test-Client/Fixture, der Bulk-Daten einspielt.

**Querschnitt:**
- Versionierung (`/v1/...`), Pagination, Rate-Limits pro Client-Typ von Anfang an
- Auth: Client-Credential-Mechanismus mit Berechtigungs-Scopes pro Client (mindestens: normaler Client, Bulk-Import-Client) — kein Sonderzugang am Auth-System vorbei
- Hintergrund-Job für Verfall/Expiry (Status-Übergänge `active → expired`)

---

## 8. NICHT-ZIELE DIESES PROMPTS

- Keine Ingestion-Logik — das ist Phase 3, ein separates künftiges Projekt/Paket (`ingestion/`), das ausschließlich über die in Abschnitt 7 definierte Bulk-Import-API mit diesem Service spricht, nie direkt auf die Datenbank.
- Keine Client-Sync-Bibliothek — das ist Phase 2 (`client-lib/`), folgt erst nach Abschluss dieses Prompts.
- Keine Flutter-App, keine ESP32-Firmware — eigene, bereits an anderer Stelle behandelte Projekte.
- Keine Reputations-/Anti-Abuse-Logik über das Nötigste hinaus (Rate-Limiting + grobe Reputationsbewertung) — Vertiefung ist ein späteres, eigenes Thema.
- Kein `docs/privacy.md` in diesem Prompt (folgt spätestens vor Phase 2, siehe `docs/todo.md`) — aber leg beim Datenmodell keine Steine in den Weg dafür (z. B. Reporter-IDs pseudonym, nicht Klarnamen).

---

## 9. MEILENSTEINE

| # | Inhalt |
|---|---|
| P1.0 | Plattform-/Transport-/Tiling-/Stack-/API-Stil-Entscheidungen recherchiert und begründet (Abschnitt 2), Plan vorgelegt, offene Fragen an mich |
| P1.1 | Datenmodell + Migrations, Ereignisprotokoll + materialisierter Zustand (Abschnitt 3, 5.1, 5.2) |
| P1.2 | Snapshot- und Delta-Mechanik (Abschnitt 5.3) |
| P1.3 | Moderationsgate — synchrone Prüfungen (Abschnitt 5.4) |
| P1.4 | Blitzer-Namensraum, separat, standardmäßig deaktiviert (Abschnitt 6) |
| P1.5 | API vollständig (Bulk-Import-Endpunkt, Auth/Client-Credentials mit Scopes, Rate-Limits, Versionierung), dokumentiert (`docs/api.md`, `docs/schema.md` innerhalb von `server/`) und getestet, inkl. Test „leere Datenbank ist ein gültiger Zustand" — **Phase-1-Abschluss** |

Nach jedem Meilenstein: `server/README.md` aktualisieren (ersetzt den aktuellen Platzhaltertext), Commit + Push, kurze Zusammenfassung an mich.

---

## 10. WAS ICH VON DIR ERWARTE, BEVOR DU CODE SCHREIBST

1. Bestätigung, dass du `docs/concept.md` vollständig gelesen hast, und Anmerkungen, falls dir dort etwas widersprüchlich zu diesem Prompt erscheint (dieser Prompt ist im Zweifel maßgeblich, da er der Umsetzungsauftrag ist — aber sag mir, wenn dir ein Widerspruch auffällt).
2. Deine Entscheidungen zu Abschnitt 2 (Region-Tiling-Schema, Transport-Protokoll, Server-Plattform, Tech-Stack, API-Stil, Log-Aufbewahrungsfenster), jeweils mit Begründung und Beleg.
3. Deine Datenbank-Schema-Skizze.
4. Deine API-Endpunkt-Skizze.
5. **Deine Liste offener Fragen an mich.**
