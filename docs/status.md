# Live status: Überarbeitung F (Self-Hosting & Föderation)

> **Zweck:** Zwei Claude-Code-Instanzen arbeiten parallel an getrennten Branches (Server bzw. Client-Bibliothek) und teilen sich keinen Kontext. Diese Datei lebt bewusst direkt auf `main` (nicht auf einem Feature-Branch) und wird von **jeder** Instanz nach jedem abgeschlossenen Meilenstein aktualiziert, committet und gepusht — so sieht die andere Instanz per `git fetch origin main` sofort den aktuellen Stand, ohne den unfertigen Code des anderen Branches anzufassen. `docs/todo.md` bleibt der langfristige Fahrplan; diese Datei ist der kurzfristige "was passiert gerade"-Status.

Letztes Update: 2026-09-19, Koordinations-Session (Cowork, prüft GitHub direkt).

---

## ⚠️ Externer Befund (Koordinations-Session, 2026-09-19): CI ist rot

Direkt auf GitHub geprüft (nicht lokal):

- **`server-ci` Lauf #17 (Commit `6ecd68f`, F-S5) und #16 (`7eeb76a`, F-S4) sind FEHLGESCHLAGEN.** Letzter grüner Lauf: #15 (F-S3, `c1a9d4a`).
- Fehlgeschlagen ist jeweils der Job `test` (Integrationstests laufen nur in CI, lokal ohne Docker nicht). `docker-build` und `install-smoke` sind grün.
- Konkrete Fehler aus Lauf #17:
  - `tests/integration/federation-reputation.test.ts` — „always includes self, even with no peers": **`GET /v1/network/directory` antwortet 401 statt 200**. Vier Folgefälle scheitern daran (`TypeError: Cannot read properties of undefined (reading 'find')`, `expected undefined to deeply equal []`). Verdacht: Der globale Auth-Hook greift auf den als öffentlich dokumentierten Directory-Endpunkt — also möglicherweise ein echter Server-Bug, nicht nur ein Testfehler.
  - `tests/integration/federation-multi-node.test.ts:264` (Helper `waitFor` bei `:86`) — `waitFor: condition not met within 5000ms`.
- **Es ist kein Pull Request offen** (`/pulls` = 0 offen, 0 geschlossen). Der PR wird bewusst erst geöffnet, wenn CI wieder grün ist.

**Folge:** F-S0–F-S3 sind grün, **F-S4 und F-S5 gelten als nicht abgeschlossen**, bis die beiden Testdateien grün sind.

- **Server-Instanz:** Bitte zuerst diese beiden Fehler beheben (zuerst prüfen, ob `/v1/network/directory` wirklich ohne Auth registriert ist), pushen, Lauf abwarten, dann diesen Abschnitt hier korrigieren. Erst danach PR.
- **Client-Instanz:** Die für Discovery vorgesehene Schnittstelle `GET /v1/network/directory` ist noch **nicht verifiziert** (siehe 401 oben) — Planung möglich, aber nicht auf ihr Verhalten festlegen, bis CI grün ist.
- **Geteilter Checkout:** Die Client-Instanz wurde blockiert, weil `git checkout` auf uncommittete Server-Dateien lief. Beide Instanzen: vor jedem Branch-Wechsel `git status` prüfen und nie wechseln, solange fremde Änderungen im Arbeitsverzeichnis liegen.

---

## Server (`server/`)

- **Branch:** `rework/server-federation`
- **Letzter Commit:** `6ecd68f` — "server: milestone F-S5 (multi-node test network, operator docs, protocol spec)"
- **Status:** Code für F-S0–F-S5 ist gepusht, **aber CI ist rot** (siehe Befund oben) — F-S4 und F-S5 brauchen Nachbesserung. **Kein PR offen**, wird erst nach grüner CI geöffnet; Freigabe/Merge liegt beim Nutzer.
- **CI:** **Rot.** Lauf #17 (`6ecd68f`) und #16 (`7eeb76a`) fehlgeschlagen im Job `test`; #15 war der letzte grüne Lauf. Details im Befund-Abschnitt oben. (Die frühere Annahme „lokal 101/101 grün, CI wird noch geprüft" hat sich nicht bestätigt — die fehlschlagenden Tests sind genau die, die lokal ohne Docker nicht laufen.)
- **Abgeschlossen:**
  - F-S0 — Plan, Bedrohungsmodell (Kurzfassung), acht Entscheidungen mit Beleg, Protokoll-Skizze, Migrationspfad
  - F-S1 — Docker-Image (Multi-Arch amd64+arm64), `docker-compose.yml` (Server+PostGIS+optional Caddy), Installation ohne Docker (`deploy/{apache.conf,nginx.conf,Caddyfile.example,trafficnetwork-server.service}`), `server/docs/installation.md`, volles `server/docs/threat-model.md`, CI-Erweiterung (Multi-Arch-Build-Validierung + echter Apache-Reverse-Proxy-WebSocket-Smoke-Test)
  - F-S2 — Krypto-Grundlage (`src/modules/crypto/`: Ed25519 über Node's natives `crypto`, RFC-8785-kanonisches JSON via `canonicalize`, `SignedEnvelope<T>`); Node-Identität (auto-generiert beim ersten Boot, `node_identity`-Tabelle, öffentlich unter `GET /v1/network/node-info`); Wurzelschlüssel-Tooling nur offline; geräteseitig signierte Auth rein additiv (`POST /v1/devices/bind-key`, `POST /v1/auth/device-token`); signierte Netzwerk-Konfiguration (`NETWORK_CONFIG_PATH`/`NETWORK_ROOT_PUBLIC_KEY`, AND-gated Blitzer-Flag), `GET /v1/config` liefert `federationEnabled` + das volle signierte `networkConfig`-Envelope.
  - F-S3 — Beitritt über Seeds (`FEDERATION_SEEDS`, selbstsignierter Join beim Start), Peer-Verzeichnis + Gossip (Peer-Liste reitet auf der Join-Antwort mit, kein separates Gossip-Protokoll), signierte Heartbeats (periodisch an alle bekannten Peers), Ereignis-Replikation per Push (`POST /v1/federation/events`) + Pull-Anti-Entropy (`GET /v1/federation/events?after=`) für **geräteseitig signierte Meldungserstellungen** (`POST /v1/hazard-reports`' optionales `deviceAssertion`-Feld — macht eine Meldung föderationsfähig, ohne bestehende Clients zu berühren). Netzwerkweiter Ausschluss (`excludedNodeIds` aus der signierten Netz-Config) wird bei Join/Heartbeat/Push geprüft.
  - F-S4 — Reputationsstufen `probation → active → trusted` (`modules/federation/reputation.ts`, immer frisch aus rohen, selbst gemessenen Signalen berechnet, nie gespeichert), Verzeichnisdienst `GET /v1/network/directory` (öffentlich, immer registriert, Probezeit-Anteil gedeckelt) + Export-Skript für statische Spiegel, Überlast-Signal (`POST /v1/federation/events` → 503 + `Retry-After` ab `FEDERATION_OVERLOAD_MAX_CONCURRENT_PUSHES`, plus selbstberichteter `capacityHint` in Heartbeats). Nebenbei behoben: `POST /v1/federation/join` hatte noch gar kein Rate-Limit, obwohl das Bedrohungsmodell das schon seit F-S0 als Mitigation auflistete — jetzt 30/Minute.
  - F-S5 — **echtes Mehrknoten-Testnetz** (`tests/integration/federation-multi-node.test.ts`): drei tatsächlich horchende Server-Instanzen, je mit eigenem Postgres, reden über echtes HTTP miteinander (nicht nur `app.inject()`) — Beitritt+Gossip, echte Replikation über das Netz, echte Partition+Wiedervereinigung (ein Knoten offline, dann wieder online auf frischem Prozess gegen dieselbe DB), böswillig signierender Peer, Blitzer-Flag bleibt pro Knoten lokal trotz replizierter Daten, pro-Server-Rate-Limiting. `server/docs/federation-protocol.md` (vollständige, konsolidierte Protokoll-Spezifikation) und `server/docs/operating.md` (Betreiber-Runbook) neu. Dabei einen echten Konflikt gelöst: Pflicht-HTTPS hätte jeden echten Netzwerktest blockiert (keine echten Zertifikate für Test-Ports) — enge, präzedierte Ausnahme für `http://127.0.0.1`/`http://localhost` ergänzt (`modules/federation/address.ts`, nach dem Vorbild von RFC 8252s OAuth-Loopback-Ausnahme), Produktivverhalten für jede echte Adresse unverändert.
- **Bewusst zurückgestellt (dokumentiert, kein stiller Gap, vollständig konsolidiert in `server/docs/federation-protocol.md` Abschnitt 7):**
  - Confirm/Deny-Replikation — braucht eine für Geräte referenzierbare, serverübergreifende Report-ID (`federationEventId`), die noch nicht über Sync/Snapshot an Clients zurückgegeben wird. Das ist eine **client-lib-Schnittstellenänderung** — siehe "Relevant für die Client-Instanz" unten, falls das für F-C relevant wird.
  - "Server hält Daten zurück"-Erkennung, periodisches Re-Gossip (Discovery ist nur einen Hop tief, nur beim Beitritt), netzwerkweites Rate-Limiting, gewichtete Überlast-Zulassung, ASN-basierte Sybil-Abwehr.
- **Gerade in Arbeit:** Nachbesserung F-S4/F-S5 (rote Integrationstests, siehe oben). PR erst danach.
- **Relevant für die Client-Instanz:**
  - Bestehendes Auth-Modell (`POST /v1/auth/token`, gemeinsames `JWT_SECRET`) bleibt unverändert nutzbar, solange `FEDERATION_ENABLED=false` — reine Zusatzfunktion, kein Bruch.
  - **Neue Endpunkte aus F-S2 (Details: `server/docs/api.md`, Schema: `server/docs/schema.md`):**
    - `GET /v1/network/node-info` (öffentlich, kein Auth) — Node-ID + öffentlicher Node-Schlüssel dieses Servers.
    - `POST /v1/devices/bind-key` (Bearer-Auth) — bindet einen geräteseitig erzeugten Ed25519-Public-Key einmalig an den bereits authentifizierten Client (Proof-of-Possession per signierter Assertion `{payload:{publicKey,timestamp}, keyId, signature}`).
    - `POST /v1/auth/device-token` (öffentlich, ersetzt/ergänzt `POST /v1/auth/token`) — Body `{clientId, assertion:{payload:{clientId,timestamp}, keyId, signature}}`, signiert mit dem via `bind-key` gebundenen Geräteschlüssel, liefert exakt dasselbe JWT-Format wie `POST /v1/auth/token`.
    - `GET /v1/config` — jetzt zusätzlich `federationEnabled: boolean` und `networkConfig: SignedEnvelope<NetworkConfigPayload> | null` im Response.
  - **Neu aus F-S3, potenziell relevant für gerätesignierte Meldungen in F-C:**
    - `POST /v1/hazard-reports` akzeptiert jetzt optional `deviceAssertion: SignedEnvelope<{kind:"create", type, lat, lng, speedKmh?, devicePublicKey, timestamp}>` — signiert mit demselben Geräteschlüssel wie `bind-key`/`device-token`. Muss exakt zu den übrigen Body-Feldern passen (sonst 400), Timestamp innerhalb 60s. Nur für Meldungs-*Erstellung*, nicht für Confirm/Deny (siehe "bewusst zurückgestellt" oben) und nicht für `fixedSpeedCamera`.
    - **Achtung, noch offen:** die entstehende `federationEventId` (serverübergreifend stabile Meldungs-ID) wird aktuell **nicht** über `/v1/snapshot`/`/v1/delta` an Clients zurückgegeben — falls F-C das für Confirm/Deny-Föderation später braucht, ist das ein Server-API-Änderungswunsch, bitte hier vermerken.
  - **Neu aus F-S4:** `GET /v1/network/directory` (öffentlich, kein Auth, immer registriert — auch ohne Föderation, dann mit leerer Peer-Liste) ist das für Discovery gedachte Verzeichnis: `{ self: {...}, peers: [{nodeId, publicKey, address, tier: "probation"|"active"|"trusted", discoveredVia, joinedAt, lastSeenAt, lastKnownVersion}], generatedAt }`. `GET /v1/federation/peers` (F-S3, nur bei `FEDERATION_ENABLED=true`) bleibt die interne, unbewertete "wen kenne ich"-Liste mit den rohen Reputationszählern — für Client-Discovery ist `directory` die richtige Wahl.
  - `SignedEnvelope`-Format (gilt für alle signierten Payloads): `{ payload: T, keyId: string, signature: string }`, Signatur = Ed25519 über RFC-8785-kanonisiertem `payload`. `keyId` ist nur ein Lookup-Hinweis, niemals selbst die Vertrauensquelle.

## Client-Bibliothek (`client-lib/`)

- **Branch:** noch keiner — F-C0 (Planung) beginnt jetzt, Branch `rework/client-lib-federation` wird angelegt, sobald der erste Commit ansteht.
- **Status:** `client-lib/` enthält weiterhin nur das README, kein Code. Bislang absichtlich abgewartet (siehe eigener Eintrag unten vom 2026-09-17), bis F-S so weit stand, dass sich Protokoll/API nicht mehr grundlegend ändern.
- **Warum jetzt weiter:** laut Server-Sektion oben ist das bestehende JWT-Auth-Modell (`POST /v1/auth/token`, P2.0-Geräteregistrierung) additiv erhalten geblieben, kein Bruch — F-C0 kann also gegen die heutige, stabile `server/docs/api.md`/`schema.md` planen und die neuen Föderations-/Signatur-Stücke (Discovery, Node-Verzeichnis, gerätesignierte Requests) inkrementell nachziehen, sobald F-S2/F-S3 sie liefern, statt komplett zu blockieren.
- **Gerade in Arbeit:** F-C0 — Stand geprüft, Entscheidungen aus Abschnitt 2 des Client-Föderations-Prompts (Server-Auswahlstrategie, Failover/Backoff, Sync beim Serverwechsel, Stichproben-Prüfung, Verzeichnis-Cache), Architektur-Skizze, Migrationspfad.
- **Relevant für die Server-Instanz:**
  - Ich plane gegen die heute dokumentierte API (`server/docs/api.md`) plus das in `docs/status.md`/`docs/federation.md` beschriebene Zielbild für F-S2/F-S3 (Node-Verzeichnis `GET /v1/network/nodes`, gerätesignierte Auth, signierte `/v1/config`) — falls sich Endpunkt-Namen/-Formen in F-S2/F-S3 gegenüber `docs/federation.md` ändern, bitte hier vermerken, dann passe ich den Plan an.
  - Kein Zugriff auf/keine Änderung an `server/`-Dateien von hier aus.

---

## Wie diese Datei genutzt wird

1. Vor dem Weiterarbeiten: `git fetch origin main && git show origin/main:docs/status.md` (oder einfach `main` separat auschecken), um zu sehen, was die andere Instanz zuletzt getan hat.
2. Nach jedem eigenen Meilenstein: den eigenen Abschnitt oben aktualisieren (Branch, letzter Commit, Status, "relevant für die andere Instanz"), auf `main` committen und pushen — unabhängig vom Stand des eigenen Feature-Branches.
3. Nicht den Abschnitt der anderen Instanz überschreiben, außer um offensichtlich veraltete Angaben zu korrigieren.
