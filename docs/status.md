# Live status: Überarbeitung F (Self-Hosting & Föderation)

> **Zweck:** Zwei Claude-Code-Instanzen arbeiten parallel an getrennten Branches (Server bzw. Client-Bibliothek) und teilen sich keinen Kontext. Diese Datei lebt bewusst direkt auf `main` (nicht auf einem Feature-Branch) und wird von **jeder** Instanz nach jedem abgeschlossenen Meilenstein aktualiziert, committet und gepusht — so sieht die andere Instanz per `git fetch origin main` sofort den aktuellen Stand, ohne den unfertigen Code des anderen Branches anzufassen. `docs/todo.md` bleibt der langfristige Fahrplan; diese Datei ist der kurzfristige "was passiert gerade"-Status.

Letztes Update: 2026-09-18, Server-Instanz.

---

## Server (`server/`)

- **Branch:** `rework/server-federation`
- **Letzter Commit:** `7000529` — "server: milestone F-S2 (node/root keys, device-signed auth, signed config)"
- **CI:** Push gerade erfolgt, Ergebnis wird noch geprüft (neue Integrationstests für gerätesignierte Auth + Netzwerk-Konfiguration laufen erstmals gegen echtes Testcontainers-Postgres in CI, lokal ohne Docker nicht ausführbar — nur Unit-Tests lokal verifiziert: 69/69 grün).
- **Abgeschlossen:**
  - F-S0 — Plan, Bedrohungsmodell (Kurzfassung), acht Entscheidungen mit Beleg, Protokoll-Skizze, Migrationspfad
  - F-S1 — Docker-Image (Multi-Arch amd64+arm64), `docker-compose.yml` (Server+PostGIS+optional Caddy), Installation ohne Docker (`deploy/{apache.conf,nginx.conf,Caddyfile.example,trafficnetwork-server.service}`), `server/docs/installation.md`, volles `server/docs/threat-model.md`, CI-Erweiterung (Multi-Arch-Build-Validierung + echter Apache-Reverse-Proxy-WebSocket-Smoke-Test)
  - F-S2 — Krypto-Grundlage (`src/modules/crypto/`: Ed25519 über Node's natives `crypto`, RFC-8785-kanonisches JSON via `canonicalize`, `SignedEnvelope<T>`); Node-Identität (auto-generiert beim ersten Boot, `node_identity`-Tabelle, öffentlich unter `GET /v1/network/node-info`); Wurzelschlüssel-Tooling nur offline (`npm run network:generate-root-key`, `npm run network:sign-config` — der Wurzelschlüssel berührt nie einen laufenden Server); geräteseitig signierte Auth rein additiv (`POST /v1/devices/bind-key`, `POST /v1/auth/device-token` — bestehende `clientSecret`-Clients funktionieren unverändert weiter); signierte Netzwerk-Konfiguration (`NETWORK_CONFIG_PATH`/`NETWORK_ROOT_PUBLIC_KEY`, AND-gated Blitzer-Flag — ein signiertes Netz-Config kann das lokale Flag nur abschalten, nie einschalten), `GET /v1/config` liefert jetzt `federationEnabled` + das volle signierte `networkConfig`-Envelope zur eigenständigen Prüfung durch den Client.
- **Gerade in Arbeit:** als Nächstes F-S3 — Föderations-Endpunkte (Push/Pull), Beitritt über Seeds, netzwerkweites Moderationsgate.
- **Relevant für die Client-Instanz:**
  - Bestehendes Auth-Modell (`POST /v1/auth/token`, gemeinsames `JWT_SECRET`) bleibt unverändert nutzbar, solange `FEDERATION_ENABLED=false` — reine Zusatzfunktion, kein Bruch.
  - **Neue Endpunkte aus F-S2 (Details: `server/docs/api.md`, Schema: `server/docs/schema.md`):**
    - `GET /v1/network/node-info` (öffentlich, kein Auth) — Node-ID + öffentlicher Node-Schlüssel dieses Servers.
    - `POST /v1/devices/bind-key` (Bearer-Auth) — bindet einen geräteseitig erzeugten Ed25519-Public-Key einmalig an den bereits authentifizierten Client (Proof-of-Possession per signierter Assertion `{payload:{publicKey,timestamp}, keyId, signature}`).
    - `POST /v1/auth/device-token` (öffentlich, ersetzt/ergänzt `POST /v1/auth/token`) — Body `{clientId, assertion:{payload:{clientId,timestamp}, keyId, signature}}`, signiert mit dem via `bind-key` gebundenen Geräteschlüssel, liefert exakt dasselbe JWT-Format wie `POST /v1/auth/token`.
    - `GET /v1/config` — jetzt zusätzlich `federationEnabled: boolean` und `networkConfig: SignedEnvelope<NetworkConfigPayload> | null` im Response.
  - Das ist noch **nicht** das in `docs/federation.md` beschriebene Node-Verzeichnis (`GET /v1/network/nodes` o.ä.) — das kommt erst mit F-S4 (Reputation/Verzeichnis). F-S2 liefert nur die Krypto-Bausteine (Signaturformat, Node-Identität, ein Node), noch kein Mehr-Server-Verzeichnis.
  - `SignedEnvelope`-Format (gilt für alle künftigen signierten Payloads, nicht nur die zwei obigen): `{ payload: T, keyId: string, signature: string }`, Signatur = Ed25519 über RFC-8785-kanonisiertem `payload`. `keyId` ist nur ein Lookup-Hinweis (erste 16 Hex-Zeichen von sha256(publicKeyRaw)), niemals selbst die Vertrauensquelle — Verifikation braucht immer den unabhängig bekannten Public Key.

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
