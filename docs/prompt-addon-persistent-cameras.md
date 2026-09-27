# Zusatz-Prompt — Dauerhafte Überwachungsanlagen (Rotlicht, Abstand) im Datenmodell

> **Für den Server-Chat.** Branch `feature/persistent-enforcement-devices`. Rein additiv und **datenerhaltend**: Es darf nichts von dem verloren gehen oder unbrauchbar werden, was bereits importiert ist.
>
> **Hintergrund:** Heute ist nur `fixedSpeedCamera` eine dauerhafte Entität mit eigener Tabelle (`fixed_speed_cameras`, ohne automatischen Verfall). `redLightCamera`, `distanceControl`, `mobileSpeedCamera` und `trailerCamera` liegen in `hazard_reports` und verfallen nach Minuten. Für **fest installierte** Rotlicht- und Abstandsanlagen (OSM: Relationen `type=enforcement` mit `enforcement=traffic_signals` bzw. `mindistance`) ist das falsch — sie würden nach einer Viertelstunde verschwinden.
>
> **Entscheidung des Betreibers:** Die bestehende Tabelle wird **verallgemeinert** (Bauart als Spalte), **keine** neue Tabelle je Bauart. Mobile Anlagen bleiben, was sie sind: verfallende Meldungen.
>
> **Maßgeblich:** `server/docs/schema.md`, `server/docs/api.md`, `server/docs/federation-protocol.md`, `docs/concept.md` (Abschnitt 8), `docs/prompt-addon-source-catalogue.md` (Abschnitt 3.1), `docs/status.md`.

---

## 0. Oberste Regel: bestehende Daten bleiben unversehrt

1. **Keine zerstörende Migration.** Kein `DROP`, kein Umbau per „Tabelle neu anlegen und Daten kopieren", wenn es mit `ALTER TABLE ... ADD COLUMN` geht. Keine Umbenennung der Tabelle; falls du sie trotzdem für richtig hältst, nur mit einer Sicht (`VIEW`) unter dem alten Namen — und erst nach meiner Zustimmung.
2. **Vorher sichern:** Die Migration beschreibt in der Doku, wie ein Betreiber vorher ein Backup zieht und wie er zurückrollt. Eine funktionierende Rückwärts-Migration gehört dazu und wird getestet.
3. **Zählen statt hoffen:** Vor und nach der Migration Zeilen je Tabelle zählen und vergleichen; der Migrationstest läuft gegen eine Datenbank, die vorher mit Daten im heutigen Format befüllt wurde (inkl. Blitzer und Entfernungsmeldungen).
4. **Idempotent und unterbrechbar:** Eine zweimal laufende Migration darf nichts kaputt machen. Bei einem großen Bestand in Blöcken arbeiten, nicht in einer Transaktion über Millionen Zeilen.
5. **Bestehende Clients dürfen nicht brechen.** Alle heutigen Felder und Endpunkte behalten Bedeutung und Format. Neues kommt additiv dazu.

---

## 1. Schema

- `fixed_speed_cameras` bekommt eine Spalte für die Bauart, Vorschlag `camera_type`, mit `NOT NULL DEFAULT 'fixedSpeedCamera'`. Alle vorhandenen Zeilen sind damit automatisch korrekt eingeordnet — kein Nachbearbeiten nötig.
- Erlaubte Werte zunächst: `fixedSpeedCamera`, `redLightCamera`, `distanceControl`. Ob als Datenbank-Enum oder als geprüfter Text, entscheidest du mit Begründung (Erweiterbarkeit gegen Strenge).
- Der Tabellenname bleibt, auch wenn er inhaltlich jetzt zu eng ist. Wenn du einen sprechenderen Namen willst (z. B. `enforcement_devices`), dann nur mit Sicht unter dem alten Namen und in einem **eigenen**, späteren Schritt.
- Das feste Typ-Enum der Meldungen (`hazard_reports.type`, elf Werte) bleibt **unverändert** — gleiche Werte, gleiche Reihenfolge.
- `camera_removal_reports` gilt unverändert für alle Bauarten; der Schwellenwert für „ist weg" bleibt wie bisher.
- **Abschnittskontrolle** (`enforcement=average_speed`) ist in diesem Auftrag **nicht** enthalten. Wenn du beim Planen einen sauberen Weg siehst (eigener Wert, später ans Meldungs-Enum angehängt), leg ihn mir als Vorschlag vor, bau ihn aber noch nicht.

---

## 2. API — additiv

- **Lesen:** `GET /v1/speed-cameras/nearby` und `/by-tile` liefern zusätzlich `cameraType`. Ohne Filter kommen **alle** dauerhaften Anlagen; mit `types=` wird wie bisher gefiltert, jetzt auch nach Bauart. Ein Client, der heute nur feste Blitzer erwartet, darf durch neue Bauarten nicht überrascht werden — prüfe, ob dafür ein Standardfilter oder ein Versionshinweis nötig ist, und begründe deine Wahl.
- **Snapshot:** Das Feld `fixedSpeedCameras` behält seine heutige Bedeutung (nur feste Geschwindigkeitsblitzer), damit bestehende Clients unverändert laufen. Alle dauerhaften Anlagen kommen zusätzlich in einem **neuen** Feld (Vorschlag `enforcementDevices`) mit `cameraType`.
- **Bulk-Import:** `POST /v1/bulk-import/speed-cameras` nimmt optional `cameraType` entgegen, Standard `fixedSpeedCamera`. Aufrufe ohne das Feld verhalten sich exakt wie heute.
- **Schreiben durch Nutzer:** Das heutige Verhalten bleibt. Eine Meldung mit `type: "fixedSpeedCamera"` wird weiterhin in die dauerhafte Tabelle umgeleitet; `redLightCamera` und `distanceControl` bleiben **standardmäßig** verfallende Meldungen — ein Nutzer, der eine mobile Kontrolle meldet, soll keine dauerhafte Anlage anlegen. Wenn du einen Weg für „dauerhaft gemeldet" vorschlägst (z. B. ausdrückliches Feld plus Bestätigungsschwelle), leg ihn vor; gebaut wird er erst nach meiner Freigabe.
- **Blitzer-Namensraum bleibt deaktiviert.** Alles Neue ist genauso gegated wie das Bestehende; das Flag rührst du nicht an.

---

## 3. Verteilung und Föderation

- Dauerhafte Anlagen sind statische Daten: Sie fließen in Snapshot, Ereignisprotokoll und die versionierten statischen Pakete, und die Paketversion steigt zuverlässig.
- Im föderierten Netz gelten dieselben Regeln wie für feste Blitzer: signiert, deterministisch zusammengeführt, für Knoten mit abgeschaltetem Flag nicht auslieferbar.
- Prüfe, ob ein älterer Knoten im Netz mit unbekanntem `cameraType` sauber umgeht (ignorieren statt abstürzen), und beschreibe das Verhalten im Protokolldokument.

---

## 4. Tests

- **Migrationstest mit Altbestand:** Datenbank im heutigen Format befüllen (Blitzer + Entfernungsmeldungen + Ereignisprotokoll), migrieren, prüfen: gleiche Zeilenzahl, alle alten Zeilen tragen `fixedSpeedCamera`, alte API-Antworten unverändert, Rückwärts-Migration funktioniert.
- Import und Auslieferung je Bauart, Filterung nach `cameraType`, Entfernungsmeldungen für eine Rotlichtanlage.
- Kein Verfall: Eine importierte Rotlichtanlage ist nach Ablauf der Verfallsfristen **immer noch da** (Zeit im Test vorspulen).
- Flag aus: keine der Bauarten wird ausgeliefert, Schreibzugriffe funktionieren trotzdem.
- Mehrknoten: Replikation einer Rotlichtanlage, älterer Knoten mit unbekanntem Wert.

---

## 5. Meilensteine

| # | Inhalt |
|---|---|
| D0 | Plan: Schemaentwurf, Migrationsweg inkl. Rückrollen, API-Auswirkungen, Vorschlag zur Abschnittskontrolle, offene Fragen — **vor jedem Code** |
| D1 | Migration + Schema, Migrationstest mit Altbestand grün |
| D2 | API additiv (Lesen, Snapshot, Bulk-Import), Doku in `api.md`/`schema.md` |
| D3 | Föderation und statische Pakete, Mehrknoten-Test |
| D4 | Doku vollständig (auch `operating.md`: Backup vor Migration), CI grün — Pull Request |

Nach jedem Meilenstein: `docs/status.md` auf `main` aktualisieren, Commit + Push, kurze Zusammenfassung.

---

## 6. Was ich vor dem Code erwarte

1. Wie viele Zeilen liegen aktuell in `fixed_speed_cameras` und `hazard_reports` (Größenordnung), und wie lange dauert die Migration darauf?
2. Schemaentwurf und der genaue Migrationsweg, inklusive Rückrollen.
3. Welche bestehenden Antworten sich ändern — deine Begründung, warum kein Client dadurch bricht.
4. Dein Vorschlag zur Abschnittskontrolle (noch nicht bauen).
5. Liste offener Fragen an mich.
