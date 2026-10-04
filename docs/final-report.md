# Abschlussbericht

Stand: 2026-10-05. Der Bericht hat drei Teile: was fertig und benutzbar ist, was bewusst offen ist, was beim Betreiber liegt. Dahinter steht der Beleg — ein Durchstich, den die Abschluss-Instanz selbst aus einem frischen Klon gemacht hat, ohne sich auf die Meldungen der anderen Instanzen zu stützen. Die früheren Prüfungen stehen in [`docs/audit.md`](audit.md), der Weg bis hierher in [`CHANGELOG.md`](../CHANGELOG.md), die Reste in [`docs/todo.md`](todo.md).

## 1. Fertig und benutzbar

| Paket | Version | Stand |
|---|---|---|
| `server/` (mit eingebauter Weboberfläche) | **1.0.0** | Release `server-v1.0.0`, Image `ghcr.io/romsmo/trafficnetwork-server:1.0.0` (privat). `main` enthält danach die Länder-Politik für Blitzer, die Serialisierungs-Korrektur und die Weboberfläche dazu; ein neues Server-Release (Image mit diesen Änderungen) ist noch nicht geschnitten. |
| `ingestion/` | **0.2.0** | Release `ingestion-v0.2.0`; bewusst kein 1.0 (Quellenkatalog in Bewegung, mehrere Quellen ohne geklärte Lizenz abgeschaltet). |
| `client-lib/` | **1.1.0** im Code | Kern plus Anbindungen für C/C++, Python, Node.js, Browser (WebAssembly), Android, iOS/macOS, Flutter und React Native, derselbe Szenariensatz über alle. Release/Tag siehe Schlussmeldung. |

Benutzbar heißt: Ein Fremder kann den Server mit zwei Einträgen in `.env` und einem `docker compose up -d` starten, hat sofort Weboberfläche und API, kann Zugangsdaten anlegen (Anleitung in `server/docs/installation.md`) und mit einer der Bibliotheken Daten holen, melden, bestätigen und offline nachreichen. Föderation, Reputation, signierte Daten, Europa-Maßstab, Tempolimit-Korrekturen, dauerhafte Anlagen (Rotlicht/Abstand) und die „aktuell online"-Anzeige sind eingebaut und getestet.

**Blitzer** sind freigeschaltet, wie jede andere Kategorie: Standard `full` in jedem Land. In der Weboberfläche steht der Filter beim ersten Besuch auf aus, und beim ersten Anhaken erscheint der Rechtshinweis; in der Client-Bibliothek ist die Host-Option „Blitzer anzeigen" standardmäßig aus. Einzelne Länder lassen sich per signierter Politik auf `zones` (nur grobe Flächen) oder `off` setzen; die Notbremse `SPEED_CAMERA_NAMESPACE_ENABLED=false` schlägt alles. **Der Code gibt nichts davon von allein frei oder schränkt von allein ein:** Ohne eine vom Betreiber signierte Politik gilt `full` überall.

## 2. Bewusst offen

Was nie zugesagt war oder bewusst zurückgestellt ist — Einzelheiten in [`docs/todo.md`](todo.md), Abschnitt 4:

- Baustellen-Dauerbetrieb (der Import ist gebaut, läuft aber nicht als wiederkehrender Lauf); Quellen mit ungeklärter Lizenz bleiben aus (Autobahn-API, NDW; HERE/TomTom/Mobilithek sind nur katalogisiert); Schweden-Schilder brauchen einen Zugang, den es nicht gibt.
- Veröffentlichung der Client-Pakete in Registern (npm, Maven, pub.dev, CocoaPods) — jede eine eigene Freigabe.
- Kotlin/Android, Swift/iOS und React Native sind gebaut und auf JVM bzw. macOS in der Konformität geprüft, aber nicht auf Emulator/Gerät ausgeführt (nur die Flutter-App läuft auf einem Android-Emulator); kein TLS-Handshake gegen einen echten Server getestet (alle Tests über `http://`).
- Weboberfläche: „Stimmt nicht?"-Formular, Startansicht Europa/Cluster, Quellen-Attribution; in sehr großen Kartenausschnitten kommen neue Meldungen erst mit dem Minutentakt statt live.
- Abschnittskontrolle, Land des Fahrers bei der Blitzer-Politik, `federationEventId` für föderiertes Bestätigen.
- Zwei Beobachtungen aus dem Durchstich (unten, Funde 4 und 5), die nicht in diesem Bericht behoben sind.

## 3. Beim Betreiber

Nichts davon kann der Code oder diese Instanz erledigen:

- **`docs/privacy.md`** (DSGVO) fertigstellen und rechtlich prüfen lassen; **Betreiberbedingungen** für fremde Knoten schreiben und prüfen lassen.
- **Domain `trafficnetwork.info`** registrieren und DNS einrichten; **zwei Seed-Server** bei verschiedenen Anbietern; **Netzwerk-Wurzelschlüssel** offline erzeugen und verwahren; Backups, Überwachung, Update-Weg.
- **Autobahn-API-Lizenz** erfragen; NDW-Lizenz klären.
- **Öffentliche Sichtbarkeit** von Repository und Container-Images entscheiden (beides ist privat).
- **Blitzer-Politik:** rechtliche Prüfung je Land, vor allem Schweiz und Frankreich; Entscheidung `off`/`zones`/`full` je Land; **echten Grenzdatensatz laden** (der Durchstich hat nur drei selbstgezeichnete Rechtecke verwendet) und die Einschränkung mit dem Wurzelschlüssel **signieren**; Wortlaut des Rechtshinweises freigeben. Ausgeliefert wird mit „Standard `full`, Oberflächen blenden Blitzer aus" — jede Einschränkung muss der Betreiber selbst hinterlegen.
- **`tn-europe`:** die 2.000 doppelten Segmente entfernen, `pg_dump` ziehen, dann das neue Image starten (Migrationsfenster etwa 6 Minuten).

---

## Durchstich vom frischen Klon (2026-10-04/05)

Neues leeres Verzeichnis, `git clone` von `main` (`99ac441`), nur das, was im Repo steht. Eigene Skripte und Bilder: [`docs/durchstich/r6/`](durchstich/r6/README.md). Lokale Besonderheiten dieses Windows-Rechners (Norton prüft TLS und signiert neu: der Docker-Build brauchte lokal sein Wurzelzertifikat; `wasm-opt` ließ sich nicht herunterladen, deshalb `wasm-pack build --no-opt`) sind keine Repo-Fehler und stehen nur hier.

### 1 — Compose-Stack: bestanden
`cp .env.example .env`, nur `POSTGRES_PASSWORD` und `JWT_SECRET` gesetzt (`# DATABASE_URL=…` bleibt auskommentiert), `docker compose up -d --build`:
```
postgres Up 19 seconds (healthy)
server   Up 8 seconds (healthy)
server-1 | Migrations complete.
$ curl localhost:3000/v1/health
{"status":"ok","database":"ok"}
```

### 2 — API gegen `server/docs/api.md` (Typ und Format): bestanden
`docs/durchstich/r6/api_check.py` prüft u. a.: `POST /v1/auth/token` → `accessToken` als String; Tempolimit (`speedLimit` ganzzahlig, `speedLimitUnit` = `kmh`; 404 weit weg, wie dokumentiert); `POST /v1/hazard-reports` → 201, `report.id` UUID, `reportedAt`/`expiresAt` **RFC 3339**, `confirmCount` ganzzahlig, `merged: false`; zweite Meldung derselben Art binnen 500 m → 200, `merged: true`; `hazard-reports/nearby` genau 1 Eintrag; Snapshot `snapshotSequence` und Delta `nextSince`/`events[].sequence` **Zahlen**, `occurredAt` RFC 3339; `GET /v1/config` → `cameraPolicy.defaultLevel: "full"`, `byCountry: {}`.
Eine Prüfung schlug zunächst fehl — Ursache war mein Skript (Feld `confirmation` statt dokumentiert `kind`); mit `{"kind":"stillThere"}` durch einen zweiten Zugang: `200, recorded=true, confirmCount 0→1, expiresAt verlängert`; dieselbe Person ein zweites Mal: `recorded=false` (dokumentiert).

### 3 — Weboberfläche im Browser: bestanden, mit zwei Funden
Karte lädt (Version 1.0.0 in der Fußzeile, OSM-Attribution), die Meldungen aus API und Bibliothek erscheinen als Marker und in der Liste ([Bild 1](durchstich/r6/web-1-library-and-api-reports-on-map.jpg)). Eine neue Meldung per API erscheint **ohne Neuladen**: bei nahem Zoom innerhalb weniger Sekunden (Marker und Liste); in einem landesgroßen Ausschnitt erst nach rund 45 s — Fund 3. Die Seite „Verbinden" (`/connect`) zeigt die vier Docker-Schritte, die API-Beispiele und den Knotenstatus (Knoten-ID, Version 1.0.0, „Föderation: nicht aktiv", 0 weitere Knoten); `health`, `network/node-info`, `network/directory` antworten ohne Token mit 200, wie dort behauptet. Melden aus der Oberfläche: Dialog mit allen Kategorien inklusive Blitzer, Rückmeldung „Danke! Deine Meldung ist jetzt auf der Karte." ([Bild 4](durchstich/r6/web-4-report-from-web-ui-confirmed.jpg)); bei Blitzer-Meldungen erklärt die Seite, dass sie erst mit eingeschaltetem Filter sichtbar wird.

### 4 — Client-Bibliothek von zwei Anbindungen, streng nach den Anleitungen: bestanden
**Native (Python über das C-ABI)**, `integration-python.md`: `cargo build -p trafficnetwork-c-abi --release` (1 min 36 s), dann das Beispielprogramm wie dort beschrieben:
```
native library 1.1.0
sync ok: true, pending writes: 0
speed limit here: {… 'unit': 'kmh', 'value': 30.0 …}
4 things within 2 km
queued report 1e109a94…; sync ok: true
```
Danach `py_flow.py`: Registrierung mit App-Schlüssel (Scope `device-registration`) beim ersten `sync()`, Bootstrap, Tempolimit lokal 30 km/h, 4 Meldungen aus der Umgebung, eigene Meldung sofort sichtbar und `pending`, gesendet (`submitted: 1`), **Push** (`start_realtime()`: eine per REST abgesetzte Baustelle ist nach 0,01 s in `get_nearby`, 7 Ereignisse im Callback), **Offline**: Server gestoppt → Meldung sofort sichtbar und `pending`, `sync()` → `dynamicDataError: network, pendingWrites: 1`, kein Absturz; Server gestartet → `submitted: 1, pendingWrites: 0`, die Meldung steht auf dem Server. (Ein Prüfpunkt meines ersten Offline-Laufs schlug fehl, weil ich die Offline-Meldung 480 m neben eine gleichartige gesetzt hatte und die Bibliothek sie wie der Server zusammenführt; mit einem freien Ort bestanden.)
**Browser (WebAssembly)**, `integration-web.md`: `wasm32`-Ziel und `wasm-pack` installiert, `wasm-pack build --target web --out-dir pkg` (lokal mit `--no-opt`, siehe oben), `client-lib/bindings/` mit `python -m http.server` ausgeliefert, Beispielseite `/wasm/example/`: `sync ok: true`, Tempolimit 30, „6 things within 2 km". Dann im Browser mit der Bibliothek selbst: Registrierung mit App-Schlüssel, Bootstrap (6 Meldungen, Tempolimit 30), `startRealtime()`, Push einer REST-Meldung ohne `sync()` sichtbar, Offline-Meldung (Server gestoppt: `ownVisiblePending: true`, `err: network`), danach `{ok:true, pending:0, submitted:1}`.

### 5 — Zusammenspiel in beide Richtungen: bestanden
Bibliothek → Weboberfläche: die Python-Meldung „Panne" steht in der Liste und auf der Karte; die Meldung der Browser-Bibliothek ging nach dem Neustart an den Server und ist per API da. Weboberfläche → Bibliothek: die in der Oberfläche gemeldete „Mobile Kontrolle" erscheint in der Python-Bibliothek mit `cameraNamespaceEnabled: true` (`[('hazard','mobileSpeedCamera')]`).

### 6 — Blitzer im Auslieferungszustand und mit Test-Politik: bestanden
**Auslieferungszustand** (`cam_probe.py`; Kameras in DE, CH, FR per Bulk-Import und Meldung angelegt, noch keine Grenzdaten, keine Politik): `config.cameraPolicy = {namespaceEnabled: true, defaultLevel: "full", byCountry: {}}`. Über **jeden** Lesepfad kommen Einzelpunkte in allen drei Ländern an: `speed-cameras/nearby` (DE 3, CH 4, FR 4), `by-tile`, Snapshot (`fixedSpeedCameras`/`enforcementDevices`), Delta, statische Pakete (3 Kacheln: DE 3, CH 5, FR 5); `hazard-reports/nearby` liefert nie Kameratypen (0). **Oberflächen:** beim ersten Besuch (leerer `localStorage`) sind alle fünf Blitzer-Kategorien aus, die übrigen an; beim ersten Anhaken von „Feste Blitzer" erscheint der Hinweis „Die Nutzung von Blitzer-Hinweisen während der Fahrt ist in mehreren Ländern verboten – in Deutschland auch für Beifahrer. In der Schweiz sind selbst bloße Hinweise unzulässig." ([Bild 2](durchstich/r6/web-2-legal-notice-on-first-tick.jpg)), danach erscheint die feste Kamera auf der Karte ([Bild 3](durchstich/r6/web-3-camera-filter-on-fixed-camera-shown.jpg)); `localStorage` merkt Filter und „Hinweis gesehen". Bibliothek: ohne Option 0 Kamera-Einträge (10 andere Einträge), `getCameraPolicy()` → `defaultLevel: "full", hostEnabled: false`; mit `cameraNamespaceEnabled: true` kommt die Kamera.
**Test-Politik** (Testschlüssel erzeugt, `--camera-policy "CH=off,FR=zones"` signiert, drei synthetische Grenzrechtecke geladen, per `docker-compose.override.yml` eingehängt): DE unverändert `full`; **CH `off`: auf allen Wegen nichts** — `nearby`, `by-tile`, Snapshot, Delta und Pakete liefern null Punkte, das CH-Paket ist weg; **FR `zones`: nur Flächen** (`cameras: []`, 2 Zonen), Snapshot `cameraZones`, Delta `cameraZone`, Pakete 2 Zonen-Objekte, keine Punkte. **Verdichtung:** `zone_probe.py` stellte 2 225 Anfragen (445 Positionen im Raster, darunter genau auf den echten Kameras, mal 5 Radien von 1 m bis 5 km) plus `by-tile` mit k = 0, 1, 5: nie ein Einzelpunkt, insgesamt nur **zwei** verschiedene Zonen (feste H3-Zellen, Auflösung 6), jede mit unveränderlichem Inhalt unabhängig von Ort und Radius der Anfrage. Bibliothek unter der Politik: DE eine Kamera, CH nichts, FR nur `cameraZone` (Fläche, keine Koordinate einer Kamera). **Notbremse** `SPEED_CAMERA_NAMESPACE_ENABLED=false`: auf allen Wegen null Punkte, `cameraPolicy.defaultLevel: "off"`. Danach Test-Politik wieder entfernt, Notbremse zurückgesetzt, erneut geprüft: wieder `full` überall (`byCountry: {}`); der ganze Teststack samt Datenbank wurde mit `docker compose down -v` gelöscht, der Testschlüssel liegt nicht im Repo.
**Nicht belegt:** die Darstellung der Zonenflächen in der Weboberfläche habe ich nicht selbst gesehen (das Verschieben der Karte nach Paris war im Browser-Werkzeug unpraktikabel); sie stützt sich auf den CI-Test (`cameras.spec.ts`). Und echte Landesgrenzen — der Lauf nutzt drei Rechtecke.

### Funde (alles, worüber ich gestolpert bin)
1. **Anleitung — behoben:** Die Schnellstart-Zeile im Haupt-README („dann `npm run create-client`") scheitert im Docker-Stack (`DATABASE_URL: Required`; die Datenbank ist von außen nicht erreichbar). Die richtige Anleitung steht in `server/docs/installation.md` („Create the first client"); das README verweist jetzt darauf. Die Seite „Verbinden" sagt nur „Zugangsdaten vergibt der Betreiber" — nicht behoben.
2. **Doku — behoben:** Das README behauptete „Blitzer-Namensraum ist per Default aus"; seit der Länder-Politik ist es `full` je Land. Audit und Launch-Checkliste tragen einen Nachtrag.
3. **Weboberfläche — dokumentiert, nicht behoben:** In einem landesgroßen Ausschnitt ist nicht jede Kachel live abonniert; neue Meldungen erscheinen erst mit dem Minutentakt (gemessen rund 45 s). Vermerkt in `server/docs/web-ui.md` und `docs/todo.md`.
4. **Bibliothek — nicht behoben:** Ein lokaler Speicher, der von einem früheren, anderen Server unter derselben Adresse stammt, behält dessen statische Segmente (die Beispielseite zeigte ein Tempolimit-Segment mit fremder ID); erst nach dem Löschen der IndexedDB-Datenbank stimmte es. Ausgelöst durch einen Rest aus einem früheren Lauf im Browser; im Alltag trifft es Betreiber, die einen Server neu aufsetzen. In `docs/todo.md`.
5. **Server — Fehler, Korrektur als eigener PR:** Trifft dieselbe signierte Föderationsmeldung gleichzeitig zweimal ein, antwortet `POST /v1/federation/events` mit HTTP 500 statt „duplicate" (`ingest.ts` liest `err.code`, Drizzle legt den Postgres-Fehler unter `err.cause`). In den CI-Logs jedes Mehrknotenlaufs sichtbar.
6. **Anleitung Browser — behoben:** `wasm-pack build` bricht ab, wenn `wasm-opt` nicht heruntergeladen werden kann (Proxy, offline); `--no-opt` hilft — jetzt in der Anleitung vermerkt.
7. **Prozess:** Gestapelte PRs (#14–#17) lassen sich nicht über GitHub mergen, ohne die Basis umzuhängen; sie wurden lokal gemergt und mit Verweis geschlossen.
