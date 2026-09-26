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

@@EXPERIMENTS@@

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

1. **Die Ortsabfrage skaliert.** Mit dem `SqliteStore` ist die Abfrage vom Bestand praktisch unabhängig (Sub-Millisekunde bei 0,55 Mio. Objekten; Skalierung siehe Abschnitt 3).
2. **Arbeitsspeicher hängt an der größten Partition, nicht am Gesamtbestand.** Spitze ≈ 2,4 × Partitionsgröße (Antwortkörper + geparste Objekte). Bayern-Partitionen sind 25–100+ MB; **Europa-Partitionen in dichten Gebieten (H3-Auflösung 2) könnten mehrere hundert MB groß werden — das kann auf Telefonen zu Speichermangel führen**, unabhängig von der Gesamtgröße. Das ist heute die größte konkrete Gefahr.
3. **Datenmenge und Speicher sind linear.** Auf Bayern ≈ 149 MB Datenbank; ein Europa-Bestand in der Größenordnung mehrerer GB ist auf vielen Geräten spürbar, auf manchen (wenig freier Speicher) nicht möglich. `plan_static_bootstrap` erlaubt der App, das **vor** dem Download zu prüfen und dem Nutzer eine klare Rückmeldung zu geben.
4. **Der Server komprimiert nicht.** gzip spart ≈ 78 % Übertragung. Das ist im Kern eine Server-Änderung (E-B). Auf Client-Seite ist nur das `gzip`-Feature von `reqwest` einzuschalten (heute **nicht** aktiv — `client-lib/core/Cargo.toml`; im Browser übernimmt das der Browser selbst); ein Einzeiler, hier nicht ohne Abstimmung geändert, weil er die Abhängigkeiten aller Plattformen berührt.

**Optionen (nur Vorschläge, nichts davon eingebaut):**

- **A. Nur Umgebung + wählbare Offline-Regionen** (der naheliegende Weg, falls Europa vollständig zu groß ist): das Gerät lädt die Region um den Standort und optional gewählte Länder/Regionen. Die Partitionierung (H3) und der Wiederaufnahme-/Plan-Mechanismus tragen das bereits; es wäre vor allem eine Auswahl-Schicht in der App/Bibliothek.
- **B. gzip auf dem Server** (E-B) + `gzip`-Feature im Client: ≈ 5 × weniger Übertragung, wirkt auf allen Geräten, ändert nichts am Konzept.
- **C. Kleinere Partitionen bei dichten Zellen** (E-B, z. B. H3-Auflösung 3 oder größenbasierte Teilung): begrenzt die Speicherspitze des Clients.
- **D. Streaming-Parser im Client:** Partition Objekt für Objekt parsen und in die Datenbank schreiben, statt sie komplett in den Speicher zu laden — senkt die Spitze von ≈ 2,4 × Partition auf einen kleinen Bruchteil. Reine Client-Änderung, hier nicht ohne Freigabe gebaut.
- **E. Kompakteres Übertragungsformat** (Binär/Delta-codierte Geometrie): größere Änderung an Server und Client, hier nur genannt.

Empfehlung: erst E-A/E-B abwarten (wirkliche Objektzahl, wirkliche Partitionsgrößen), dann mit B + C + D nachmessen; erst wenn Europa danach auf typischen Telefonen nicht tragbar ist, A.

## 7. Reproduktion

- Gegen einen echten Server: `cargo run --release --example measure_bootstrap -- --server https://… --client-id … --client-secret …` in `client-lib/core` (oder `TN_CLIENT_ID`/`TN_CLIENT_SECRET`), optional `--db pfad --keep-db` (für Abbruch/Fortsetzen: Prozess beenden und mit derselben `--db` neu starten).
- Synthetisch: `--synthetic-segments 5000000 [--no-gzip-estimate]`.
- Auf einem Rechner ohne Rust: Workflow `client-lib-bench.yml` (nur auf `rework/client-lib-*`, nur wenn `client-lib/bench/trigger.txt` oder der Workflow geändert wird) liefert die synthetischen Läufe und einen Windows-Build als Artefakt `measure_bootstrap-windows`.
