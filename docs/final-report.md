# Abschlussbericht (R5)

Stand: 2026-09-28. Server ist als `v1.0.0` freigegeben, Ingestion als `v0.2.0` (siehe [`CHANGELOG.md`](../CHANGELOG.md), Releases: [server-v1.0.0](https://github.com/Romsmo/Trafficnetwork/releases/tag/server-v1.0.0), [ingestion-v0.2.0](https://github.com/Romsmo/Trafficnetwork/releases/tag/ingestion-v0.2.0)). Vollständige Belege, jeder Fund einzeln nachvollziehbar: [`docs/audit.md`](audit.md).

Kurz und ehrlich, ohne Beschönigung.

---

## 1. Was fertig und benutzbar ist

**Server (`server/`, v1.0.0):** Läuft self-hosted (Docker oder ohne Docker hinter Apache/nginx/Caddy), einzeln oder föderiert mit anderen Knoten (offene Mitgliedschaft, Reputation, signierte Daten). Ereignisprotokoll, Snapshot-/Delta-Sync, Moderationsgate, Bulk-Import, WebSocket-Push, Blitzer-Namensraum standardmäßig aus. Zusatzfunktionen: eingebaute Weboberfläche, „aktuell online"-Anzeige, Community-Tempolimit-Korrekturen, Europa-Maßstab (vorgebaute Statikdaten-Pakete), dauerhafte Überwachungsanlagen (Rotlicht/Abstand). Selbst durchgespielt, nicht nur behauptet: frischer Klon → `docker compose up` → `GET /v1/health` → Meldung über die echte Client-Bibliothek abgesetzt → im Browser auf der Karte gefunden.

**Client-Bibliothek (`client-lib/`, v1.0.0):** Ein Rust-Kern mit dünnen Anbindungen für alle zugesagten Plattformen — C-ABI (Linux, macOS, Windows) mit Python und Node.js, WebAssembly für den Browser, Kotlin/Android, Swift/iOS/macOS, Dart/Flutter, React Native —, an einem gemeinsamen Szenariensatz gemessen (gleiches Ergebnis über Python, Node.js, WebAssembly, Kotlin, Swift, Dart), gegen ein echtes Mehrknoten-Testnetz und gegen den Docker-Server vom frischen Klon aus verifiziert (Abschnitt 4). Je Plattform eine Integrationsanleitung mit nachbaubarem Minimalbeispiel in [`client-lib/docs/`](../client-lib/docs/); die Pakete entstehen als Build-Artefakte in CI, veröffentlicht ist nichts. Was nicht belegt ist, steht in [`client-lib/README.md`](../client-lib/README.md) unter „Was noch fehlt“.

**Ingestion (`ingestion/`, v0.2.0):** OSM-Bulk-Import mit Wiederaufnahme nach Abbruch, Europa-Grundstock einmalig importiert (13,68 Mio. Zeilen), Baustellen-Import (DATEX II, Autobahn-JSON), amtliche Schilder aus Norwegen, Qualitätsbericht. Läuft ausschließlich als gewöhnlicher Client gegen die öffentliche API — kein privilegierter Zugriff, jederzeit abschaltbar.

**Rundherum:** keine echten Geheimnisse im Repo oder in der Historie (gitleaks über 217 Commits geprüft), keine Lizenzkonflikte in den Node-Paketen, ODbL-Attribution sichtbar, Apache-2.0-`LICENSE` vorhanden, `README.md` mit Schnellstart oben, `CHANGELOG.md` mit dem Weg bis hierher, GitHub Actions grün auf allen vier Workflows.

## 2. Was bewusst offen ist (keine Betreiber-Aufgabe, sondern weitere Entwicklung)

- **Client-Bibliothek nach 1.0 (nie zugesagt, aber wichtig zu wissen):** Veröffentlichung in Paketregistern (npm, Maven, pub.dev, CocoaPods) wartet auf eine ausdrückliche Freigabe; Kotlin/Android, Swift/iOS und React Native werden gebaut, aber nicht auf Gerät, Emulator oder Simulator ausgeführt (nur die Flutter-App läuft auf einem Android-Emulator); ein echter TLS-Handshake gegen einen Server ist nirgends getestet (alle Tests laufen über `http://`). Das Release selbst (`client-lib-v1.0.0`) löst erst ein Tag aus, das du setzt.
- **Baustellen-Dauerbetrieb:** Der Import ist gebaut und getestet, aber nicht als wiederkehrender Lauf eingerichtet — das war für diesen Stand bewusst nicht der Auftrag (`ingestion/docs/roadworks.md`).
- **Ungeklärte Quellen:** HERE, TomTom, Mobilithek sind katalogisiert, aber abgeschaltet (keine Zugänge, keine belastbare Lizenz-/Preisrecherche). NDW (Niederlande) wartet auf Lizenzklärung. Schweden-Schilder brauchen einen Lastkajen-Zugang, den es nicht gibt.
- **Kleinere, benannte Lücken ohne Betreiber-Bezug:** `federationEventId` fehlt weiterhin in Snapshot/Delta (Confirm/Deny-Föderation braucht das später); Abschnittskontrolle (`enforcement=average_speed`) nicht gebaut; acht kleinere Konfigurationsfragen zu den dauerhaften Überwachungsanlagen sind mit dokumentierten Standardwerten entschieden, nicht mit dir abgestimmt (`server/docs/persistent-enforcement-devices.md` §10) — jede davon ist eine kleine, spätere Änderung.

## 3. Was bei dir als Betreiber liegt

Das sind die Punkte, die einen öffentlichen Start verhindern, unabhängig vom Code-Zustand:

- **`docs/privacy.md` (DSGVO):** existiert nur als Entwurf, keine rechtliche Prüfung.
- **Betreiberbedingungen für fremde Knoten:** fehlen komplett — wer föderiert beitreten darf und unter welchen Bedingungen, ist nirgends fixiert.
- **Rechtliche Prüfung des Blitzer-Betreiberrisikos (§23 Abs. 1b StVO):** steht aus. Das Flag bleibt technisch aus, bis das geklärt ist — das ist absichtlich hart verdrahtet, nicht nur eine Empfehlung.
- **Domain `trafficnetwork.info`:** in Code und Doku bereits als die feste Adresse eingetragen (eine konfigurierbare Stelle je Paket) — aber real weder registriert noch im DNS. Ohne das laufen `client-lib`s eingebaute Seeds ins Leere.
- **Netzwerk-Wurzelschlüssel:** muss offline erzeugt und sicher verwahrt werden, bevor die signierte Netzwerk-Konfiguration (und damit z. B. eine spätere Blitzer-Freigabe) irgendeine Bedeutung hat. Die Werkzeuge dafür sind fertig (`server/scripts/network-*.mts`), der eigentliche Schlüssel nicht.
- **Mindestens zwei Seed-Server, verschiedene Anbieter:** noch nicht bereitgestellt — ohne die findet ein neuer Knoten das Netzwerk nicht.
- **Autobahn-API-Lizenz:** direkt bei der Autobahn GmbH/BMV erfragen — die Quelle bleibt bis dahin abgeschaltet.
- **`tn-europe` selbst:** die 2.000 doppelt importierten Segmente entfernen, danach `pg_dump` als Grundstock ziehen (SQL liegt im Europa-Bericht bereit, ausgeführt werden muss es auf dem echten Knoten).

Keiner dieser Punkte ist ein Code-Mangel — das sind durchweg Entscheidungen und Handlungen, die nur du treffen bzw. ausführen kannst.

---

## 4. Ende-zu-Ende-Lauf vom frischen Klon (client-lib 1.0.0, 2026-10-03/04)

Vorgeführt, nicht behauptet: Server in Docker, API, Weboberfläche und die Client-Bibliothek über zwei Anbindungen — von einem frischen Klon und den **veröffentlichten Artefakten** aus, wie ein Fremder es täte. Befehle, Ausgaben und Bilder liegen unter [`docs/durchstich/evidence/`](durchstich/evidence/), die Skripte in [`docs/durchstich/`](durchstich/README.md) (jede Datei dort ist die Handarbeit dieses Laufs, keine Testsuite).

**Aufbau.** Windows-11-PC, Docker Desktop 29.8, Python 3.12, Node. Klon: `git clone --branch rework/client-lib-release https://github.com/Romsmo/Trafficnetwork` (anonym, ohne Anmeldung; Stand `6171c1e`). Bibliothek: die Datei-Sammlung `trafficnetwork-release-files` des grünen CI-Laufs [37155564992](https://github.com/Romsmo/Trafficnetwork/actions/runs/37155564992) (Commit `cf84324`, 13 Dateien, `sha256sum -c checksums.txt` → alle OK, [`step0-checksum-verify.log`](durchstich/evidence/step0-checksum-verify.log)). Benutzt wurden daraus `trafficnetwork-1.0.0-py3-none-any.whl`, `trafficnetwork-c-abi-1.0.0-windows-x86_64.zip` und `trafficnetwork-client-web-1.0.0.tgz`. Nichts davon ist in einer Registry veröffentlicht; das GitHub-Release `client-lib-v1.0.0` gibt es noch nicht (Tag erst nach deiner Freigabe).

**Umgebungsabweichung, offen genannt:** ein TLS-prüfender Virenscanner dieses PCs bricht `npm ci` im Docker-Build ab. Nur im Wegwerf-Klon steht deshalb `npm config set strict-ssl false &&` vor `npm ci` im `server/Dockerfile` — nicht committet, nicht Teil des Repos, auf einem PC ohne solchen Proxy nicht nötig. Das GHCR-Image `ghcr.io/romsmo/trafficnetwork-server` ist anonym **nicht** abrufbar (`unauthorized`); der Schnellstart baut deshalb lokal, wie die README es ohnehin beschreibt.

### Punkt 1 — Server in Docker: bestanden
`cp .env.example .env` (zwei Werte gesetzt), `docker compose up -d` → Postgres, Migrationen, Server; `GET /v1/health` → `{"status":"ok","database":"ok"}`, 19 Tabellen ([`step1-health.log`](durchstich/evidence/step1-health.log), [`step1-compose-up.log`](durchstich/evidence/step1-compose-up.log)). Kein verstecktes Zwischenstück — außer einem, das **bei der ersten Durchführung auffiel und repariert ist:** nach `docker compose down -v` hat `up -d` ein *vorhandenes altes Image* weiterverwendet (die Weboberfläche zeigte noch den alten Text). Das ist Compose-Standardverhalten; `server/docs/installation.md` sagt jetzt, dass nach neuem Code `up -d --build` nötig ist. Der gezeigte Lauf wurde danach mit `down -v --rmi local` ohne vorhandenes Image wiederholt (gebaut aus dem Klon; lokaler Layer-Cache, 17 s).

### Punkt 2 — echte API-Aufrufe nach `server/docs/api.md`: bestanden
Zugänge mit dem Snippet aus `server/docs/installation.md` („Create the first client“), dann [`api.sh`](durchstich/api.sh): Tempolimit-Segment importieren (Scope `bulk-import`), `GET /v1/speed-limit?lat=52.52&lng=13.405` → 30 km/h, `GET …/nearby` leer → `POST /v1/hazard-reports` (`201`, `merged:false`) → `POST …/confirmations` (anderer Zugang) → `GET …/nearby` zeigt die Meldung mit `confirmCount: 1` ([`step2-api.log`](durchstich/evidence/step2-api.log)). **Gefunden:** diesen ersten Zugang konnte man im Docker-Stack nach der damaligen Anleitung nicht anlegen (`server/scripts/` liegt nicht im Image) — repariert (Doku, keine Serveränderung).

### Punkt 3 — Weboberfläche: bestanden, mit einem Fund, der behoben ist
Karte lädt, auf Berlin zentriert; die per API gemeldete Meldung ist zu sehen ([`web-1`](durchstich/evidence/web-1-report-posted-via-api.jpg)); „Gefahr melden“ → Glätte → Kartenmitte → Melden: „Danke! Deine Meldung ist jetzt auf der Karte.“, der Marker erscheint **ohne Neuladen** ([`web-2`](durchstich/evidence/web-2-report-posted-via-ui.jpg)). Die Seite „Verbinden“ ([`web-3`](durchstich/evidence/web-3-connect-page.jpg)): die Docker-Schritte und die `curl`-Beispiele der Seite wurden wortgleich ausgeführt und stimmen ([`step3-connect-page-commands.log`](durchstich/evidence/step3-connect-page-commands.log)). **Gefunden:** die Seite versprach noch Codebeispiele „sobald die Plattform-Bindings der Bibliothek fertig sind“ — überholt. Text korrigiert (de/en, nur Text in `server/web/public/assets/i18n/`, eigener Commit im B5-PR; das ist eine kleine, bewusste Ausnahme von „keine Server-Änderungen“, siehe dort). Nicht auf der Seite, aber nötig: wie man den ersten Zugang anlegt — das steht in der verlinkten Installationsanleitung.

### Punkt 4 — Bibliothek über zwei Anbindungen, nach den Anleitungen: bestanden
**Native (Python-Wheel + C-ABI-DLL aus dem Release-Archiv, Windows)** — [`native.py`](durchstich/native.py), [`step4-native.log`](durchstich/evidence/step4-native.log): `native library 1.0.0`; Registrieren per App-Schlüssel (Scope `device-registration`; eigene Geräte-`clientId`, Schlüssel im `secure-store.json`) und Bootstrap beim ersten `sync()` → `ok=True`; `getSpeedLimitAt(52.52, 13.405)` → 30 km/h aus dem Bootstrap; Meldung abgesetzt (lokal sofort sichtbar, `sync` → `submitted=1`, beim Server unter der Geräte-ID); **Push** — eine Meldung eines anderen Geräts kommt als `dataChanged` an und ist danach lokal sichtbar; **Server gestoppt**, Meldung gepuffert (`sync` → `ok=False`, `dynamicDataError=network`, `pendingWrites=1`, lokal weiter sichtbar), Server gestartet, `sync` → `submitted=1`, beim Server angekommen.

**Browser (`trafficnetwork-client-web-1.0.0.tgz` in ein leeres Projekt installiert, mit `python -m http.server` bedient)** — [`step4-web-example.log`](durchstich/evidence/step4-web-example.log), [`step4-browser.log`](durchstich/evidence/step4-browser.log): die **Beispielseite des Pakets** (`example/index.html`, so wie die Anleitung sie vorgibt) → `sync ok: true`, Tempolimit 30 km/h, „Report an accident“ → beim Server. Danach die Schritte aus [`browser.html`](durchstich/browser.html) (README-Muster des Pakets): Registrieren/Bootstrap, Tempolimit, Meldung (lokal sofort sichtbar, dann gesendet), **Push** (`startRealtime()`; eine Meldung eines anderen Zugangs kommt als `dataChanged` an, ohne ein weiteres `sync()`), **Offline-Puffer** (Server gestoppt → `ok:false, network, pendingWrites:1`; Server gestartet → `submitted:1`).

### Punkt 5 — Zusammenspiel: bestanden
Eine Meldung der Bibliothek (Browser) erscheint in der bereits offenen, nie neu geladenen Weboberfläche innerhalb von 4 s als „Hindernis“ ([`web-4`](durchstich/evidence/web-4-report-from-browser-library.jpg)); die Meldung, die dort über das Formular gemacht wird („Glätte“, [`web-5`](durchstich/evidence/web-5-report-posted-via-ui-seen-by-library.jpg)), liefert `getNearby` der Bibliothek nach dem nächsten `sync()` (`ice`, 0 m). Die Meldungen der nativen Anbindung und der Beispielseite stehen in der Weboberfläche (Stau, Unfall) und umgekehrt in der Bibliothek.

### Was dieser Lauf gefunden hat (alles behoben, außer wo es steht)
| Fund | Wirkung | Stand |
|---|---|---|
| **Push erreichte einen echten Server nie** — die Bibliothek öffnete `http://…/v1/ws` statt `ws://` | in keinem Mock-Test sichtbar; jede Anbindung ohne Push gegen einen echten Server | behoben im Kern (`push_url`), URL-Tests + Mehrknoten-Test gegen einen echten Server (CI) |
| Erster Zugang im Docker-Stack nicht anlegbar | Fremder kommt nach dem Start nicht weiter | Doku: `server/docs/installation.md`; Anleitungen verweisen darauf |
| `docker compose up` nutzt ein vorhandenes altes Image | „frischer“ Start zeigt alten Stand | Doku-Hinweis (`--build`) |
| „Verbinden“-Seite versprach schon Fertiges als künftig | irreführend | Text korrigiert (B5-PR, eigener Commit) |
| Windows-Archiv enthält die DLL, aber nicht deren Importbibliothek | MSVC-Nutzer können damit nicht linken | **offen, dokumentiert** in `client-lib/docs/releases.md` (MinGW/Laufzeitladen oder aus dem Quelltext bauen); verletzt keine Zusage, die Anleitung beschreibt den MinGW-Weg |
| GHCR-Image anonym nicht abrufbar | `docker pull` scheitert | **offen**, Sache des Betreibers (Sichtbarkeit des Pakets); der Schnellstart baut lokal und ist davon unberührt |
| TLS-prüfender Virenscanner dieses PCs | `npm ci` im Docker-Build scheitert | nur lokale Umgebung, nicht im Repo (siehe oben) |
| Docker Desktop startete nach einem Neustart nicht | Wartezeit | bekannter Fehler, `tools/start-docker-desktop.ps1` |

### Grenzen dieses Nachweises (so, wie sie sind)
- **Ausgeführt** wurde die Bibliothek in diesem Lauf nur über Python/C-ABI (Windows) und den Browser (Chromium im eingebetteten Browser der Claude-Desktop-App). Kotlin/Android, Swift/iOS und React Native sind in CI gebaut, aber nicht ausgeführt (Konformität: JVM, macOS); die Flutter-App läuft in CI auf einem Android-Emulator. Das steht auch in den Anleitungen und in `client-lib/README.md`.
- Alle Verbindungen dieses Laufs gingen über `http://localhost` — ein echter TLS-Handshake gegen einen Server ist hier wie in CI **nicht** geprüft.
- Das Release-Workflow (`client-lib-v*`) ist nicht ausgeführt, weil es erst ein Tag auslöst; die Montage der Dateien (`release-files`) läuft dagegen in jedem CI-Lauf.
- Der gezeigte Klon steht auf `6171c1e`; seitdem sind nur ein Test (`tn_library_version`-Prüfung), Doku und Dateien dieses Berichts dazugekommen, kein Bibliothekscode.

---

## `docs/status.md` — mein Vorschlag

**Bleibt vorerst.** Die Client-Bibliothek-Instanz arbeitet aktiv weiter (B3–B5), und `docs/status.md` ist genau dafür da: laufende Arbeit zwischen Instanzen zu koordinieren, ohne dass jede ihren eigenen Kontext neu aufbauen muss. Sie jetzt zu entfernen, würde diese Koordination beenden, während sie noch gebraucht wird.

Mein Vorschlag: Wenn B3–B5 abgeschlossen sind (oder du die Arbeit an der Client-Bibliothek anderweitig für beendet erklärst), räumt die dann tätige Instanz `docs/status.md` in einem letzten, kurzen Schritt weg — Inhalt, der noch von Dauer ist (z. B. offene Nebenbefunde), wandert vorher nach `docs/todo.md`, der Rest ist dann wirklich nur noch Verlaufsprotokoll und kann raus. Das ist keine große Aufgabe, aber eine eigene, nicht Teil von R5 selbst, weil R5 explizit *vor* dem Abschluss der Client-Bibliothek stattfindet.

**Update (Client-Bibliothek-Instanz, 2026-10-03): B3–B5 sind abgeschlossen** (Version `1.0.0`, siehe `CHANGELOG.md`). Die Abschluss-Instanz kann `docs/status.md` jetzt entfernen; was darin noch von Dauer ist, steht in `docs/todo.md` (Eintrag „Client-Bibliothek nach 1.0“) und in `client-lib/README.md` („Was noch fehlt“).
