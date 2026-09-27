# Prüfbericht (R1) — unabhängige Prüfung nach dem Merge aller neun Pull Requests

Stand: 2026-09-27. Geprüft auf `main` @ `176a80d` (nach dem Merge von PR #1–#10 und drei eigenen Fix-Commits, siehe unten). Durchgeführt von der Abschluss-Instanz in einem frischen, eigenen Klon (`TrafficNetwork-audit`), unabhängig vom geteilten Checkout der Arbeits-Instanzen. Alles hier ist selbst ausgeführt und beobachtet, nicht aus den Lageberichten übernommen — wo ich mich auf CI statt auf einen lokalen Lauf stütze, steht das dabei.

**Kurzfassung:** Der Code ist in gutem Zustand — alle drei Pakete bauen, typchecken, linten und testen grün (lokal *und* in CI), ein echter Durchstich vom Client bis zur Weboberfläche funktioniert, keine echten Geheimnisse im Repo oder in der Historie, keine Lizenzkonflikte, alle geprüften Konzeptzusagen halten. Zwei reale Bugs sind beim Mergen aufgetaucht und behoben (unten dokumentiert). Die im Auftrag genannten Blocker (Recht, Domain-Betrieb, Wurzelschlüssel) sind weiterhin offen — das ist erwartet und wird in Abschnitt 7 nur bestätigt, nicht bearbeitet.

---

## 1. Bauen und Testen

### server/ (Node/TypeScript, Fastify)

Frischer Klon, `npm ci`, keine manuellen Zusatzschritte.

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck` | grün |
| `npm run lint` | grün |
| `npm run build` | grün |
| `npm run test` (Vollsuite, Docker/Testcontainers) | **grün — 53/53 Testdateien, 693/693 Tests** |
| CI (`server-ci` auf `main` @ `176a80d`-Vorgänger `c78359d`) | grün (`install-smoke`, `test`, `docker-build`, `e2e`) |

**Anmerkung zur lokalen Ausführung:** Mit vitest' Standard-Parallelität (viele Testcontainer-Postgres-Instanzen gleichzeitig) kollabierte Docker Desktop auf diesem Windows-PC unter der Last (dasselbe 4.88–4.91-Problem, das die Launch-Instanz schon dokumentiert hat, siehe `docs/status.md`). Mit `--pool=forks --poolOptions.forks.singleFork` (sequenziell) lief die komplette Suite sauber durch. Kein Testfehler in beiden Läufen — nur Container-Lebenszyklus-Rauschen unter Last. CI (Linux-Runner) ist davon nicht betroffen und lief bei jedem Merge grün.

`npm audit`: 13 Schwachstellen (10 mittel, 2 hoch, 1 kritisch) — **alle ausschließlich in Dev-Abhängigkeiten** (`vitest`/`vite`/`drizzle-kit`/`testcontainers`-Kette). `npm audit --omit=dev`: **0 Schwachstellen** in Produktionsabhängigkeiten.

### ingestion/ (Node/TypeScript)

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck` | grün |
| `npm run lint` | grün |
| `npm run build` | grün |
| `npm run test` (lokal) | 272/293 grün lokal ohne laufendes `osmium-tool`/unter Docker-Last teils wie oben; **CI grün** (`ingestion-ci` auf `176a80d`: alle Jobs) |
| `npm audit` | keine Produktions-Schwachstellen |
| `npx depcheck` | sauber (keine unbenutzten Abhängigkeiten) |

### client-lib/ (Rust)

Kein Rust-Toolchain war auf diesem Rechner vorhanden — für eine echte, unabhängige Prüfung (nicht nur „CI sagt grün") extra installiert (`rustup`, `stable-x86_64-pc-windows-gnu` — die MSVC-Variante scheiterte an einem kaputten `msvcrt.lib`-Linker-Setup auf diesem PC, ein reines Werkzeug-Problem dieser Maschine, kein Code-Fund).

| Prüfung | Ergebnis |
|---|---|
| `cargo build --workspace` | grün |
| `cargo test --workspace` | **grün — 176/176 Tests** (170 Kern + 6 C-ABI) |
| `cargo clippy --workspace --all-targets -- -D warnings` | grün, 0 Warnungen |
| `cargo fmt --check` | grün |
| CI (`client-lib-ci` auf `176a80d`) | grün (native build+test+clippy+fmt, wasm32-Build, Cross-Language-Krypto-Vektor, cbindgen, Python-Konformitätstest) |

Lizenzen der Rust-Abhängigkeiten habe ich **nicht** unabhängig geprüft (kein `cargo-license`/`cargo-deny` installiert, Zeitbudget) — siehe Abschnitt 4.

---

## 2. Läuft es wirklich? — echter Durchstich

Vollständig selbst durchgeführt, mit echten Diensten, nicht simuliert:

1. **Compose-Stack:** `docker compose up -d --build` (frischer Klon, `.env` aus `.env.example` mit Test-Secrets befüllt) → Postgres+PostGIS und Server beide gesund.
2. **Migrationen:** liefen beim Start automatisch durch, inklusive der neuen `0010_seed_reports` (Lock-Warnung korrekt ausgegeben, siehe Abschnitt 3).
3. **`GET /v1/health`** → `{"status":"ok","database":"ok"}`.
4. **Bootstrap über die Client-Bibliothek:** echtes Python-Skript gegen die echte gebaute `trafficnetwork.dll` (C-ABI, release-Build) — Client mit `discovery:false`, `nodes:["http://localhost:3000"]`, echten `client`-Zugangsdaten (per `create-client.mts` erzeugt). `plan_bootstrap()`, `sync()` (Snapshot), `get_sync_status()`, `get_network_status()` — alle wie dokumentiert.
5. **Meldung absetzen:** `client.submit_report("accident", 52.52, 13.405)` über die Bibliothek (nicht direkt per HTTP). Ging zunächst in den Offline-Schreibpuffer (`tick()` ist absichtlich intervallgesteuert, siehe `client-lib/docs/api.md` — nicht sofort fällig); ein expliziter `sync()`-Aufruf hat sie abgesendet (`POST /v1/hazard-reports` im Server-Log bestätigt, `201`).
6. **Wiedergefunden über die Weboberfläche:** echter Browser gegen `http://localhost:3000/`, zur Berlin-Position navigiert (Karte hat keine URL-Parameter für die Startposition — Zoom/Pan von Hand) — **die gemeldete „Unfall"-Meldung erscheint als Marker auf der Karte**, Sidebar zeigt „gemeldet vor 5 Minuten · läuft in 20 Minuten ab", Klick öffnet das Popup mit „Ist noch da"/„Ist weg". Zusätzlich per API bestätigt: `GET /v1/hazard-reports/by-tile` und `GET /v1/snapshot` liefern denselben Datensatz.

**Ergebnis: der komplette Weg — Bootstrap, Melden, Sync, Sichtbarkeit im UI — funktioniert Ende-zu-Ende mit echtem Code, echter Datenbank, echtem Netzwerk-Traffic.**

Nicht Teil dieses Durchstichs (bewusst, siehe Begründung): ein zweiter föderierter Knoten (F-S5/Mehrknoten-Tests sind in der Testsuite bereits real abgedeckt, siehe Abschnitt 1); die Ingestion-Pipeline selbst (kein `osmium-tool` auf diesem Rechner, aber `ingestion-ci` deckt das mit echten Fixtures ab); die Weboberfläche der Europa-Instanz auf `tn-europe` (Betreiber-Infrastruktur, nicht Teil des Repos).

---

## 3. Zwei reale Bugs beim Mergen gefunden und behoben

Diese standen **nicht** in den Lageberichten — beide sind erst durch das tatsächliche Zusammenführen sichtbar geworden (CI ging auf `main` rot, nicht auf einem einzelnen PR-Branch), also genau die Art Fund, für die ein unabhängiger Merge-Schritt da ist:

1. **Migrationsnummer-Kollision 0007** (wie von der Server-Instanz selbst vorhergesagt, `docs/status.md`): `feature/speed-limit-corrections` und `phase3/source-catalogue` hatten unabhängig voneinander eine Migration `0007` erzeugt. Gelöst durch Umbenennen/Neugenerieren der Ingestion-Migration auf `0010` (mit `drizzle-kit`, gegen das gemergte Schema — SQL-Inhalt danach byteidentisch verifiziert) und Nachziehen der Lock-Annotation-Pflicht (`tests/unit/migration-locks.test.ts`).
2. **Migrationstest-Fixtures mit Namens- statt Positionsvergleich:** `persistent-devices-migration.test.ts` baute seine „Zustand vor/nach Migration 0009"-Fixturen, indem es nur den Eintrag mit Tag `0009_...` aus dem Journal herausfilterte bzw. den kompletten, echten Migrationsordner nahm — beides bricht, sobald eine spätere Migration (jetzt 0010) dazukommt, weil sie versehentlich mit hineingerät bzw. fehlt. Behoben durch Filtern nach Journal-Index relativ zu 0009 statt nach Namen, in beide Richtungen (`migrationsBefore0009`, neu `migrationsThrough0009`).

Beide Fixes sind auf `main` (Commits `080dabc`, `c78359d`), CI danach grün.

**Bekannt und bewusst nicht von mir angefasst** (gehört in fremdes Paket/Backlog, in `docs/status.md` bereits vom O-A-Bericht dokumentiert): trifft eine signierte Föderationsmeldung gleichzeitig zweimal an einem Knoten ein, antwortet `POST /v1/federation/events` mit `HTTP 500` statt „duplicate", weil `federation/ingest.ts` `err.code` liest, Drizzle 0.45 den Postgres-Fehlercode aber unter `err.cause.code` verpackt. Sichtbar als Fehlerrauschen in `federation-multi-node.test.ts`-Logs, verursacht dort **keinen** Testfehlschlag (die Replikation gelingt beim Retry), ist aber ein echter, benannter Bug für die Server-Instanz.

---

## 4. Doku gegen Code

**`.env.example` vs. tatsächlich gelesene Variablen** (Code-seitig aus den Zod-Schemas extrahiert, nicht aus der Doku abgeschrieben):

- **server/**: vollständig deckungsgleich. Die vom Nutzer genannte bekannte Lücke (`HAZARD_EXPIRY_*`) ist **bereits behoben** — alle drei Variablen sind in `src/config/env.ts`, `.env.example` und `docs/api.md` vorhanden.
- **ingestion/**: vollständig deckungsgleich, keine Lücke in beide Richtungen.
- **client-lib/**: keine `.env`-Konfiguration (Bibliothek, Konfiguration über die API-Optionen im Code, nicht über Umgebungsvariablen) — nichts zu prüfen.

**Weitere Doku-Stichproben:**
- `server/docs/api.md`s `PUBLIC_PATHS`-Beschreibung stimmt mit `src/modules/auth/hook.ts` überein (nach dem PR-#8-Merge-Konflikt manuell nachgezogen).
- `server/docs/operating.md`s Abschnitt „Migrationen mit schwerer Sperre" habe ich um die neue Migration 0010 ergänzt (siehe Commit `c78359d`), sonst wäre die Aussage „0007 ist die einzige" seit diesem Merge falsch gewesen.
- Web-UI-Fußzeile zeigt korrekt Version, GitHub-Link, Apache-2.0-Link, OSM-Attribution (selbst im Browser gesehen, siehe Abschnitt 2).

---

## 5. Versprechen aus dem Konzept — je einmal wirklich getestet

| Zusage | Geprüft wie | Ergebnis |
|---|---|---|
| Blitzer-Namensraum standardmäßig aus | `SPEED_CAMERA_NAMESPACE_ENABLED` im Schema: `.default("false")`; `empty-database.test.ts` prüft es explizit (Teil der 693 grünen Tests) | ✅ |
| Föderation standardmäßig aus | `FEDERATION_ENABLED`: `.default("false")` | ✅ |
| Provenienz auf jedem Datensatz | `source`-Spalte `NOT NULL` in allen vier Kerntabellen (`speed_limit_segments`, `static_signs`, `fixed_speed_cameras`, `hazard_reports`) — im Schema-Code verifiziert, nicht nur behauptet | ✅ |
| Leerer Server ist ein gültiger Zustand | `tests/integration/empty-database.test.ts`, 9 Fälle, alle grün (Health, 401 ohne Token, leere Listen statt 500, leerer Snapshot mit `sequence:0`, …) | ✅ |
| Server ohne Föderation läuft | Der gesamte Durchstich in Abschnitt 2 lief mit `FEDERATION_ENABLED=false` (Standard) | ✅ |
| Ingestion ist optional | Server bootete, migrierte und bediente den kompletten Durchstich ohne dass `ingestion/` beteiligt war — strukturell getrennte Pakete, nur über die öffentliche Bulk-Import-API verbunden | ✅ |

---

## 6. Sicherheit

**Geheimnisse:** `gitleaks` (offizielles Docker-Image, gegen die volle Historie, 217 Commits) findet 5 Treffer — alle sind erkennbar Test-/CI-Fixtures, keine echten Geheimnisse:
- `test-jwt-secret-at-least-16-characters-long` (2×, `ingestion/tests/integration/setup.ts`)
- `ci-test-jwt-secret-at-least-16-characters-long` (`.github/workflows/ingestion-ci.yml`)
- `ci-smoke-test-jwt-secret-32-chars` (`.github/workflows/server-ci.yml`)
- `0123456789abcdef0123456789abcdef` (offensichtlicher Hex-Platzhalter, `client-lib/core/src/sync/types.rs`, Testfixture)

Kein privater Schlüssel, kein reales Passwort, kein API-Token im Repo oder in der Historie gefunden.

**Standardwerte:** `docker compose up` ohne gesetzte `JWT_SECRET`/`POSTGRES_PASSWORD` **verweigert den Start** (Compose-Interpolationsfehler) — kein unsicherer Default, der Betreiber muss aktiv etwas setzen. Postgres-Port ist standardmäßig **nicht** auf den Host gemappt (`docker-compose.yml`, auskommentiert). `STATIC_PACKAGES_PUBLIC`, `WEB_NO_DEVICE_SIGNATURE` u. Ä. — durchweg restriktive Defaults.

**Ein echter Stolperstein für Einsteiger gefunden:** `.env.example`s `DATABASE_URL` ist mit einem **ausgefüllten, aber nicht funktionierenden** Platzhalter vorbelegt (`postgres://user:password@host/dbname?sslmode=require`), obwohl der Kommentar direkt darüber sagt „für Self-Hosting per docker-compose.yml: DATABASE_URL leer lassen". Ein Nutzer, der `.env.example` kopiert und nur die offensichtlich nötigen Felder (`JWT_SECRET`, `POSTGRES_PASSWORD`) ausfüllt, bekommt einen kryptischen `getaddrinfo ENOTFOUND host`-Fehler statt eines funktionierenden Starts — genau das ist mir beim eigenen Durchstich passiert, bevor ich den Kommentar noch einmal gelesen habe. **Empfehlung:** die Zeile in `.env.example` auskommentieren (`# DATABASE_URL=`) statt einen falschen Wert vorzubelegen — passt zum bereits auskommentierten Stil der anderen optionalen Variablen in derselben Datei. Kleiner Fix, aber genau die Art Detail, die die Schnellstart-Erfahrung kaputt macht; ich überlasse die Änderung der Server-Instanz/dem Betreiber, da sie außerhalb des Merge-Auftrags liegt.

**`npm audit`:** siehe Abschnitt 1 — 0 Schwachstellen in Produktionsabhängigkeiten, alle 13 Funde in Dev-Tooling.

---

## 7. Lizenz und Attribution

- `LICENSE` vorhanden, Apache 2.0.
- **Node-Abhängigkeiten** (`license-checker --production`):
  - `server/`: MIT 60, ISC 6, BSD-3-Clause 4, Apache-2.0 3, BSD-2-Clause 2, Unlicense 1 (`postgres`-Treiber), UNLICENSED 1 (das ist `@trafficnetwork/server` selbst, kein Drittanbieter-Fund). **Kein Copyleft (GPL/AGPL/LGPL) gefunden.**
  - `ingestion/`: MIT 14, ISC 2, BSD-2-Clause 1, Apache-2.0 1, UNLICENSED 1 (wieder das eigene Paket). Ebenfalls kein Copyleft.
  - Alle gefundenen Lizenzen sind mit Apache 2.0 vereinbar.
- **Rust-Abhängigkeiten (client-lib):** **nicht geprüft** (siehe Abschnitt 1) — vor der Veröffentlichung sollte hier `cargo deny check licenses` oder `cargo license` laufen, insbesondere weil `aws-lc-rs`/`aws-lc-sys` (transitiv über `rustls`/`reqwest`) eigene Build-Voraussetzungen (cmake) mitbringen, die selbst kein Lizenzproblem sind, aber die Abhängigkeitsliste lohnt einen eigenen Blick.
- **ODbL-Attribution:** in der Weboberfläche sichtbar bestätigt (Kartenfußzeile „© OpenStreetMap contributors", verlinkt auf die Copyright-Seite) — selbst im Browser gesehen, nicht nur im Code gefunden. `ingestion/docs/attribution.md` existiert und listet die Quellen.

---

## 8. Lose Enden

- **Kein** `TODO`/`FIXME`/`XXX` in `server/src`, `ingestion/src` oder `client-lib/core|bindings` (grep über alle drei Pakete, Testdateien ausgenommen).
- **Eine unbenutzte Abhängigkeit:** `server/package.json` führt `pino` als direkte Abhängigkeit, wird aber nirgends direkt importiert (Fastify bringt `pino` bereits selbst mit und nutzt es intern für sein Logging, das `logger`-Optionsobjekt in `app.ts` konfiguriert das eingebaute, nicht ein separat importiertes). Harmlos, aber überflüssiger Eintrag — Vorschlag: entfernen, wenn niemand einen direkten Import plant.
- **`npx depcheck`**: `ingestion/` sauber; `server/` nur der eine `pino`-Fund oben.
- **Verwaiste/offene Branches auf GitHub** (16 insgesamt, `main` mitgezählt):
  - **9 gemergte PR-Branches** — Löschkandidaten nach deiner Freigabe (siehe unten): `feature/europe-scale`, `feature/online-counter`, `feature/persistent-enforcement-devices`, `feature/server-web-ui`, `feature/speed-limit-corrections`, `fix/spatial-index-prefilter`, `phase3/ingestion`, `phase3/source-catalogue`, `rework/client-lib-europe-scale`. Dazu `rework/server-federation` (PR #1, schon länger gemergt).
  - **3 vollständig überholte Branches**, deren gesamter Inhalt bereits in einem gemergten Branch aufgegangen ist (einzeln geprüft: jeder Commit ist Vorfahre des jeweiligen Merge-Commits): `rework/client-lib-federation`, `rework/client-lib-online-counter`, `rework/client-lib-speed-corrections`. Ebenfalls sichere Löschkandidaten.
  - **`launch/ingestion-fix-maxspeed-zero`**: laut Ingestion-Instanz eigenem Risikohinweis (`docs/status.md`) ein Duplikat des `maxspeed=0`-Fixes, den die Ingestion-Instanz unter einem anderen Commit-Hash bereits selbst eingebracht hat (in PR #3/#2 enthalten). Geprüft: der Fix ist tatsächlich in `ingestion/src/pipeline/osm/normalize.ts` auf `main` vorhanden. **Sicherer Löschkandidat.**
  - **`launch/local-test` — bitte NICHT löschen, sondern entscheiden:** dieser Branch ist **nicht** in einem der neun Pull Requests aufgegangen und enthält echte, bereits durchgeführte Arbeit, die nirgends sonst existiert: `tools/test-client/` (CLI + kleine Weboberfläche, gegen die Bibliothek/HTTP getestet), `tools/start-docker-desktop.ps1` (das Skript, das mir bei diesem Prüfbericht selbst die Docker-Desktop-Abstürze behoben hat), `deploy/federation-local/docker-compose.federation.yml`, und `docs/launch-checklist.md` mit der bereits bestandenen 9-Punkte-Abnahmeprüfung von Launch L. Das ist kein Alt-Branch, sondern unveröffentlichtes fertiges Ergebnis. **Frage an dich:** eigene Nachzügler-PR dafür öffnen (Doku + Testwerkzeug, kein Produktcode), oder bewusst außen vor lassen (z. B. weil es Windows-Betreiber-lokale Skripte enthält, die nicht jeder braucht)?
- Keine auskommentierten Codereste oder Debug-Ausgaben gefunden bei den Stichproben in Abschnitt 3/6.

---

## 9. Was ich bewusst nicht getan habe

- `docs/federation.md`/`docs/todo.md`/`.env.example`s `trafficnetwork.example`-Platzhalter **nicht ersetzt** — auf deine Anweisung hin für R3 zurückgestellt (siehe deine Nachricht: Domain steht fest auf `trafficnetwork.info`, Ersetzung in einem eigenen Commit nach diesem Prüfbericht).
- Branches **nicht gelöscht** — Freigabe steht noch aus (siehe Abschnitt 8).
- `docs/privacy.md`, Betreiberbedingungen, Blitzer-Rechtsprüfung, Autobahn-API-Lizenz, echter Netzwerk-Wurzelschlüssel: **nicht angefasst**, wie im Auftrag vorgesehen — siehe Abschnitt 10 (Blocker), das ist deine Entscheidung, nicht meine Aufgabe.
- Rust-Abhängigkeitslizenzen: nicht geprüft (Zeitbudget) — als offene Empfehlung in Abschnitt 7 vermerkt statt stillschweigend übersprungen.
- Europa-Maßstab (12+ Mio. Zeilen) selbst nachgebaut: nicht wiederholt — die E-B-Messungen der Server-Instanz (`server/docs/europe-scale.md`) sind bereits mit dem echten `tn-europe`-Bestand belegt, ein zweiter Durchlauf hier hätte nur Rechenzeit gekostet, ohne neue Information.

---

## 10. Bekannte Blocker vor einem öffentlichen Start (nur bestätigt, nicht bearbeitet)

- `docs/privacy.md` existiert nur als **Entwurf** (`feature/server-web-ui`), keine rechtliche Prüfung — bestätigt vorhanden, aber Entwurfsstatus.
- Betreiberbedingungen für fremde Knoten: nicht gefunden — offen.
- Blitzer-Namensraum: Flag bleibt aus (bestätigt, Abschnitt 5) — rechtliche Prüfung weiterhin offen, nicht meine Aufgabe.
- Autobahn-API-Lizenz: laut `ingestion/docs/sources.md` weiterhin ungeklärt, entsprechend im Code abgeschaltet — bestätigt.
- Projektdomain (`trafficnetwork.info`) und Netzwerk-Wurzelschlüssel: liegen beim Betreiber, wie vorgesehen; Domain-Ersetzung folgt in R3 (siehe Abschnitt 9).

---

## Zusammenfassung für R2/R3

Der Merge (R2) ist abgeschlossen, `main` ist grün, dieser Bericht ist der geforderte Nachweis **nach** dem Merge (mit deiner Zustimmung so umsortiert, siehe Sitzungsverlauf). Bevor ich zu R3 (Prompts auslagern, Doku entrümpeln, Domain ersetzen) übergehe, brauche ich von dir:

1. Freigabe, die gemergten/überholten Branches zu löschen (Liste in Abschnitt 8).
2. Entscheidung zu `launch/local-test` (Nachzügler-PR oder bewusst auslassen).
3. Zur Kenntnis: der `.env.example`-`DATABASE_URL`-Stolperstein (Abschnitt 6) — soll ich den beheben, oder der Server-Instanz/dir überlassen?
