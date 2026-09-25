# Zusatz-Prompt — Quellenkatalog importieren (Blitzer, Baustellen, Verkehrsschilder)

> **Für den Ingestion-Chat.** Branch `phase3/source-catalogue`. Baut auf `docs/prompt-phase3-ingestion.md` und `docs/prompt-addon-europe-basemap.md` auf (Europa-Grundstock aus OSM). Dieser Zusatz erweitert den Quellenkatalog um Blitzer, Baustellen und Verkehrsschilder.
>
> **Grundlage ist die Recherche des Betreibers** (unten als Ausgangspunkt zusammengefasst). Sie ist ein Startpunkt, **kein Beleg**: Jede Lizenz-, Format- und Limitangabe prüfst du selbst nach und dokumentierst sie mit Link und Abrufdatum in `ingestion/docs/sources.md`.

---

## 0. Rechtlicher Rahmen (verbindlich, gilt für jede Quelle)

- **Datenbankschutzrecht (§ 87a ff. UrhG / EU-Datenbankrichtlinie):** Das Entnehmen wesentlicher Teile einer fremden Datenbank ist auch dann unzulässig, wenn die einzelnen Datenpunkte für sich genommen frei wären. Eine Quelle wird nur eingebunden, wenn ihre Lizenz oder Nutzungsbedingungen die **Weiterverteilung** ausdrücklich erlauben — oder ich sie nach deiner Vorlage ausdrücklich freigebe.
- **Nicht einbinden, keine Ausnahme:** Google Maps, HERE, TomTom, Blitzer.de, Radarbot und vergleichbare proprietäre Dienste. Kein Scraping, kein Umgehen von Login-Schranken, Bot-Schutz oder API-Limits — auch nicht „nur zum Testen".
- **Provenienz ist Pflicht** auf jedem importierten Datensatz (`source`, `sourceLicense`, `importedAt`), damit eine Quelle später in einer einzigen Abfrage wieder entfernt werden kann.
- **Attribution:** ODbL (OSM) verlangt Namensnennung und Share-alike; andere Quellen haben eigene Auflagen. Sammle sie in `ingestion/docs/attribution.md` und melde mir, was davon in der Weboberfläche erscheinen muss.
- **Ampel pro Quelle** in `ingestion/docs/sources.md`: `frei` (Weiterverteilung erlaubt, Beleg), `auflagen` (erlaubt mit Bedingungen — welche), `ungeklärt` (nicht standardmäßig aktiv, Rückfrage an mich), `verboten` (wird nicht gebaut). Jede Quelle ist einzeln abschaltbar; `ungeklärt` startet immer deaktiviert.
- Rechtsberatung bleibt meine Aufgabe. Du lieferst die belegte Entscheidungsgrundlage, keine Rechtsauskunft.

---

## 1. Ausgangspunkt aus meiner Recherche (zu prüfen, nicht zu glauben)

**Feste Blitzer:** OSM, `highway=speed_camera`, ODbL, gute Abdeckung in DE/CH/AT/NL. Abfrage per Overpass API möglich.

**Baustellen:**
- Deutschland: Autobahn GmbH API (`https://verkehr.autobahn.de/o/autobahn/`), Mobilithek (BMVI).
- Europa: fast alle Straßenbehörden liefern **DATEX II** (EU-einheitliches XML) über ihren nationalen Zugangspunkt (NAP), vernetzt über **NAPCORE**: mobilithek.info (DE), mobilitaetsdaten.at (AT), opendata.swiss (CH), ndwcloud.nl (NL), transport.data.gouv.fr (FR), data.mobility.brussels (BE), data.gov.be (BE), GDDKiA (PL), Highways England / one.network (UK).

**Verkehrsschilder:**
- OSM `traffic_sign=*` (z. B. `DE:206`, `DE:274;90`) — lückenhaft, aber europaweit und ODbL.
- Mapillary (Meta) und KartaView: KI-Erkennung aus Straßenfotos — ToS und API-Limits prüfen.
- Amtliche Quellen mit sehr guter Qualität: **Digiroad** (FI), **NVDB** (SE), **Vejman** (DK), **NDW/WEGGEG** (NL); Deutschland (BASt/SIB) kaum offen.
- Eine europaweit einheitliche, vollständige Open-Data-Schilddatenbank existiert nicht — die Lücke wird nicht durch Schätzungen gefüllt, sondern bleibt eine Lücke.

---

## 2. Wichtige Korrektur zur Abrufmethode

Für den **europaweiten Massenimport** nicht die Overpass API verwenden: Sie ist für kleine, gezielte Abfragen gedacht, und eine Europa-Abfrage wäre sowohl unzuverlässig als auch unhöflich gegenüber dem Betrieb. Blitzer (`highway=speed_camera`) und Schilder (`traffic_sign=*`) kommen aus **demselben Geofabrik-PBF**, den der Grundstock-Import ohnehin verarbeitet — ein Durchlauf, drei Entitätstypen. Overpass bleibt nur für kleine Nachzieh-Abfragen einzelner Gebiete; dann mit Rate-Limit, `User-Agent` und Backoff nach den Nutzungsregeln (belegen).

---

## 3. Arbeitspakete

### 3.1 Blitzer aus OSM — alle Bauarten, nicht nur Geschwindigkeit

OSM erfasst Überwachungsanlagen auf **zwei** Wegen. Wer nur `highway=speed_camera` liest, übersieht Rotlichtblitzer und Abschnittskontrollen vollständig:

1. **Einzelner Knoten** `highway=speed_camera` — klassischer, fest installierter Geschwindigkeitsblitzer.
2. **Relation** `type=enforcement` mit `enforcement=*` — der allgemeine Fall, mit Mitgliedern in den Rollen `device` (die Anlage), `from`/`to` (Beginn/Ende der Überwachung) und teils `force`/`section`. Werte des Schlüssels u. a.: `maxspeed`, `traffic_signals` (**Rotlichtblitzer**), `average_speed` (Abschnittskontrolle), `mindistance` (Abstandskontrolle), dazu `check`, `access`, `maxweight`, `maxheight`, `mobile_phone`, `seatbelt`, `toll`. Bei `enforcement=traffic_signals` trägt der `device`-Knoten typischerweise `highway=traffic_signals` — **kein** `highway=speed_camera`.

**Abzubilden auf unsere Kategorien:**

| OSM | Unsere Kategorie |
|---|---|
| `highway=speed_camera` (Knoten) bzw. `enforcement=maxspeed` | `fixedSpeedCamera` |
| `enforcement=traffic_signals` | `redLightCamera` |
| `enforcement=mindistance` | `distanceControl` |
| `enforcement=average_speed` (Abschnittskontrolle) | **offen — siehe unten** |
| alle übrigen Werte (`check`, `toll`, `seatbelt` …) | nicht importieren |

**Zwei Punkte, die du klären musst, bevor du importierst — beide gehen an mich:**

- **Abschnittskontrolle** hat in unserem festen Kategorien-Enum keine Entsprechung. Entweder auf `fixedSpeedCamera` abbilden (mit Vermerk in den Quelldaten) oder das Enum **anhängen** (Reihenfolge der bestehenden Werte nicht ändern) — das wäre eine Server-Änderung. Vorschlag mit Begründung vorlegen.
- **Dauerhaft vs. verfallend:** `fixedSpeedCamera` ist eine statische Entität mit eigener Tabelle; `redLightCamera`, `distanceControl` und die mobilen Kategorien sind bisher **zeitlich verfallende Meldungen** (Minuten). Eine fest installierte Rotlichtanlage als 15-Minuten-Meldung zu importieren wäre falsch — sie verschwände sofort wieder. Kläre mit mir, ob der Server dafür eine statische Darstellung bekommt (additive Erweiterung, analog zu den festen Blitzern) oder ob wir Rotlicht- und Abstandsanlagen vorerst **nicht** importieren. Bis das entschieden ist: nicht importieren, statt etwas einzuspielen, das nach 15 Minuten verfällt.

Weiteres:

- Stabile Quell-ID ist die OSM-ID (Knoten oder Relation), Provenienz ODbL.
- Vorhandene Zusatzangaben (z. B. `maxspeed` der überwachten Stelle, Richtung) übernehmen, fehlende **nicht raten**.
- Bei Relationen die Position der `device`-Mitglieder verwenden; fehlt `device`, die Relation überspringen und im Qualitätsbericht zählen.
- **Der Blitzer-Namensraum bleibt serverseitig deaktiviert.** Import ja, Auslieferung nein — das Flag rührst du nicht an.

Belege für die Tagging-Schemata: OSM-Wiki `Relation:enforcement` und `Tag:highway=speed_camera` (Stand prüfen und mit Abrufdatum dokumentieren).

### 3.2 Baustellen (DATEX II + Autobahn GmbH)
- Baustellen sind **zeitlich begrenzte Meldungen** (`construction`) mit Start- und Enddatum, kein statischer Bestand. Import über die Bulk-Import-API als `source: "seed"`, mit Enddatum aus der Quelle, wo vorhanden.
- **Ein einmaliger Import veraltet schnell.** Bau deshalb den DATEX-II-Anbinder von Anfang an so, dass er periodisch laufen kann (Intervall konfigurierbar, Vorschlag stündlich bis täglich), und sag mir im Plan, was ein Dauerbetrieb kostet — die Entscheidung, ob er läuft, treffe ich.
- Beginne mit **zwei** Quellen (Vorschlag: Autobahn GmbH für Deutschland und ein NAP mit gut dokumentiertem DATEX II), einheitlicher Normalisierung und generischem DATEX-II-Leser. Weitere Länder sind dann Konfiguration, nicht neuer Code.
- Für jede NAP klären und dokumentieren: Registrierung nötig? Lizenz? Format (DATEX II v2/v3, JSON-Varianten)? Aktualisierungstakt? Koordinatensystem?
- Dubletten zwischen Quellen (dieselbe Baustelle aus zwei Feeds) über Position, Zeitraum und Quell-ID zusammenführen, nicht doppelt anlegen.

### 3.3 Verkehrsschilder
- **Basis:** `traffic_sign=*` aus dem OSM-Durchlauf, mit länderpräfigiertem Code, wie er in der Quelle steht (`DE:206`, `DE:274;90` → Wert und Zusatz getrennt ablegen, Rohwert erhalten).
- **Amtliche Quellen** (Digiroad, NVDB, Vejman, NDW/WEGGEG): jeweils Lizenz, Format und Zugang prüfen; Koordinaten aus den nationalen Systemen (z. B. ETRS89-basiert) nach WGS84 umrechnen; nationale Schildcodes auf das gemeinsame Schema abbilden. Mapping-Tabellen pro Land als Datei, nicht im Code, und unbekannte Codes **unverändert durchreichen** statt zu verwerfen.
- **Mapillary / KartaView:** erst Lizenz und ToS belegen (insbesondere, ob abgeleitete Erkennungen weiterverteilt werden dürfen), dann entscheiden. Standardmäßig **aus**, Einbindung nur nach meiner Freigabe. Kein Umgehen von API-Limits, kein Bilddownload in großem Stil.
- **ML-Datensätze** (GTSRB, BTSD, STSD, Mapillary Traffic Sign Dataset) sind **kein Importmaterial** — sie dienen höchstens der Validierung einer späteren Erkennung. In diesem Auftrag: nicht importieren, nur im Quellenkatalog als Möglichkeit vermerken.

### 3.4 Gemeinsame Infrastruktur
- Ein Worker pro Quelle hinter einem eigenen Schalter, gemeinsames Normalisierungs-Modul, gemeinsame Wiederaufnahme, gemeinsames Rate-Limit/Backoff.
- Kill-Switch und Kontingentgrenze für jede Quelle mit Aufrufkosten oder Limits.
- Qualitätsbericht nach jedem Lauf: je Quelle übernommene, verworfene und zusammengeführte Datensätze, mit Gründen für das Verwerfen.
- Community-Korrekturen (siehe `docs/prompt-addon-speed-limit-corrections.md`) werden nie still überschrieben.

---

## 4. Tests

- Unit: Normalisierung je Quelle (DATEX II, Digiroad, NVDB, OSM-Tags), Koordinatenumrechnung, Schildcode-Mapping, Dublettenerkennung, Zeitraum-Logik bei Baustellen.
- Integration in CI gegen einen echten Server: kleine, eingecheckte Beispieldateien je Quelle (echte Ausschnitte, keine erfundenen), leere Datenbank → Import → API liefert die Daten → zweiter Lauf erzeugt keine Duplikate → Abbruch und Wiederaufnahme funktionieren.
- Ein Test, der nachweist, dass Blitzer trotz Import nicht ausgeliefert werden, solange das Flag aus ist.

---

## 5. Meilensteine

| # | Inhalt |
|---|---|
| Q0 | Quellenkatalog mit belegten Lizenzen, Formaten, Limits und Ampel je Quelle; Plan und offene Fragen an mich — **vor jedem Code** |
| Q1 | Blitzer aus dem bestehenden OSM-Durchlauf (Namensraum bleibt deaktiviert) |
| Q2 | Schilder aus OSM, Codes länderoffen, Rohwert erhalten |
| Q3 | Baustellen: generischer DATEX-II-Leser + Autobahn GmbH, periodisch lauffähig gebaut |
| Q4 | Eine amtliche Schildquelle vollständig (Vorschlag: Digiroad oder NVDB) inkl. Umrechnung und Mapping |
| Q5 | Qualitätsbericht, `ingestion/docs/sources.md` und `attribution.md` vollständig, CI grün — Pull Request |

---

## 6. Was ich vor dem Code erwarte

1. Der Quellenkatalog aus Q0 als Tabelle: Quelle, Inhalt, Lizenz mit Link und Datum, Format, Zugang (Registrierung?), Limits, Ampel, Aufwand.
2. Wo meine Recherche nicht stimmt oder veraltet ist — sag es deutlich.
3. Dein Vorschlag, mit welchen zwei bis drei Quellen wir starten, damit früh Nutzen entsteht.
4. Deine Liste offener Fragen an mich, insbesondere: Soll der Baustellen-Anbinder dauerhaft laufen, und welche Länder haben Vorrang?
