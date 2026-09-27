# Launch L — Abnahmeprüfung lokaler Testserver

Stand: 2026-09-23. Durchgeführt auf dem Nutzer-PC (Windows 11, Ryzen 7 5800X, 16 GB RAM, Docker Desktop 4.91 / WSL2), Server-Code aus `rework/server-federation` (= `main` seit PR #1), Ingestion-Tool aus `phase3/ingestion` **plus** dem Fix `launch/ingestion-fix-maxspeed-zero` (siehe unten), Region **Bayern** (Geofabrik-Extrakt, 852 MB). Alle Werte stammen aus den echten Läufen dieser Session; nichts geschätzt.

> **Nachtrag der Abschluss-Instanz (2026-09-27):** `launch/ingestion-fix-maxspeed-zero` wurde nicht separat gemergt — die Ingestion-Instanz hatte denselben Fix bereits unabhängig unter einem anderen Commit eingebracht (inhaltlich identisch, siehe `docs/audit.md` Abschnitt 8); der hier verlinkte Branch ist mittlerweile gelöscht. `client-lib` hat inzwischen ein C-ABI+Python-Binding und einen echten WebSocket-Transport (F-C4/B1, siehe `docs/prompt-client-lib-finish.md`) — der Satz zu "kein Binding" unten in Abschnitt "Was fehlt" ist entsprechend überholt. Alles andere hier ist unverändert der Originalbefund dieser Session.

## Ergebnis auf einen Blick

| # | Prüfung | Ergebnis |
|---|---|---|
| 1 | Server neu gestartet → Daten noch da | **bestanden** |
| 2 | Tempolimit stimmt (Stichprobe) | **bestanden gegen die Quelldaten** (80/80); Abgleich mit der Realität vor Ort nicht möglich — siehe Anmerkung |
| 3 | Meldung erscheint in der Umgebungsabfrage | **bestanden** |
| 4 | Zweites Gerät sieht die Meldung per Push in wenigen Sekunden | **bestanden** (≈ 0,1 s) |
| 5 | Bestätigung verlängert die Ablaufzeit, Verfall funktioniert | **bestanden** |
| 6 | Server gestoppt → Meldung gepuffert und nachgereicht | **bestanden** (10 s nach Start) |
| 7 | Blitzer-Kategorien liefern nichts, solange das Flag aus ist | **bestanden** |
| 8 | Zweiter Knoten (Föderation), Replikation, automatischer Wechsel | **bestanden** |
| 9 | Ressourcenverbrauch notiert | erledigt — **Warnung: `C:` fast voll** |

## Befüllung (L3)

- Werkzeug: das echte Ingestion-CLI (`ingestion/`), in Docker mit `osmium-tool` 1.15.0 (`tools/ingest-runner/Dockerfile`), gegen den lokalen Server, Client mit Scope `bulk-import`.
- **Ergebnis:** 438.595 Tempolimit-Segmente, 109.646 Schilder, 142 feste Blitzer (gespeichert, aber nicht ausgeliefert — Flag aus). Alles `source=osm`, `sourceLicense=ODbL`. Datenbank 169 MB. Kein Duplikat: die Zeilenzahl der DB entspricht exakt der Summe der Bestätigungen des Tools.
- Dauer (dieser PC, gemessen an den Log-Zeitstempeln): erster Lauf inkl. Download des 852-MB-Extrakts, osmium-Filter/Export und Import von 542.000 Zeilen bis zum Fehler 291 s; Resume der restlichen ~6.400 Zeilen 79 s (fast nur der erneute osmium-Durchlauf); komplette Befüllung eines zweiten, leeren Servers (Knoten B) mit bereits geladenem Extrakt 242 s.
- **Gefundener Fehler im Ingestion-Tool (behoben):** Ein einzelner OSM-Weg (`way/1526008141`) trägt `maxspeed=0`. Der Server verlangt `speedLimit > 0` und lehnt den **ganzen Batch** (2000 Zeilen) mit `400 Invalid request body` ab; der Lauf brach bei 434.000 Segmenten ab, ohne die Ursache zu nennen. Gefunden, indem alle ~548.000 normalisierten Zeilen gegen das Server-Schema geprüft wurden — genau diese eine Zeile war ungültig. Fix: `maxspeed` ≤ 0 überspringen (+ 3 Unit-Tests, alle 70 grün), Branch `launch/ingestion-fix-maxspeed-zero` (basierend auf `phase3/ingestion`, dort noch nicht eingespielt — die Ingestion-Instanz sollte ihn übernehmen). Danach lief der Resume ohne Doppelte durch.
- **Weitere Beobachtungen zum Tool:** Der Ingestion-CLI gibt nur `error.message` des Servers aus, nicht `error.details` (die Zod-Issues, die `ApiError` trägt) — im Log steht nur „Invalid request body“. Die approximative Manifest-Gegenprobe des Verifizierers meldet 384.566 Segmente / 99.844 Schilder (−12 %); das ist laut Tool „nur ein Sanity-Netz“ und kommt vermutlich von der Bbox→H3-Abdeckung, sollte aber nicht als Zahl zitiert werden.

## Prüfungen im Einzelnen (L5)

**1. Neustart.** `docker compose down` (Container entfernt, Volumes behalten) → `up -d`. Vorher/nachher identisch: 438.595 Segmente / 109.646 Schilder / 142 Blitzer / 9 Clients, Health `ok`. Zusätzlich überstanden die Container mehrere Docker-Desktop-Neustarts.

**2. Tempolimit.** (a) Zwei unabhängige Zufallsstichproben à 40 OSM-Wege mit numerischem `maxspeed` direkt aus dem osmium-Export gezogen; der Server (`GET /v1/speed-limit`) am Mittelpunkt des jeweils längsten Wegstücks liefert in **80 von 80** Fällen exakt Wert und Einheit der Quelle (Beispiele zum Nachschlagen auf openstreetmap.org/way/…: 9166169 residential 30, 850287750 residential 30, 115092846 tertiary 50, 29185247 tertiary 100, 278563494 motorway 120). (b) Verteilung der 438.595 Segmente plausibel: 30 km/h 171.005, 50 km/h 158.735, 100 km/h 54.826, 70/60/80 km/h 16.942/11.526/7.277, 20 km/h 6.340, 120 km/h 2.357 (ganz überwiegend Tempo-30-Zonen, Ortsstraßen, Landstraßen). (c) Ort ohne Daten (Atlantik) → 404, wie dokumentiert. **Anmerkung:** Ob OSM selbst an einer bestimmten Stelle der Beschilderung vor Ort entspricht, kann ich nicht prüfen — das geht am besten in der Weboberfläche des Testwerkzeugs mit OSM-Hintergrund und eigener Ortskenntnis.

**3. Meldung → Umgebung.** Über die Weboberfläche „Stau“ am Marienplatz gemeldet (HTTP 201); ein drittes Gerät sieht sie (und eine zweite „Glätte“-Meldung) mit `status=active`, korrektem `expiresAt` in `GET /v1/hazard-reports/nearby`.

**4. Push.** Zweite Instanz („device-b“, eigener Prozess/Profil) hört per WebSocket; Gerät A meldet um 20:40:24,193 → Gerät B erhält `ReportCreated` um 20:40:24,306 (≈ 0,11 s).

**5. Bestätigung/Verfall.** Weil der Standardverfall 25 min beträgt, wurde der Server für diese Prüfung **vorübergehend** mit `HAZARD_EXPIRY_MEDIUM_MINUTES=1` betrieben (danach zurückgesetzt). Meldung 18:41:15 → `expiresAt` 18:42:15,5. Bestätigung `stillThere` durch ein zweites Gerät um 18:41:45 → `expiresAt` 18:42:45,9 (= Bestätigungszeit + TTL, nicht „addiert“), `confirmCount=1`, per Push gemeldet. Danach markierte der Verfalls-Sweep (alle 60 s) die Meldung um 18:42:56,998 als `expired`, Gerät B erhielt `ReportExpired`, in `nearby` verschwand sie.

**6. Puffern.** Server gestoppt (`docker compose stop server`): Tempolimit-Abfrage wird aus der lokalen Kopie beantwortet (30 km/h, 114,95 m; Server: 115,12 m), die Karte bleibt; eine Meldung „Panne“ wird gepuffert (`outbox=1`). Server gestartet → Outbox nach **10 s** automatisch geleert, Meldung serverseitig vorhanden (`nearby` liefert sie). **Gefundene Lücke, behoben:** Das Push-Ereignis für die nachgereichte Meldung erreichte den lokalen Speicher des Geräts nicht, weil der WebSocket zum Zeitpunkt der Zustellung noch nicht wieder abonniert hatte → das Werkzeug liest jetzt nach jedem (Wieder-)Verbinden die Umgebung nach.

**7. Blitzer aus.** 142 feste Blitzer liegen in der DB. An drei zufälligen Blitzer-Koordinaten liefern `GET /v1/speed-cameras/nearby` und `GET /v1/hazard-reports/nearby?types=<alle fünf Kamera-Typen>` jeweils leere Listen; `GET /v1/snapshot` → `fixedSpeedCameras: []`; `GET /v1/config` → `speedCameraNamespaceEnabled: false`, signierte `networkConfig.blitzerEnabled: false`.

**8. Zwei Knoten.** Zweiter Knoten B (eigene Postgres-DB, eigener `JWT_SECRET`) neben A, beide `FEDERATION_ENABLED=true`, beide erreichbar unter `http://localhost:3000` bzw. `:3001` (die Loopback-Ausnahme erlaubt kein https; damit sich beide Container als „localhost“ sehen, teilen sie einen Netzwerk-Namespace — `tools/federation-local/docker-compose.federation.yml`).
- Beitritt/Gossip: B tritt A per `FEDERATION_SEEDS` bei; beide Verzeichnisse (`GET /v1/network/directory`) zeigen den jeweils anderen (Stufe `probation`), Heartbeats laufen.
- Replikation: geräte-signierte Meldung („Unfall“) auf A → nach **0,6 s** auf B (mit anderer lokaler ID — die knotenübergreifende ID wird per API noch nicht ausgeliefert). Meldungen ohne Signatur bleiben lokal (Kontrolle: eine unsignierte „Stau“-Meldung auf B tauchte auf A nicht auf — wie dokumentiert).
- Wechsel: Knoten A gestoppt → das Testwerkzeug (Gerät A) war nach **6 s** automatisch auf B (Health-Probe alle 5 s, WebSocket zieht mit um), Meldungen und Abfragen gingen an B (HTTP 201/200). A wieder gestartet → die auf B signiert erzeugte Meldung war nach ca. **25 s** (Anti-Entropy-Intervall 20 s) auch auf A, die unsignierte nicht.
- **Zwei Werkzeug-Lücken dabei gefunden und behoben:** (1) Ein fehlgeschlagener WebSocket-Aufbau markierte den Server nicht als ausgefallen, der Wechsel wartete auf die nächste Nutzeraktion → Health-Probe eingebaut. (2) Auf einem frischen Knoten ohne Statikdaten hätte „kein Segment (404)“ die lokale Kopie überstimmt → lokale Kopie ist jetzt Rückfall bei 404.
- Statische Daten (Segmente/Schilder) werden **nicht** zwischen Knoten repliziert (nur Meldungs-Ereignisse) — Knoten B bekam sie über eine eigene Ingestion.
- Nach dem Rückbau auf einen Knoten (`FEDERATION_ENABLED=false`) listet `GET /v1/network/directory` auf A weiterhin den zuvor bekannten Peer B — die Peer-Tabelle bleibt persistiert.

**9. Ressourcen (Ruhezustand, beide Knoten laufen).**

| | Wert |
|---|---|
| CPU | alle Container zusammen < 0,5 % im Leerlauf (Import-Last nicht gemessen) |
| RAM | Server A 250 MB, Server B 1,04 GB (nach dem Import, danach nicht zurückgegangen), Postgres A 138 MB / B 370 MB; **WSL-VM (`vmmemWSL`) 6,3 GB** von 16 GB |
| Platte `D:` | `docker_data.vhdx` 6,6 GB (Images, Volumes, Build-Cache), `ext4.vhdx` 0,1 GB, Ingestion-Downloads 2 GB (852 MB `.osm.pbf` + 1,3 GB osmium-Export, löschbar), Ingestion-Zustand 20 MB (nicht löschen — Resume/Dedup), Postgres je 169 MB |
| **Platte `C:`** | **nur noch 0,2 GB frei** (zu Beginn 6,6 GB). Größte Posten: `hiberfil.sys` 6,4 GB, Docker-Desktop-Programm 3,3 GB, `pagefile.sys` 3,9 GB, `%TEMP%` 1,9 GB (u. a. 0,8 GB `odis_download_dest`, 0,5 GB WSL-Installationspaket), npm-Cache 1,1 GB. Ursache des Schwunds nicht eindeutig; mit so wenig Platz kann Windows instabil werden. |
| Vollständiger Statik-Snapshot | `GET /v1/snapshot?staticData=true`: **195 MB**, 4,5 s. `GET /v1/static-data/manifest`: 6,1 s (wird pro Aufruf berechnet); Partitionen (H3-Auflösung 2) je 25–100+ MB. |

## Was fehlt vor einem öffentlichen Betrieb

- **Echter Netzwerk-Wurzelschlüssel**, offline erzeugt; die Test-Schlüssel in `server/local-secrets/` sind ausdrücklich nur für diesen Test. Domain, TLS (Caddy-Profil), Portfreigabe — eigener Prompt `docs/prompt-launch-public-server.md`.
- **Blitzer-Flag** bleibt aus, bis die rechtliche Prüfung (`docs/concept.md` Abschnitt 8) erfolgt ist.
- **Skalierung der Statikdaten:** Ein Bayern-Vollstand ist 195 MB im Snapshot und 25–100 MB pro Partition; für Mobilgeräte ist die H3-Auflösung 2 zu grob, und das Manifest sollte nicht bei jedem Aufruf 6 s rechnen. Der Server hat außerdem keine Deduplizierung beim Bulk-Import (nur das Ingestion-Tool schützt davor).
- **Föderation:** Knotenübergreifende Meldungs-ID (`federationEventId`) fehlt in der API (Bestätigungen sind pro Knoten); Statikdaten werden nicht repliziert (jeder Knoten braucht eine eigene Ingestion oder ein Paket-Sync); Erkennung „Server hält Daten zurück“ und periodisches Re-Gossip sind laut Protokoll-Spezifikation zurückgestellt.
- **`client-lib`:** Das Testwerkzeug spricht direkt HTTP. Die Sync-Engine der Bibliothek (F-C3) ist fertig, aber ohne Bindings (F-C4, noch nicht begonnen) nicht aus einem Node-/CLI-Werkzeug aufrufbar — die Bibliothek wird hiermit also noch nicht mitgetestet; sobald es ein Binding gibt, sollte das Werkzeug darauf umgestellt werden.
- **Betrieb:** Backup-Strategie (`pg_dump`), Monitoring/Alarm, Ratenbegrenzung hinter einem Reverse Proxy (die Limits von `/v1/auth/token` und `/v1/devices/register` sind pro IP, und im Server-Code ist kein `trustProxy` gesetzt — hinter Caddy/Apache/nginx sähen alle Clients dieselbe Proxy-Adresse und teilten sich 10 Anfragen pro Minute), Sicherung der `.ingestion-state`.
- **Dieser PC:** `C:` fast voll (siehe oben); Docker Desktop 4.91 startet nach unsauberem Herunterfahren nicht zuverlässig (bekannter AF_UNIX-Bug, Umgehung: `tools/start-docker-desktop.ps1`); Norton 360 durchleuchtet HTTPS und braucht für Docker-Builds/`npm` das eigene Root-Zertifikat als zusätzlichen Vertrauensanker (nur lokal, nicht im Repo).

## Wiederholen

```powershell
# Docker starten (behebt den bekannten Startfehler)
powershell -ExecutionPolicy Bypass -File tools\start-docker-desktop.ps1
# Server (aus dem Worktree mit server/, .env und local-secrets/): ein Knoten
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
# zwei Knoten
docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.federation.yml up -d
# Befüllung (Image aus tools/ingest-runner, siehe Dockerfile-Kopf), Fortschritt liegt im Zustandsordner
# Testwerkzeug
cd tools\test-client; npm install; node src\cli.mjs serve
```
