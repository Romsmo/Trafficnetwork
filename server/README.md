# server

Relay-/Moderator-Server: Ereignisprotokoll, materialisierter Zustand (PostGIS), Snapshot-/Delta-API, Moderationsgate, Blitzer-Namensraum (standardmäßig deaktiviert), Client-Credential-Auth, Bulk-Import, WebSocket-Push.

**Status**: Phase 1 abgeschlossen (P1.0–P1.5). Meilenstein P2.0 (Server-Erweiterungen für `client-lib/`: Geräteregistrierung, partitionierte statische Datenpakete, Config-Endpunkt) ebenfalls umgesetzt. API vollständig, dokumentiert (siehe [`docs/api.md`](docs/api.md), [`docs/schema.md`](docs/schema.md)) und getestet. Details zum Architekturkonzept siehe [`docs/concept.md`](../docs/concept.md), [`docs/prompt-phase1-server.md`](../docs/prompt-phase1-server.md) und [`docs/prompt-phase2-client-lib.md`](../docs/prompt-phase2-client-lib.md).

`client-lib/` (P2.1+) kann beginnen.

**Überarbeitung F-Server (Branch `rework/server-federation`) abgeschlossen:** Self-Hosting per Docker oder ohne Docker (Apache/nginx/Caddy) und Föderation mehrerer Server (offene Mitgliedschaft mit Reputation, signierte Daten, Server-Verzeichnis). Konzept: [`docs/federation.md`](../docs/federation.md), Auftrag: [`docs/prompt-rework-server-federation.md`](../docs/prompt-rework-server-federation.md), Bedrohungsmodell: [`docs/threat-model.md`](docs/threat-model.md), vollständige Protokollspezifikation: [`docs/federation-protocol.md`](docs/federation-protocol.md). **F-S0–F-S5 sind umgesetzt** — Installation: [`docs/installation.md`](docs/installation.md), Betrieb: [`docs/operating.md`](docs/operating.md). Das bestehende Auth-Modell (gemeinsames `JWT_SECRET`) bleibt vollständig erhalten — geräteseitig signierte Auth ist eine rein additive Alternative (Migrationspfad im Plan). Neon bleibt als DB-Option vollständig unterstützt, PostgreSQL+PostGIS im Compose-Stack ist der Standardpfad für neue Selbsthoster. Laufender Cross-Instanz-Status (parallel arbeitende Client-Bibliothek-Instanz): [`docs/status.md`](../docs/status.md).

## Tech-Stack

Node.js + TypeScript + [Fastify](https://fastify.dev/) + [Drizzle ORM](https://orm.drizzle.team/) gegen Postgres/PostGIS (empfohlen: [Neon](https://neon.com/)). WebSocket-Push über [`@fastify/websocket`](https://github.com/fastify/fastify-websocket), Auth über clientseitige JWTs ([`jose`](https://github.com/panva/jose)). Begründung der Plattform-/Protokoll-/Tiling-Entscheidungen: siehe Plan-Dokument dieser Session bzw. `docs/prompt-phase1-server.md` Abschnitt 2.

## Setup (lokale Entwicklung)

```bash
npm install
cp .env.example .env
# .env ausfüllen: DATABASE_URL (Neon-Connection-String), JWT_SECRET
npm run db:migrate
npm run create-client -- --name "mein-erster-client" --scope client
npm run dev
```

`GET /v1/health` prüft Erreichbarkeit der Datenbank (kein Auth nötig). Jeder andere `/v1/*`-Endpunkt braucht einen Bearer-Token — siehe [`docs/api.md`](docs/api.md) Abschnitt "Auth".

## Selbst hosten (Docker oder ohne Docker)

Vollständige Anleitung: [`docs/installation.md`](docs/installation.md). Kurzfassung:

```bash
cp .env.example .env   # POSTGRES_PASSWORD + JWT_SECRET setzen
docker compose up -d
```

Startet Server + PostgreSQL/PostGIS in einem Stack, Migrationen laufen automatisch beim Start (siehe `Dockerfile`). Multi-Arch-Image (amd64 + arm64, per CI validiert — läuft also auch auf Raspberry Pi/ARM-VPS). Reverse-Proxy-Beispiele für Apache (inkl. `mod_proxy_wstunnel` für `/v1/ws`), nginx und Caddy liegen in [`deploy/`](deploy/) — auch für die Installation ohne Docker (Node.js + eigenes PostgreSQL+PostGIS, systemd-Unit in `deploy/trafficnetwork-server.service`).

## Umgebungsvariablen

Siehe [`.env.example`](.env.example) — alle Werte sind dokumentiert und haben sinnvolle Defaults, insbesondere:

- `SPEED_CAMERA_NAMESPACE_ENABLED` — globaler Kill-Switch für den Blitzer-Namensraum, **muss** `false` bleiben, bis der Betreiber nach rechtlicher Prüfung (§23 Abs. 1b StVO, siehe `docs/concept.md` Abschnitt 8) grünes Licht gibt.
- `EVENT_LOG_RETENTION_DAYS_DYNAMIC` / `_STATIC` — Aufbewahrungsfenster für das Ereignisprotokoll, durchgesetzt vom stündlichen Cleanup-Job (`modules/expiry/retention.ts`).
- Moderationsgate-Parameter (`REPORT_RATE_LIMIT_*`, `DUPLICATE_MERGE_RADIUS_METERS`, `SPEED_KMH_*`, `CAMERA_REMOVAL_THRESHOLD`).
- `JWT_SECRET` / `JWT_TTL_SECONDS` — Signierschlüssel und Gültigkeitsdauer für Client-Tokens.
- `STATIC_DATA_PARTITION_H3_RESOLUTION` / `DEVICE_REGISTRATION_RATE_LIMIT_MAX_PER_DAY` — client-lib-P2.0-Tuning (Paket-Kachelgröße bzw. Geräteregistrierungen pro App-Schlüssel und Tag).
- `FEDERATION_ENABLED` / `NETWORK_ROOT_PUBLIC_KEY` / `NETWORK_CONFIG_PATH` — Föderation (F-S2), siehe "Network keys & signed config" unten.
- `FEDERATION_PUBLIC_ADDRESS` / `FEDERATION_SEEDS` / `FEDERATION_HEARTBEAT_INTERVAL_SECONDS` / `FEDERATION_ANTI_ENTROPY_INTERVAL_SECONDS` / `FEDERATION_EVENT_MAX_AGE_HOURS` / `FEDERATION_PEER_TIMEOUT_MS` — Föderationsprotokoll (F-S3), siehe "Föderation: Beitritt, Peers, Replikation" unten.
- `COMMUNITY_CORRECTIONS_ENABLED` / `COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED` / `COMMUNITY_CORRECTIONS_KMH_MIN` / `_KMH_MAX` / `_MPH_MIN` / `_MPH_MAX` / `_VALUE_STEP` / `COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX` / `_WINDOW_MINUTES` — Community-Korrekturen falscher Tempolimits (Zusatz K-A): Schalter, Schwellwert (Standard 3 verschiedene Geräte), Plausibilitätsbereich je Einheit und eigenes, strengeres Limit pro Gerät. Siehe "Community-Korrekturen von Tempolimits" unten.
- `REPUTATION_PROBATION_MIN_HOURS` / `REPUTATION_MIN_SUCCESSFUL_HEALTH_CHECKS` / `REPUTATION_TRUSTED_MIN_HOURS` / `REPUTATION_TRUSTED_MIN_SUCCESSFUL_HEALTH_CHECKS` / `REPUTATION_DEMOTE_AFTER_CONSECUTIVE_FAILURES` / `REPUTATION_DIRECTORY_PROBATION_MAX_SHARE` / `FEDERATION_OVERLOAD_MAX_CONCURRENT_PUSHES` — Reputation & Überlast-Signal (F-S4), siehe "Reputation, Verzeichnis & Überlast-Signal" unten.
- `ONLINE_COUNTER_ENABLED` / `ONLINE_WINDOW_SECONDS` / `ONLINE_MIN_DISPLAY_THRESHOLD` / `ONLINE_CACHE_SECONDS` / `ONLINE_PEER_STALE_SECONDS` / `ONLINE_MAX_TRACKED` — Anzeige "aktuell online" (Zusatz O-A), siehe "Aktuell online" unten.

## Network keys & signed config (F-S2)

Jeder Server erzeugt beim ersten Start automatisch seinen eigenen **Node-Schlüssel** (Ed25519, in der DB gespeichert, siehe `docs/schema.md`s `node_identity`-Tabelle) — keine Aktion nötig, öffentlich einsehbar über `GET /v1/network/node-info`.

Der **Netzwerk-Wurzelschlüssel** ist etwas anderes: er gehört dem Projektinhaber, wird **offline** erzeugt und darf nie einen laufenden Server berühren (siehe `docs/threat-model.md`). Werkzeuge dafür:

```bash
npm run network:generate-root-key -- --out ./network-root-key.json
# Datei SOFORT an einen sicheren Offline-Ort verschieben, dann von diesem Rechner löschen.

npm run network:sign-config -- --root-key ./network-root-key.json --out ./network-config.json \
  --blitzer-enabled false --retention-dynamic-days 3 --retention-static-days 30
```

Die signierte `network-config.json` wird verteilt; jeder Server, der sie einbinden soll, bekommt `NETWORK_CONFIG_PATH` (Pfad zur Datei) und `NETWORK_ROOT_PUBLIC_KEY` (der öffentliche Wurzelschlüssel, von `network:generate-root-key` ausgegeben) gesetzt. Der Server verweigert den Start, wenn die Datei fehlt, unlesbar ist oder nicht gegen den konfigurierten Schlüssel verifiziert — nie ein unauthentifiziertes Konfigurationsdokument stillschweigend übernehmen. Das Blitzer-Flag ist **UND-verknüpft**: die Netzwerk-Konfiguration kann ein lokal aktiviertes Flag abschalten, aber nie ein lokal deaktiviertes einschalten (siehe `docs/api.md`).

## Föderation: Beitritt, Peers, Replikation (F-S3)

Nur relevant, wenn `FEDERATION_ENABLED=true` — mit dem Standardwert `false` existieren die `/v1/federation/*`-Endpunkte gar nicht erst (404), exakt wie vor diesem Meilenstein. Volle Endpunkt-Referenz: [`docs/api.md`](docs/api.md#federation-f-s3); Sicherheitsmodell/bewusst zurückgestellte Stücke (Confirm/Deny-Replikation): [`docs/threat-model.md`](docs/threat-model.md#f-s3-implementation-notes).

```bash
FEDERATION_ENABLED=true
FEDERATION_PUBLIC_ADDRESS=https://mein-server.example   # Pflicht, sobald FEDERATION_ENABLED=true
FEDERATION_SEEDS=https://seed1.example,https://seed2.example   # optional — der erste Server im Netz hat keinen Seed
```

Mit gesetztem `FEDERATION_SEEDS` tritt der Server beim Start jedem Seed bei (selbstsigniert mit dem eigenen, automatisch erzeugten Node-Schlüssel — siehe "Network keys" oben) und übernimmt dessen aktuelle Peer-Liste (Gossip reitet auf der Beitritts-Antwort mit, kein separates Gossip-Protokoll). Danach laufen zwei Hintergrund-Jobs (wie Expiry-Sweep/Retention-Cleanup): signierte Heartbeats an alle bekannten Peers (`FEDERATION_HEARTBEAT_INTERVAL_SECONDS`, Standard 60s) und Anti-Entropy-Pull (`FEDERATION_ANTI_ENTROPY_INTERVAL_SECONDS`, Standard 300s) — schließt Lücken, falls ein Push verpasst wurde.

Repliziert werden aktuell **nur geräteseitig signierte Meldungserstellungen** (`POST /v1/hazard-reports`' optionales `deviceAssertion`-Feld, siehe `docs/api.md`) — Confirm/Deny-Replikation ist bewusst zurückgestellt (siehe Bedrohungsmodell-Link oben). Ein nicht-föderierender Betreiber merkt von alldem nichts: `FEDERATION_ENABLED=false` ist exakt das Verhalten von vor diesem Meilenstein.

## Reputation, Verzeichnis & Überlast-Signal (F-S4)

**Reputation** (`modules/federation/reputation.ts`) läuft in drei Stufen — `probation` → `active` → `trusted` — und wird bei jeder Anfrage frisch aus rohen Signalen berechnet, nie als eigener Wert gespeichert. Die Signale kommen ausschließlich aus diesem Server selbst gemessenen aktiven Prüfungen (Heartbeat-Versand, Anti-Entropy-Pull) und beobachtetem Verhalten (ungültige Signaturen in einem Push) — nie aus Selbstauskünften eines Peers. Eine ungültige Signatur stuft sofort auf `probation` zurück, unabhängig vom bisherigen Stand. Schwellenwerte: `REPUTATION_PROBATION_MIN_HOURS`/`REPUTATION_MIN_SUCCESSFUL_HEALTH_CHECKS` (Aufstieg zu `active`), `REPUTATION_TRUSTED_MIN_HOURS`/`REPUTATION_TRUSTED_MIN_SUCCESSFUL_HEALTH_CHECKS` (Aufstieg zu `trusted`), `REPUTATION_DEMOTE_AFTER_CONSECUTIVE_FAILURES` (Rückstufung). Netzwerkweiter Ausschluss bleibt davon unberührt — der ist und bleibt wurzelschlüssel-gebunden (`excludedNodeIds` in der signierten Netz-Config, siehe oben); lokale Reputation kann nur zurückstufen, nie einen Peer entfernen oder netzwerkweit sperren.

**Verzeichnis**: `GET /v1/network/directory` (öffentlich, immer registriert — auch ohne Föderation, dann mit leerer Peer-Liste) liefert die eigene Selbstauskunft plus die bewertete Peer-Liste. Probezeit-Peers sind auf `REPUTATION_DIRECTORY_PROBATION_MAX_SHARE` (Standard 50 %) der zurückgegebenen Liste gedeckelt. Als statische Datei exportierbar (für Spiegel, z. B. GitHub Pages):

```bash
npm run network:export-directory -- --url https://mein-server.example --out ./directory.json
```

**Überlast-Signal**: `POST /v1/federation/events` liefert `503` + `Retry-After`, sobald `FEDERATION_OVERLOAD_MAX_CONCURRENT_PUSHES` gleichzeitig verarbeitete Pushes erreicht sind — eine Nebenläufigkeits-Bremse, kein Ersatz für den bestehenden IP-basierten Rate-Limit auf derselben Route. Der Heartbeat-Versand trägt zusätzlich einen selbstberichteten `capacityHint` (0–1), damit sich wohlverhaltende Peers proaktiv zurückhalten können — für die eigene Reputationsberechnung wird dieser Wert aber nie vertraut (siehe `docs/threat-model.md`).

## Community-Korrekturen von Tempolimits (Zusatz K-A)

Nutzer können ein falsches Tempolimit melden und einen Wert vorschlagen. Die Korrektur ist ein **Overlay**: Die importierte Zeile wird nie verändert, der wirksame Wert wird beim Lesen aus Import + aktiver Korrektur bestimmt (`speedLimit` in allen bestehenden Antworten ist bereits der wirksame Wert; zusätzlich `correctedBy: "community"`, `importedSpeedLimit`, `correction` mit Bestätigungen/Datum/`needsReview`). Wirksam wird sie erst, wenn `COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED` (Standard **3**) *verschiedene Geräte* übereinstimmen — ein Widerspruch zählt dagegen. Verteilung über Ereignisprotokoll, Snapshot, versionierte Pakete und (gerätesigniert, deterministisch zusammengeführt) über die Föderation.

- Endpunkte: `POST /v1/speed-limit-segments/:id/corrections`, `POST /v1/speed-limit-corrections/:id/confirmations`, `GET /v1/speed-limit-corrections` — siehe [`docs/api.md`](docs/api.md).
- Entwurf und Begründung jeder Entscheidung (Schwelle, Gleichstand, Einheit, „zu prüfen" nach Importänderung, Föderation): [`docs/speed-limit-corrections.md`](docs/speed-limit-corrections.md).
- Betreiber: `npm run corrections -- list | show | reset | restore | ban | unban | orphans` (Zurücksetzen mit **einem Befehl**: `reset --all`), Funktion abschalten mit `COMMUNITY_CORRECTIONS_ENABLED=false` — siehe [`docs/operating.md`](docs/operating.md).
- **Upgrade-Hinweis:** Migration 0007 schreibt die Tabelle `speed_limit_segments` einmalig um (neue berechnete Spalte `geometry_key`), ca. 20 s pro Million Segmente unter exklusivem Lock — vor dem Start des neuen Servers ausführen. Auf einem Knoten mit Nutzern und großem Datenbestand braucht das ein **Wartungsfenster** (Begründung, warum es keine Online-Variante gibt, und die Regeln für künftige Migrationen: [`docs/operating.md`](docs/operating.md), „Migrations that take a heavy lock"); der Migrationsschritt warnt vorher mit Tabelle und Zeilenzahl.

## Europa-Maßstab: vorgebaute Pakete, Limits, Messung (Zusatz E-B)

Statische Daten werden nicht mehr pro Anfrage berechnet, sondern als **vorab erzeugte, komprimierte, inhaltsadressierte Dateien** (`STATIC_PACKAGES_DIR`, in Docker ein Volume) ausgeliefert — `ETag`/304, brotli/gzip, `Range` (Download fortsetzen), unveränderliche URL `…/packages/<tile>/<hash>` (optional öffentlich für CDN: `STATIC_PACKAGES_PUBLIC`). Der Bau streamt Kachel für Kachel (Speicher unabhängig von der Datenmenge), baut nach Änderungen nur die betroffenen Kacheln neu (Worker mit Ruhezeit, Lease, fortsetzbar); Bulk-Import ist ein Batch-Statement pro Aufruf und schreibt weiterhin **keine** Ereignisprotokoll-Zeilen; `GET /v1/snapshot` lehnt zu große Datenmengen mit 413 ab.

- Betreiber: `npm run static-packages -- status | build [--full] | verify`, `npm run measure-scale`, Standard `STATIC_DATA_PARTITION_H3_RESOLUTION=4` (gleich auf allen Knoten eines Netzes; im Manifest als `partitionResolution`) — siehe [`docs/operating.md`](docs/operating.md) ("Running a node with Europe-sized data").
- Entwurf, Messwerte und was noch auf den echten Daten nachzumessen ist: [`docs/europe-scale.md`](docs/europe-scale.md).

## Dauerhafte Überwachungsanlagen: Rotlicht und Abstand (Zusatz D)

Die Tabelle `fixed_speed_cameras` (Name bleibt) hält jetzt **jede fest installierte Anlage**: die Spalte `camera_type` sagt, ob es ein Blitzer (`fixedSpeedCamera`), eine Rotlichtanlage (`redLightCamera`) oder eine Abstandskontrolle (`distanceControl`) ist. Solche Anlagen verfallen nie und verschwinden nur durch Entfernen-Meldungen; mobile Anlagen und — standardmäßig — Nutzermeldungen von Rotlicht/Abstand bleiben **verfallende** Meldungen. Alles ist hinter `SPEED_CAMERA_NAMESPACE_ENABLED` wie bisher (Flag aus: nichts wird ausgeliefert, Schreiben und Import gehen weiter).

- Additiv für bestehende Clients: neues Feld `cameraType`, neues Snapshot-Feld `enforcementDevices` (alle Anlagen; `fixedSpeedCameras` bedeutet weiter nur Blitzer), optionaler Paket-Schlüssel `enforcementDevices` (nur in Kacheln mit Anlage), neuer Ereignis-Entitätstyp `enforcementDevice`, `persistentCameraTypes` in `/v1/config`, optionales `cameraType` im Bulk-Import — siehe [`docs/api.md`](docs/api.md) ("Persistent enforcement devices").
- Migration 0009 ist nur ein Katalogeintrag (5 ms bei 1 Mio. Zeilen, kein Wartungsfenster), mit Rückroll-Skript und Test gegen einen Altbestand: [`docs/operating.md`](docs/operating.md). Entwurf und Begründungen: [`docs/persistent-enforcement-devices.md`](docs/persistent-enforcement-devices.md).
- Nicht föderiert (wie feste Blitzer): die Anlagen sind knotenlokale statische Daten; nur die gerätesignierte *Meldung* föderiert, als verfallende Meldung.

## Aktuell online (Zusatz O-A)

`GET /v1/stats/online` (öffentlich, kein Auth) liefert, wie viele Clients gerade an diesem Knoten hängen, plus eine **geschätzte** Summe für das ganze Netz. Als "online" zählt ein Client (einmal, egal wie viele Verbindungen), wenn er eine authentifizierte WebSocket-Verbindung offen hat **oder** innerhalb von `ONLINE_WINDOW_SECONDS` (Standard 5 Minuten) eine erfolgreiche Sync- oder Schreibanfrage gemacht hat — so sind auch reine Polling-Clients sichtbar. Nur Tokens mit Scope `client` zählen, keine Dienst-Zugänge (Bulk-Import, Geräteregistrierung).

```json
{ "enabled": true,
  "node":    { "online": 12, "windowSeconds": 300 },
  "network": { "online": 87, "nodes": 4, "estimated": true, "asOf": "2026-09-24T12:00:00.000Z" },
  "minDisplayThreshold": 5 }
```

- **Nur Zahlen, keine Personen:** gezählt wird im Arbeitsspeicher (gesalzener Hash der Token-Kennung, Salz pro Prozess zufällig); keine IP-Adresse, keine Position, keine Datenbank, keine Logzeile. Neustart setzt den Zähler zurück.
- **Schwellenwert:** unter `ONLINE_MIN_DISPLAY_THRESHOLD` (Standard 5) steht `{ "online": null, "below": 5 }` ("weniger als 5") statt der genauen Zahl — für den Knoten und für das Netz getrennt.
- **Netzweite Summe:** jeder Knoten trägt seine eigene Zahl als `onlineCount` in den ohnehin gesendeten signierten Heartbeats mit. Die Summe zählt nur Peers, die im eigenen Reputationsblick `active`/`trusted` sind (nie Probezeit), nicht ausgeschlossen sind und deren Heartbeat jünger als `ONLINE_PEER_STALE_SECONDS` ist. Fremde Zahlen sind Behauptungen, daher immer `estimated: true`; Einzelwerte von Peers werden nie veröffentlicht. Ohne Föderation entfällt `network`.
- **Abschaltbar:** `ONLINE_COUNTER_ENABLED=false` → Endpunkt antwortet `{ "enabled": false }`, nichts wird gezählt oder in Heartbeats gesendet.
- Zwischengespeichert (`ONLINE_CACHE_SECONDS`, Standard 10 s), Details und Datenschutz-Überlegungen: [`docs/api.md`](docs/api.md#get-v1statsonline-add-on-o-a), [`docs/federation-protocol.md`](docs/federation-protocol.md) (§4.2), [`docs/threat-model.md`](docs/threat-model.md).

## API

Vollständige Referenz: [`docs/api.md`](docs/api.md). Kurzfassung:

- **Auth**: `POST /v1/auth/token` (Client-Credentials → JWT) oder, additiv seit F-S2, `POST /v1/auth/device-token` (geräteseitig signierte Assertion → JWT, für Clients mit gebundenem Ed25519-Schlüssel). Jeder `/v1/*`-Endpunkt außer `/v1/health`, beiden Token-Endpunkten, `/v1/ws`, `/v1/network/{node-info,directory}`, `/v1/stats/online` und den `/v1/federation/*`-Endpunkten (F-S3, nur bei `FEDERATION_ENABLED=true`) braucht `Authorization: Bearer <token>`. `reporterId` kommt bei Schreibzugriffen immer aus dem Token, nie aus dem Body.
- **Lesen**: `GET /v1/speed-limit`, `/v1/speed-limit-segments/nearby`, `/v1/static-signs/nearby`, `/v1/hazard-reports/{nearby,by-tile}`, `/v1/speed-cameras/{nearby,by-tile}` (leer, solange das Blitzer-Flag aus ist), `/v1/snapshot`, `/v1/delta`, `/v1/config`, `/v1/static-data/{manifest,partitions/:tile}`, `/v1/network/node-info`, `/v1/network/directory` und `/v1/stats/online` (alle öffentlich, kein Auth).
- **Schreiben**: `POST /v1/hazard-reports` (läuft durchs Moderationsgate: Plausibilität, Rate-Limit, Duplikat-Merge; `type: "fixedSpeedCamera"` wird in den Blitzer-Namensraum umgeleitet; optionales `deviceAssertion`-Feld seit F-S3 macht die Meldung föderationsfähig), `POST /v1/hazard-reports/:id/confirmations`, `POST /v1/speed-cameras/:id/removal-reports`. Schreibzugriffe auf den Blitzer-Namensraum funktionieren unabhängig vom Flag — nur Lesezugriffe sind gegated.
- **Bulk-Import** (Scope `bulk-import`): `POST /v1/bulk-import/{speed-limit-segments,static-signs,speed-cameras}` (bei `speed-cameras` optional `cameraType`), max. 5000 Zeilen/Aufruf (`BULK_IMPORT_MAX_ROWS`), erzeugt bewusst keine Event-Log-Einträge (Abholung nur über `/v1/snapshot` bzw. die Paket-Endpunkte, siehe `docs/api.md`).
- **Geräteregistrierung** (Scope `device-registration`, client-lib P2.0): `POST /v1/devices/register` — App-Schlüssel → frisches, pseudonymes Geräte-Credential. Additiv seit F-S2: `POST /v1/devices/bind-key` bindet einen selbst erzeugten Ed25519-Schlüssel an die eigene, bestehende Identität (jeder Client, nicht nur `device-registration`).
- **Föderation** (F-S3, nur bei `FEDERATION_ENABLED=true`): `POST /v1/federation/join`, `GET /v1/federation/peers`, `POST /v1/federation/heartbeat`, `POST`/`GET /v1/federation/events` — siehe "Föderation" oben und `docs/api.md`.
- **Realtime**: `GET /v1/ws` (WebSocket) — Auth per erster Nachricht (nicht per Query-String-Token), danach `subscribe`/`unsubscribe` auf H3-Tiles.
- **Web-Sitzungen** (nur mit eingebauter Weboberfläche, `WEB_UI_ENABLED=true`): `POST /v1/web/session` (öffentlich) — anonymes, kurzlebiges Token für die eigene Webseite des Knotens; was es darf, regelt eine feste Allowlist (siehe "Weboberfläche" unten und `docs/api.md`, Abschnitt "Web sessions").

## Weboberfläche

Jeder Knoten liefert unter `/` eine kleine eigene Webseite aus (Quellen in `web/`, Modul `src/modules/web/`): Karte mit aktuellen Meldungen (live), Tempolimit per Klick bzw. als Straßenfarben, Melden und Bestätigen, die Seiten „Verbinden" (App, eigener Knoten, API) und „Über das Projekt" — Deutsch/Englisch, mobil, ohne externe Skripte (nur Kartenkacheln). Sie ist eine reine Ergänzung: `WEB_UI_ENABLED=false` schaltet sie samt `POST /v1/web/session` ab, die `/v1`-API bleibt sonst unverändert. Konfiguration (`WEB_*`, `MAP_TILE_*`, `TRUST_PROXY`, `LOG_PRIVACY_MODE`, `PROJECT_REPO_URL`), Vertrauensmodell, Kartenkacheln, Reverse-Proxy und Datenschutz: [`docs/web-ui.md`](docs/web-ui.md); Datenschutzhinweis (Entwurf, keine Rechtsberatung): [`../docs/privacy.md`](../docs/privacy.md).

## Datenbank / Migrations

Schema liegt in `src/db/schema/`, Migrations werden mit [drizzle-kit](https://orm.drizzle.team/kit-docs/overview) erzeugt:

```bash
npm run db:generate   # neue Migration aus Schema-Änderungen generieren
npm run db:migrate    # ausstehende Migrations gegen DATABASE_URL anwenden
```

Die erste Migration (`0000_enable_postgis.sql`) aktiviert die PostGIS-Extension und muss vor der Schema-Migration laufen — das ist bereits so in der Migrationsreihenfolge hinterlegt. Vollständige Schema-Doku: [`docs/schema.md`](docs/schema.md) (u. a. der Grund, warum alle Geometrie-Spalten einen Custom-Type statt Drizzles eingebauten `geometry()`-Helper nutzen).

## Client-Provisionierung

Kein Admin-HTTP-API in Phase 1 (bewusste Vereinfachung für Einzelbetreiber). Clients werden lokal gegen die DB angelegt:

```bash
npm run create-client -- --name "mein-erster-client" --scope client
npm run create-client -- --name "ingestion-worker" --scope bulk-import
npm run create-client -- --name "meine-app" --scope device-registration
```

Der `device-registration`-Scope provisioniert einen "App-Schlüssel": eine App
tauscht ihn gegen ein JWT und ruft damit `POST /v1/devices/register` auf, um
sich selbst ein frisches, pseudonymes Geräte-Credential auszustellen (siehe
`docs/api.md`) — kein Admin-HTTP-API nötig, da das Gerät sein eigenes
Credential erzeugt, nicht der Betreiber.

Das `clientSecret` wird nur einmal ausgegeben (gehasht gespeichert, siehe `modules/auth/credentials.ts`) — sofort sichern.

## Hintergrund-Jobs

Beide starten automatisch mit dem Server (`src/server.ts`), sauberer Shutdown über `close-with-grace`:

- **Expiry-Sweep** (`modules/expiry/worker.ts`, standardmäßig jede Minute): setzt abgelaufene `hazard_reports` auf `expired`, publiziert `ReportExpired` an WebSocket-Abonnenten.
- **Retention-Cleanup** (`modules/expiry/retention.ts`, standardmäßig stündlich): löscht Event-Log-Einträge außerhalb der Aufbewahrungsfenster sowie länger `expired`/`removed` `hazard_reports`-Zeilen.
- **Föderations-Jobs** (`modules/federation/workers.ts`, nur bei `FEDERATION_ENABLED=true`): Seeds-Beitritt beim Start (einmalig, best-effort), signierte Heartbeats an alle bekannten Peers (Standard alle 60s), Anti-Entropy-Pull pro Peer (Standard alle 300s).

## Tests

```bash
npm run test:unit          # keine Infrastruktur nötig
npm run test:integration   # startet einen postgis/postgis-Container über Testcontainers — braucht lokal Docker
npm test                   # beides
npm run e2e                # Weboberfläche im echten Browser (Playwright/Chromium) gegen echte Knoten + PostGIS — einmalig: npx playwright install chromium
```

Integrationstests laufen automatisch in CI (`.github/workflows/server-ci.yml`, GitHub-Actions-Runner bringt Docker mit). Lokal ohne Docker Desktop lassen sich nur die Unit-Tests ausführen. WebSocket-Tests starten einen echten horchenden Server plus einen echten `ws`-Client (Fastifys `app.inject()` unterstützt kein WS-Upgrade). `tests/integration/federation-multi-node.test.ts` (F-S5) ist die einzige Suite, die mehrere echte, horchende Server-Instanzen (je mit eigenem Postgres-Container) tatsächlich über echtes HTTP miteinander reden lässt, statt jeden Server isoliert über `app.inject()` zu prüfen — Beitritt+Gossip, Replikation, Partition+Wiedervereinigung, ein böswillig signierender Peer und pro-Server-Rate-Limiting werden dort end-to-end durchgespielt.

## Meilensteine

| # | Inhalt | Status |
|---|---|---|
| P1.0 | Plattform-/Transport-/Tiling-/Stack-/API-Stil-Entscheidungen recherchiert und begründet, Plan vorgelegt | ✅ |
| P1.1 | Datenmodell + Migrations, Ereignisprotokoll + materialisierter Zustand | ✅ |
| P1.2 | Snapshot- und Delta-Mechanik, Lese-Endpunkte, Expiry-Sweep-Worker | ✅ |
| P1.3 | Moderationsgate, Schreib-Endpunkte für Hazard-Reports | ✅ |
| P1.4 | Blitzer-Namensraum, separat, standardmäßig deaktiviert | ✅ |
| P1.5 | Auth, Bulk-Import, WebSocket-Push, Retention-Cleanup, API-/Schema-Doku, vollständige Testsuite — **Phase-1-Abschluss** | ✅ |
| P2.0 | client-lib-Server-Erweiterungen: Geräteregistrierung, partitionierte/versionierte statische Datenpakete + Manifest, Config-Endpunkt | ✅ |
| F-S0 | Bedrohungsmodell, Entscheidungen zu Replikation/Transport/Signaturen/Verzeichnis/Subdomains/DB-Anbieter, Protokoll-Skizze, Migrationspfad, Plan vorgelegt | ✅ |
| F-S1 | Docker-Image (Multi-Arch), Compose-Stack, Installation ohne Docker (Apache/nginx/Caddy, systemd), Installations-CI, `docs/threat-model.md` | ✅ |
| F-S2 | Node-/Wurzelschlüssel + CLI, geräteseitig signierte Auth (additiv), signierte Netzwerk-Konfiguration | ✅ |
| F-S3 | Föderation: Beitritt über Seeds, Peer-Verzeichnis + Gossip, signierte Heartbeats, Push/Pull-Replikation geräteseitig signierter Meldungserstellungen | ✅ |
| F-S4 | Reputationsstufen (probation/active/trusted), Verzeichnisdienst (`GET /v1/network/directory`) + Export-Skript, Überlast-Signal (503+Retry-After) | ✅ |
| F-S5 | Mehrknoten-Testnetz (3 echte Server über Testcontainers), Betreiber-Doku (`docs/operating.md`), finale Föderations-Protokollspezifikation (`docs/federation-protocol.md`) — **Abschluss, Pull Request** | ✅ |
| W0–W5 | Weboberfläche des Knotens (Karte, Melden, „Verbinden", „Über das Projekt"), Web-Sitzungen mit Allowlist und Limits, Playwright-E2E-Tests, `docs/web-ui.md` | ✅ |
| O-B | Anzeige „N online" unten rechts (gegen den echten O-A-Endpunkt zu prüfen, sobald beide Branches zusammengeführt sind, siehe `../docs/status.md`) | ✅ |
