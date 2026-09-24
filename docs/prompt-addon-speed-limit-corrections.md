# Zusatz-Prompts — Falsche Tempolimits melden und korrigieren (Server, Weboberfläche, Client-Bibliothek)

> **Wunsch des Betreibers:** Nutzer sollen ein falsches Tempolimit melden und einen richtigen Wert vorschlagen können. Bestätigt sich der Vorschlag, überschreibt er den importierten Wert.
>
> Drei Zusatz-Aufträge, einer pro Arbeitsbereich, rein additiv. **Reihenfolge:** Server (A) zuerst, dann Weboberfläche (B) und Client-Bibliothek (C) — beide bauen auf A auf.

---

## Warum das heikel ist (gilt für alle drei Teile)

Ein falsch gesetztes Tempolimit ist **sicherheitsrelevant**: Wer „130" in eine Tempo-30-Zone schreibt, gefährdet Menschen. Gleichzeitig ist die Korrekturfunktion genau das, was die Datenqualität langfristig trägt. Daraus folgen harte Regeln:

- **Der importierte Wert wird nie gelöscht oder überschrieben.** Eine Korrektur ist ein **zusätzlicher, eigener Datensatz** (Overlay), der den Import überlagert. So bleiben Herkunft und Prüfbarkeit erhalten, und ein erneuter Ingestion-Lauf zerstört nichts.
- **Eine einzelne Meldung ändert nichts.** Erst mehrere unabhängige, übereinstimmende Vorschläge (konfigurierbarer Schwellenwert, Vorschlag: 3 verschiedene Geräte) machen eine Korrektur wirksam. Vorher wird sie höchstens als „gemeldet, unbestätigt" angezeigt.
- **Plausibilitätsgrenzen:** nur Werte aus einem konfigurierbaren, sinnvollen Bereich und in der Einheit der Quelle; keine Korrektur ohne Bezug auf ein konkretes Segment.
- **Zurücknehmbar:** Der Betreiber muss eine wirksame Korrektur mit einem Befehl zurücksetzen können, und die Funktion insgesamt abschaltbar (`COMMUNITY_CORRECTIONS_ENABLED`, Standard: an).
- **Gerätesigniert und begrenzt:** Korrekturen laufen durch dasselbe Moderationsgate wie Meldungen, mit eigenem, strengerem Limit pro Gerät und Zeitraum.
- **Anzeige bleibt ehrlich:** Überall, wo ein korrigierter Wert erscheint, ist erkennbar, dass er aus der Community stammt und nicht aus der Importquelle.

---

## A — Server (Chat „Trafficnetwork Backend", Branch `feature/speed-limit-corrections`)

**Auftrag:** Korrekturvorschläge entgegennehmen, zusammenführen, ab Schwellenwert wirksam machen und über die bestehenden Wege verteilen.

1. **Datenmodell (additiv):** neue Entität, Vorschlag `SpeedLimitCorrection`: Bezug auf `speedLimitSegmentId`, vorgeschlagener Wert + Einheit, optional Grund/Typ (falscher Wert, Limit aufgehoben, Schild fehlt/neu), Reporter-ID (pseudonym), Zeitstempel, Gerätesignatur, Status (`proposed` → `applied` → `reverted`/`superseded`), Provenienz (`source: "community"`). Der wirksame Wert wird beim Lesen aus Import + aktiver Korrektur bestimmt, nicht durch Überschreiben der Importzeile.
2. **Zusammenführung:** Mehrere Vorschläge für dasselbe Segment mit **gleichem Wert** werden zu Bestätigungen zusammengeführt (wie beim Duplikat-Merge von Meldungen); abweichende Werte konkurrieren, es gewinnt der Wert mit den meisten unabhängigen Bestätigungen, frühestens ab Schwellenwert. Widerspruch („Korrektur ist falsch") muss möglich sein und eine wirksame Korrektur wieder kippen können.
3. **Endpunkte (neu, additiv):**
   - `POST /v1/speed-limit-segments/:id/corrections` — Vorschlag einreichen (auth wie andere Schreibzugriffe, gerätesigniert wie Meldungen).
   - `POST /v1/speed-limit-corrections/:id/confirmations` — bestätigen oder widersprechen.
   - `GET /v1/speed-limit-corrections?tiles=…` bzw. Einbindung in die bestehenden Leseendpunkte: Der ausgelieferte Tempolimit-Wert enthält zusätzlich, ob er korrigiert ist (`correctedBy: "community"`, Bestätigungszahl, Zeitpunkt).
4. **Verteilung:** Wirksame Korrekturen sind statische Daten — sie müssen in Ereignisprotokoll, Snapshot **und** in die versionierten statischen Pakete einfließen (Paketversion steigt), damit alle Geräte und Knoten sie bekommen. Im föderierten Netz gilt wie bei Meldungen: gerätesigniert, deterministisch zusammengeführt, nicht fälschbar.
5. **Verhältnis zum Ingestion-Programm:** Ein Bulk-Import darf eine wirksame Korrektur **nicht** stillschweigend überschreiben. Ändert sich der Importwert später, wird die Korrektur als „zu prüfen" markiert (Regel deine Entscheidung, aber im Plan begründen und dokumentieren).
6. **Betreiberwerkzeug:** Befehl, um Korrekturen eines Segments anzuzeigen, einzelne zurückzusetzen und einen Reporter zu sperren.
7. **Doku und Tests:** `server/docs/api.md`, `server/docs/schema.md`, `server/docs/operating.md` (Zurücksetzen), `.env.example`. Tests: Schwellenwert, konkurrierende Werte, Widerspruch kippt Korrektur, Plausibilitätsgrenzen, Rate-Limit, Import überschreibt nicht, Replikation im Mehrknoten-Test, Funktion abgeschaltet.

**Nicht-Ziele:** keine Korrektur von Geometrien oder Straßenverläufen, keine manuelle Prüfoberfläche, keine Änderungen an OSM zurückspielen.

---

## B — Weboberfläche (Chat der Weboberfläche, Branch `feature/server-web-ui`)

**Auftrag:** Falsches Tempolimit melden und Korrekturen sichtbar machen.

1. Klick auf eine Straße/Stelle zeigt das Tempolimit; darunter „Stimmt nicht?" → kleines Formular: richtiger Wert (Auswahl gängiger Werte plus freie Eingabe), Einheit, optional Grund. Absenden ohne Konto, mit derselben Begrenzung wie Meldungen.
2. Zustände klar unterscheiden: **importiert** (Quelle nennen), **gemeldet, noch nicht bestätigt** (mit Anzahl), **von der Community korrigiert** (mit Anzahl und Datum). Bei einer bestehenden Korrektur: Knöpfe „stimmt" / „stimmt nicht".
3. Ehrliche Rückmeldung nach dem Absenden: angenommen, zusammengeführt, oder abgelehnt (mit Grund).
4. Sicherheitshinweis an der Stelle, an der korrigiert wird: Angaben sollen der Beschilderung vor Ort entsprechen; im Zweifel nichts eintragen.
5. Tests: Formular sichtbar und bedienbar, Zustände werden korrekt angezeigt, abgeschaltete Funktion blendet alles aus.

**Voraussetzung:** Teil A ist gemergt.

---

## C — Client-Bibliothek (Chat „Client-Sync-Bibliothek", Branch `feature/speed-limit-corrections`)

**Auftrag:** Korrekturen aus Host-Apps ermöglichen und lokal berücksichtigen.

1. Neue Aufrufe (Namen final im Plan): `reportWrongSpeedLimit(segmentId | position, proposedValue, unit, reason?)` und `confirmSpeedLimitCorrection(correctionId, agrees: bool)`. Beide gehen durch den bestehenden Offline-Schreibpuffer (lokal sofort wirksam, später gesendet, gerätesigniert).
2. `getSpeedLimitAt()` liefert zusätzlich, woher der Wert stammt: importiert, lokal vorgeschlagen (noch nicht bestätigt) oder von der Community korrigiert, jeweils mit Bestätigungszahl. Bestehende Felder bleiben unverändert, rein additiv.
3. Lokaler Speicher und Sync müssen Korrekturen als eigene, überlagernde Datensätze führen — der importierte Wert bleibt erhalten, damit eine zurückgenommene Korrektur wieder auf den Ursprungswert zurückfällt.
4. Tests: Vorschlag offline gepuffert und später gesendet, Herkunft korrekt gemeldet, zurückgenommene Korrektur fällt auf den Importwert zurück, alter Server ohne die Funktion führt nicht zum Fehler.
