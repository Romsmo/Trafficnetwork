# Prompt für Claude Code — Phase 3: Ingestion-Programm (Grundstock-Befüllung)

> **Scope:** Das Paket `ingestion/` im Monorepo `https://github.com/Romsmo/Trafficnetwork` (privat, Owner: Romsmo). Es füllt eine leere Datenbank über die **öffentliche Bulk-Import-API** des Servers mit Tempolimits, Verkehrszeichen und (vorerst inaktiven) Blitzer-Daten.
>
> **Voraussetzung:** Überarbeitung F (Föderation) ist nach `main` gemergt und CI grün. Prüfe das zuerst; falls nicht, melde dich und warte.
>
> **Maßgeblich (vollständig lesen):** `docs/concept.md` (Abschnitt 4 und 7), `docs/federation.md`, `docs/status.md`, `server/docs/api.md`, `server/docs/federation-protocol.md`, `server/docs/schema.md`.
>
> **Nicht Teil dieses Prompts:** Änderungen an `server/` oder `client-lib/` (nur melden, wenn etwas fehlt), Apps, Betrieb/Launch (eigener Prompt `docs/prompt-launch-local-test.md`).

---

## 0. SETUP & KOORDINATION

1. Klon prüfen/anlegen (`git remote -v`; sonst `git clone https://github.com/Romsmo/Trafficnetwork.git`), `git checkout main && git pull`. Repo ist privat — bei Auth-Fehler die Fehlermeldung zeigen und Optionen nennen (`gh auth login`, SSH-Key, PAT), nie nach Geheimnissen fragen.
2. **`docs/status.md` lesen** — es können weitere Claude-Instanzen parallel arbeiten. Vor jedem Branch-Wechsel `git status` prüfen und niemals wechseln, solange fremde Änderungen im Arbeitsverzeichnis liegen.
3. Branch `phase3/ingestion`. Nach **jedem** Meilenstein: Commit + Push, eigenen Abschnitt in `docs/status.md` auf `main` aktualisieren, kurze Zusammenfassung an mich. Merge nach `main` nur per Pull Request mit meiner Freigabe.
4. Arbeitsweise wie bisher: erst planen (Plan-Modus), bei Unklarheit fragen, nichts erfinden (Lizenzen, Limits, Preise mit Link + Datum belegen), inkrementell grün, Code/Doku Englisch, Rückfragen Deutsch.

---

## 1. VERBINDLICHE LEITPLANKEN

- **Kein privilegierter Zugang.** Das Programm ist ein normaler Client mit `bulk-import`-Scope und spricht ausschließlich HTTP gegen die dokumentierte API. Kein direkter Datenbankzugriff, keine Sonderpfade im Server.
- **Server darf nicht wissen, dass es existiert.** Ein leerer Server bleibt ein gültiger Zustand.
- **Provenienz ist Pflicht** auf jedem Datensatz: `source`, `sourceLicense`, `importedAt`.
- **Regionsparametrisiert.** Welche OSM-Extrakte geladen werden, steht in der Konfiguration. **Start: eine einzelne Region (Bundesland-Extrakt von Geofabrik, Größenordnung 100 MB)** — Deutschland oder Europa müssen ohne Codeänderung möglich sein, nur langsamer.
- **Kill-Switch pro Quelle** mit kostenpflichtigem Kontingent (v. a. HERE, TomTom): harte Obergrenze an Aufrufen, Abbruch davor, klare Logmeldung. Standardmäßig sind diese Quellen **aus**; nur OSM ist standardmäßig an.
- **Blitzer-Daten** werden importiert, aber der Namensraum bleibt serverseitig deaktiviert — kein Umgehen des Flags.
- **Signierte Pakete:** Falls die Föderation für Bulk-Importe einen delegierten Import-Schlüssel verlangt (siehe `server/docs/federation-protocol.md`), nutzt das Programm ihn über eine Konfigurationsdatei; der Schlüssel liegt nie im Repo.
- **Wiederholbar und abbrechbar:** Ein Lauf muss unterbrochen und fortgesetzt werden können (Fortschritt persistent), ohne Duplikate zu erzeugen.

---

## 2. ENTSCHEIDUNGEN, DIE DU TRIFFST (mit Begründung + Beleg)

1. **Sprache/Stack** des Programms (Node/TypeScript liegt nahe, weil Server und CI das schon nutzen — begründe die Wahl trotzdem).
2. **OSM-Verarbeitung:** Werkzeug und Vorgehen (z. B. `osmium`, `pyosmium`, `osm2pgsql`, eigener PBF-Parser), Speicher- und Laufzeitbudget, wie Straßengeometrie + `maxspeed`/`traffic_sign` in `SpeedLimitSegment`/`StaticSign` überführt werden (inkl. implizite Tempolimits wie `maxspeed=DE:urban` — entweder auflösen oder bewusst auslassen und dokumentieren).
3. **Einheiten** (`kmh`/`mph`) und wie sie aus der Quelle übernommen werden, ohne umzurechnen.
4. **Deduplizierung/Idempotenz** über Läufe hinweg (stabile Quell-IDs, Wiederaufnahme nach Abbruch).
5. **Batchgröße und Tempo** gegen die Bulk-Import-API (max. 5000 Zeilen pro Aufruf, Rate-Limits des Servers beachten, Backoff bei 429/503).
6. **Quellenkatalog:** OSM zuerst; danach mit Beleg dokumentieren, was Autobahn-API, Mobilithek/MDM, HERE und TomTom tatsächlich liefern und unter welcher Lizenz. Die Autobahn-API-Lizenz gilt weiterhin als **ungeklärt** — importierte Daten entsprechend kennzeichnen.

---

## 3. ARBEITSPAKETE

1. **Gerüst:** Konfiguration per `.env`/Konfigdatei (Server-URL, Client-Credentials mit `bulk-import`-Scope, Regionsliste, aktive Quellen, Limits), strukturierte Logs, `--dry-run`, Fortschrittsanzeige.
2. **OSM-Worker:** Extrakt herunterladen (mit Prüfsumme), verarbeiten, normalisieren, in Batches importieren, Fortschritt speichern.
3. **Weitere Quellen** als eigene Worker hinter Feature-Schaltern, jeweils mit Kill-Switch und Lizenz-Kennzeichnung.
4. **Verifikation nach dem Lauf:** Programm fragt die öffentliche API ab und meldet, wie viele Segmente/Schilder in der Region tatsächlich ankamen, inkl. Stichprobe (z. B. Tempolimit an bekannten Koordinaten).
5. **Doku:** `ingestion/README.md` (Installation, Konfiguration, ein Lauf von Anfang bis Ende, Wiederaufnahme, Kosten-/Lizenzwarnungen) und `ingestion/docs/sources.md` (Quellenkatalog mit Belegen).

---

## 4. TESTS

- Unit: Normalisierung (Tags → Schema), Einheiten, Dedupe-Schlüssel, Kill-Switch-Logik, Backoff.
- Integration in CI: kompletter Lauf mit einem **kleinen, eingecheckten OSM-Testausschnitt** (wenige MB oder Fixture) gegen einen echten Server aus `server/` (Testcontainers wie bei `server-ci`): leere DB → Import → API liefert die Daten → zweiter Lauf erzeugt keine Duplikate → Abbruch mitten im Lauf und Wiederaufnahme funktioniert.
- Eigener CI-Workflow `.github/workflows/ingestion-ci.yml`.

---

## 5. MEILENSTEINE

| # | Inhalt |
|---|---|
| P3.0 | Stand geprüft, Entscheidungen aus Abschnitt 2, Quellenkatalog-Entwurf mit Belegen, Plan vorgelegt |
| P3.1 | Gerüst: Konfiguration, Auth gegen die API, Batch-Import, Logs, Dry-Run |
| P3.2 | OSM-Worker vollständig (Download, Verarbeitung, Normalisierung, Wiederaufnahme) |
| P3.3 | Weitere Quellen hinter Schaltern inkl. Kill-Switches und Lizenz-Kennzeichnung |
| P3.4 | Verifikation, Doku, CI grün — **Phase-3-Abschluss**, Pull Request |

---

## 6. WAS ICH VOR DEM CODE ERWARTE

1. Kurzbericht: Ist F gemergt, CI grün, API wie dokumentiert?
2. Entscheidungen zu Abschnitt 2 mit Begründung und Beleg.
3. Geschätzte Laufzeit und Datenmenge für eine Region, für Deutschland und für Europa.
4. Liste offener Fragen an mich — insbesondere, welche Region ich zuerst haben will.
