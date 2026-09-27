# Bootstrap des Grundstocks — Messungen (Zusatz E, Teil C)

Stand: 2026-09-25. Werkzeug: `client-lib/core/examples/measure_bootstrap.rs` (Release-Build, echter Client-Stack: `SyncEngine` + `SqliteStore` + `ReqwestHttpTransport`). Reproduktion: siehe letzter Abschnitt.

**Wichtig vorab — was diese Zahlen sind und was nicht.** Der Europa-Datenbestand existiert noch nicht (Zusatz E-A/E-B haben nicht begonnen). Alle Zahlen unten sind deshalb entweder

- **gemessen** — echte Bayern-Daten (438.595 Straßensegmente, 109.646 Schilder) von einem echten Server, mit dem echten Client-Code, auf dem Entwicklungs-PC (Windows, 16 Kerne, SSD); oder
- **gemessen, synthetisch** — dieselbe Client-Kette, aber gegen erzeugte Daten in Bayern-Form (≈ 7,5 Stützpunkte je Segment, mit `segmentKey`) auf einem GitHub-Linux-Runner; oder
- **rechnerisch** — Übertragungszeiten aus Bytes und Bandbreite; oder
- **hochgerechnet** — linear aus den gemessenen Werten skaliert, ausdrücklich keine Messung.

**Nicht messbar** in dieser Umgebung: Rechenleistung, Arbeitsspeicher-Grenzen und Flash-Geschwindigkeit echter Telefone; echtes Verhalten in Mobilfunknetzen (Abbrüche, Drosselung); die tatsächliche Größe/Verteilung der Europa-Partitionen.

## 1. Gemessen: echtes Bayern (Server lokal, Datenbank auf SSD)

| Größe | Wert |
|---|---|
| Bestand | 438.595 Segmente + 109.646 Schilder + 0 Kameras = **548.241 Objekte** |
| Partitionen | 3 (H3-Auflösung 2), größte **102,5 MB** |
| Übertragen | **204,4 MB** in 6 Anfragen (der Server komprimiert heute **nicht**) |
| Übertragen bei gzip (geschätzt, nur gemessen am Inhalt) | 43,8 MB (**21,4 %** des Rohvolumens) |
| Dauer gesamt | **25,3 s** (Manifest 0,01 s, Transport 1,0 s, Verarbeitung 20,1 s = Parsen + Speichern; 36,7 µs je Objekt) |
| Datenbank auf der Platte | **149,0 MB** (272 B je Objekt, nach Checkpoint kein WAL-Rest) |
| Arbeitsspeicher-Spitze des Prozesses | **258 MB** Working Set (248 MB über dem Leerlauf von 9 MB); folgt der **größten Partition** (102,5 MB) |
| Öffnen der Datenbank nach Neustart | 6,1 ms |
| Zeit bis zur ersten Abfrage | 0,28 ms |
| Ortsabfragen nach Neustart (2000 zufällige Positionen, alle gefunden) | p50 0,058 ms · p95 0,117 ms · p99 0,158 ms · max 0,218 ms |

Bewertung Kartenabgleich/Start: Die Abfragen laufen über den R*Tree und laden nur Segmente in der Nähe; die Latenz ist weit unter dem, was ein Positionsupdate (≈ 1 Hz) braucht, und wächst mit dem Bestand nur logarithmisch. Der Start kostet Millisekunden, nicht das Laden des Bestands in den Speicher.

## 2. Gemessen: Abbruch und Fortsetzen

Prozess nach 6 s hart beendet (mitten in der zweiten Partition), danach auf derselben Datenbankdatei neu gestartet:

| | Lauf 1 (abgebrochen) | Lauf 2 (fortgesetzt) |
|---|---|---|
| Manifest sagt | 3 Partitionen, 204,4 MB | **2 Partitionen, 178,9 MB** |
| Ergebnis | beendet nach 26 MB, Datenbank hatte die erste, vollständige Partition (17,6 MB Datei) | Vollbestand komplett, Datenbank **149,0 MB**, erste Abfrage 0,28 ms, Exitcode 0 |

Die bereits geschriebene Partition wird nicht erneut geladen; es gibt keine halbe Partition (Partition + Hash in einer Transaktion). Zusätzlich in den Unit-Tests: Fortsetzen über ein Wiedereröffnen der Datei, „Speicher voll“ mitten im Lauf mit anschließender Fortsetzung, und der Fehler `SyncError::StorageFull` statt eines Absturzes.

## 3. Gemessen, synthetisch: Skalierung (GitHub-Linux-Runner)

Dieselbe Kette (`SyncEngine` → `SqliteStore`), Partitionen zu je ≈ 100 MB, Daten in Bayern-Form (etwas größer je Objekt als die echten: ≈ 410 B statt 373 B Übertragung). Runner: Linux x86_64, **2 Kerne, 7,9 GB RAM** (einfacher als ein aktuelles Telefon bei den Kernen, aber mit schneller Server-SSD). „Verarbeitung“ = Parsen + Speichern; die Zeit, die das Werkzeug zum Erzeugen der synthetischen Antworten braucht, ist ausgeklammert (es gibt kein Netz).

| Segmente (+ ¼ Schilder) | Objekte | Übertragung roh | Datenbank | Verarbeitung | je Objekt | Speicherspitze | erste Abfrage | Abfragen p50 / p95 / max |
|---|---|---|---|---|---|---|---|---|
| 1 Mio. | 1,25 Mio. | 513 MB | 370 MB (296 B/Objekt) | 42,5 s | 34 µs | 266 MB | 0,16 ms | 0,020 / 0,028 / 0,056 ms |
| 5 Mio. | 6,25 Mio. | 2,6 GB | 1,86 GB (298 B) | 320 s (5,3 min) | 51 µs | 273 MB | 0,17 ms | 0,025 / 0,037 / 0,071 ms |
| 10 Mio. | 12,5 Mio. | 5,1 GB | 3,74 GB (299 B) | 879 s (14,7 min) | 70 µs | 274 MB | 0,20 ms | 0,029 / 0,043 / 0,085 ms |
| 20 Mio. | 25 Mio. | 10,3 GB | 7,50 GB (300 B) | 2464 s (41 min) | 99 µs | 274 MB | 0,37 ms | 0,041 / **0,81** / 3,1 ms |

Was daran belegt ist:

- **Datenbankgröße ist linear** (≈ 300 B je Objekt), ebenso die Übertragung.
- **Die Speicherspitze hängt an der Partitionsgröße, nicht am Bestand**: 266 → 274 MB von 1 bis 20 Mio. Segmenten (Partition immer ≈ 100 MB; ≈ 2,6 × Partitionsgröße).
- **Die Verarbeitung ist nicht linear**: die Kosten je Objekt wachsen von 34 auf 99 µs, sobald die Datenbank größer wird (die Indizes — R*Tree, eindeutige ID — werden zufällig beschrieben und passen nicht mehr in den Cache). Die lineare Hochrechnung, die das Werkzeug selbst ausgibt, würde für 20 Mio. 11 min sagen; **gemessen sind 41 min**. Hochrechnungen der Dauer aus kleinen Läufen sind deshalb zu optimistisch.
- **Die Ortsabfrage bleibt schnell**, wird aber bei 20 Mio. Segmenten (7,5 GB Datenbank auf einem 7,9-GB-Rechner, Seitencache reicht nicht mehr) im 95. Perzentil langsamer (0,8 ms) — immer noch weit unter dem Takt eines Positionsupdates.

## 3a. Gemessen, synthetisch: Seitencache und Partitionsform (GitHub-Linux-Runner)

Zwei Nachfragen zum Befund oben — beide auf demselben 2-Kern/7,9-GB-Runner wie Abschnitt 3, also untereinander vergleichbar, aber (weniger RAM/Kerne, schnelle SSD) nicht direkt mit Bayern (Abschnitt 1) vergleichbar.

**Seitencache (5 Mio. Segmente, Partitionen ≈ 100 MB wie in Abschnitt 3):**

| SQLite-Seitencache | Verarbeitung gesamt | je Objekt | Speicherspitze |
|---|---|---|---|
| 2 MB (SQLite-Standard) | 349,0 s | 54,2 µs | 271 MB |
| 16 MB (**neuer Standard von `SqliteStore`**) | 257,2 s | 39,5 µs | 287 MB |
| 64 MB | 260,2 s | 40,2 µs | 356 MB |
| 256 MB | 232,1 s | 35,8 µs | 785 MB |

16 MB statt der SQLite-eigenen 2 MB sind **≈ 26 % schneller** bei kaum mehr Speicher (287 statt 271 MB) — deshalb jetzt der Standard in `SqliteStore::init`. Mehr bringt weiter etwas (256 MB nochmal 10 % schneller), kostet aber linear Speicher (785 MB) und ist als fester Standard für ein Telefon nicht vertretbar; `SqliteStore::set_cache_size_kib` steht offen für eine Host-App, die mehr geben will (z. B. nur während eines einmaligen Bootstraps, nicht dauerhaft).

**Partitionsform** (10,9 Mio. Segmente + 2,7 Mio. Schilder = 13,6 Mio. Objekte, in 5.450 Partitionen zu je ≈ 2.000 Segmenten/1,0 MB — das ist die tatsächliche Form, die der Server heute mit seinem Standard **Auflösung 4** ausliefern würde, siehe `server/docs/api.md` „Static data packages“ — statt der 100-MB-Großpartitionen aus Abschnitt 3):

| Seitencache | Verarbeitung gesamt | je Objekt | Speicherspitze |
|---|---|---|---|
| 2 MB | 2383,4 s (39,7 min) | 173,4 µs | **13 MB** |
| 64 MB | 2225,9 s (37,1 min) | 161,8 µs | **81 MB** |

Das bestätigt gemessen, was Abschnitt 6 als Vermutung nennt: **die Speicherspitze folgt der Partitionsgröße, nicht dem Bestand.** Bei den Server-üblichen ≈ 1-MB-Partitionen bleibt der Prozess bei **13,6 Mio. Objekten unter 100 MB Speicherspitze** — eine Größenordnung unter den 778 MB, die dieselbe Objektzahl mit 100-MB-Partitionen gebraucht hätte (Abschnitt 3a oben, 5-Mio.-Lauf hochgerechnet). Der Preis dafür: **die Verarbeitung je Objekt steigt auf 162–173 µs** (gegenüber 35–99 µs bei Großpartitionen) — 5.450 einzelne Transaktionen statt 25–100 kosten spürbar mehr Overhead als der reine Datendurchsatz. In der Summe: **13,6 Mio. Objekte in ≈ 37 Minuten Verarbeitung**, bei unter 100 MB Speicherspitze — für ein Telefon ist Ersteres (Wartezeit) das größere Problem als Letzteres (Speicher).

## 4. Rechnerisch: Übertragungszeit für die Bayern-Menge (204,4 MB roh / 43,8 MB gzip)

| Verbindung | roh (heutiger Server) | mit gzip |
|---|---|---|
| 1 Mbit/s | 27,3 min | 5,8 min |
| 5 Mbit/s | 5,5 min | 1,2 min |
| 20 Mbit/s | 1,4 min | 0,3 min |
| 100 Mbit/s | 0,3 min | 0,1 min |

Die Verarbeitungszeit (Parsen + Speichern, 20 s auf dem PC) kommt dazu; auf einem Telefon ist sie **nicht gemessen** (siehe unten).

## 5. Hochgerechnet (nicht gemessen): Europa

Linear aus Abschnitt 1 (pro Objekt: 373 B Übertragung roh, 80 B gzip, 272 B Datenbank, 36,7 µs Verarbeitung auf dem PC). Die tatsächliche Objektzahl für Europa ist **unbekannt** (E-A liefert sie); Bayern ist ≈ 0,55 Mio. Objekte, ganz Europa liegt plausibel im zweistelligen Millionenbereich. Die Tabelle rechnet nur die Skalierung durch:

| Objekte | Übertragung roh | gzip | Datenbank | Verarbeitung (PC) |
|---|---|---|---|---|
| 5 Mio. | 1,9 GB | 0,4 GB | 1,4 GB | 3,1 min |
| 10 Mio. | 3,7 GB | 0,8 GB | 2,7 GB | 6,1 min |
| 20 Mio. | 7,5 GB | 1,6 GB | 5,4 GB | 12,2 min |
| 40 Mio. | 14,9 GB | 3,2 GB | 10,9 GB | 24,5 min |

## 6. Was das für „alles auf jedem Gerät“ bedeutet — Befunde und Optionen

Die Entscheidung „alles auf jedem Gerät“ gilt unverändert; nichts wurde umgestellt. Die Zahlen sind eine Entscheidungsgrundlage.

**Befunde (belegt):**

1. **Die Ortsabfrage skaliert.** Mit dem `SqliteStore` ist die Abfrage vom Bestand praktisch unabhängig (Sub-Millisekunde bei 0,55 Mio. Objekten, ebenso bei 13,6 Mio. — Abschnitt 3a; Skalierung sonst siehe Abschnitt 3).
2. **Arbeitsspeicher hängt an der Partitionsgröße, nicht am Gesamtbestand — jetzt gemessen, nicht nur vermutet (Abschnitt 3a).** Bei den ≈ 100-MB-Großpartitionen aus Abschnitt 3 wächst die Speicherspitze mit der Partition (266 → 785 MB, je nach Seitencache). Der Server hat sich am 2026-09-25 für **Auflösung 4** entschieden (≈ 1.770 km² je Kachel, Pakete im einstelligen MB-Bereich statt der früheren, teils >100 MB großen Auflösung-2-Kacheln) — bei genau dieser Form blieb die Speicherspitze für **13,6 Mio. Objekte unter 100 MB**. Die Gefahr aus einer früheren Fassung dieses Berichts (Auflösung 2, hunderte MB je Kachel) ist damit durch die Server-Entscheidung bereits entschärft; sie bliebe nur bestehen, wenn ein Betreiber die Auflösung wieder gröber stellt.
3. **Datenmenge und Speicher sind linear.** Auf Bayern ≈ 149 MB Datenbank; ein Europa-Bestand in der Größenordnung mehrerer GB ist auf vielen Geräten spürbar, auf manchen (wenig freier Speicher) nicht möglich. `plan_static_bootstrap` erlaubt der App, das **vor** dem Download zu prüfen und dem Nutzer eine klare Rückmeldung zu geben.
4. **Kleine Partitionen sparen Speicher, kosten aber Verarbeitungszeit.** Bei 13,6 Mio. Objekten in ≈ 1-MB-Partitionen (5.450 Stück) dauerte das reine Parsen/Speichern ≈ 37 Minuten (162–173 µs/Objekt) gegenüber deutlich weniger je Objekt bei 100-MB-Partitionen (Abschnitt 3a) — 5.450 einzelne Transaktionen kosten spürbar Overhead. Für ein Telefon ist die Wartezeit beim einmaligen Grundstock-Aufbau damit eher das Problem als der Speicher.
5. **Der Server komprimiert nicht.** gzip spart ≈ 78 % Übertragung. Das ist im Kern eine Server-Änderung (E-B). Auf Client-Seite ist nur das `gzip`-Feature von `reqwest` einzuschalten (heute **nicht** aktiv — `client-lib/core/Cargo.toml`; im Browser übernimmt das der Browser selbst); ein Einzeiler, hier nicht ohne Abstimmung geändert, weil er die Abhängigkeiten aller Plattformen berührt.

**Optionen (nur Vorschläge, nichts davon eingebaut):**

- **A. Nur Umgebung + wählbare Offline-Regionen** (der naheliegende Weg, falls Europa vollständig zu groß ist): das Gerät lädt die Region um den Standort und optional gewählte Länder/Regionen. Die Partitionierung (H3) und der Wiederaufnahme-/Plan-Mechanismus tragen das bereits; es wäre vor allem eine Auswahl-Schicht in der App/Bibliothek.
- **B. gzip auf dem Server** (E-B) + `gzip`-Feature im Client: ≈ 5 × weniger Übertragung, wirkt auf allen Geräten, ändert nichts am Konzept.
- **C. Partitionsgröße** — **schon entschieden und gemessen** (Auflösung 4, Befund 2/4 oben): begrenzt die Speicherspitze wirksam, kostet aber Verarbeitungszeit; eine noch feinere Auflösung würde das Verhältnis voraussichtlich weiter in diese Richtung verschieben, ungemessen.
- **D. Streaming-Parser im Client:** Partition Objekt für Objekt parsen und in die Datenbank schreiben, statt sie komplett in den Speicher zu laden — würde die Speicherspitze bei großen Partitionen senken, ändert aber nichts an der Verarbeitungszeit kleiner Partitionen (Befund 4). Reine Client-Änderung, hier nicht ohne Freigabe gebaut.
- **E. Kompakteres Übertragungsformat** (Binär/Delta-codierte Geometrie): größere Änderung an Server und Client, hier nur genannt.

Empfehlung: mit der jetzt vom Server gewählten Auflösung 4 ist die Speicherfrage weitgehend entschärft (Befund 2); die Verarbeitungsdauer beim einmaligen Bootstrap (Befund 4, ≈ 37 min für 13,6 Mio. Objekte auf einem Zwei-Kern-Server-Runner — ein Telefon dürfte je nach CPU eher langsamer sein) ist jetzt der offene Punkt. Erst E-A/E-B-Zahlen auf dem echten Europa-Bestand abwarten (echte Objektzahl, echte Kachelgrößen), dann B nachrüsten (Übertragung) und D erwägen (Verarbeitung bei großen Einzelpartitionen, z. B. an Ländergrenzen); erst wenn Europa danach auf typischen Telefonen nicht tragbar ist, A.

## 7. Reproduktion

- Gegen einen echten Server: `cargo run --release --example measure_bootstrap -- --server https://… --client-id … --client-secret …` in `client-lib/core` (oder `TN_CLIENT_ID`/`TN_CLIENT_SECRET`), optional `--db pfad --keep-db` (für Abbruch/Fortsetzen: Prozess beenden und mit derselben `--db` neu starten).
- Synthetisch: `--synthetic-segments 5000000 [--no-gzip-estimate]`.
- Auf einem Rechner ohne Rust: Workflow `client-lib-bench.yml` (nur auf `rework/client-lib-*`, nur wenn `client-lib/bench/trigger.txt` oder der Workflow geändert wird) liefert die synthetischen Läufe und einen Windows-Build als Artefakt `measure_bootstrap-windows`.
