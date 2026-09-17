# Live status: Überarbeitung F (Self-Hosting & Föderation)

> **Zweck:** Zwei Claude-Code-Instanzen arbeiten parallel an getrennten Branches (Server bzw. Client-Bibliothek) und teilen sich keinen Kontext. Diese Datei lebt bewusst direkt auf `main` (nicht auf einem Feature-Branch) und wird von **jeder** Instanz nach jedem abgeschlossenen Meilenstein aktualiziert, committet und gepusht — so sieht die andere Instanz per `git fetch origin main` sofort den aktuellen Stand, ohne den unfertigen Code des anderen Branches anzufassen. `docs/todo.md` bleibt der langfristige Fahrplan; diese Datei ist der kurzfristige "was passiert gerade"-Status.

Letztes Update: 2026-09-17, Server-Instanz.

---

## Server (`server/`)

- **Branch:** `rework/server-federation`
- **Letzter Commit:** `17c4518` — "ci: trigger server-ci on rework/* branch pushes, not just main/PRs"
- **CI:** grün (`server-ci` Run #13, alle drei Jobs: `test`, `docker-build`, `install-smoke`)
- **Abgeschlossen:**
  - F-S0 — Plan, Bedrohungsmodell (Kurzfassung), acht Entscheidungen mit Beleg, Protokoll-Skizze, Migrationspfad
  - F-S1 — Docker-Image (Multi-Arch amd64+arm64), `docker-compose.yml` (Server+PostGIS+optional Caddy), Installation ohne Docker (`deploy/{apache.conf,nginx.conf,Caddyfile.example,trafficnetwork-server.service}`), `server/docs/installation.md`, volles `server/docs/threat-model.md`, CI-Erweiterung (Multi-Arch-Build-Validierung + echter Apache-Reverse-Proxy-WebSocket-Smoke-Test)
- **Gerade in Arbeit:** F-S2 — Node-/Wurzel-/Delegationsschlüssel, geräteseitig signierte Auth (additiv zum bestehenden JWT-Modell), signierte Netzwerk-Konfiguration über `/v1/config`
- **Relevant für die Client-Instanz:**
  - Bestehendes Auth-Modell (`POST /v1/auth/token`, gemeinsames `JWT_SECRET`) bleibt unverändert nutzbar, solange `FEDERATION_ENABLED=false` — reine Zusatzfunktion, kein Bruch.
  - `server/docs/api.md` und `server/docs/schema.md` sind der aktuelle Stand der Server-API (Phase 1 + P2.0) — noch ohne die neuen Föderations-/Signatur-Endpunkte aus F-S2/F-S3, die folgen inkrementell.
  - Der in `docs/federation.md` beschriebene Wechsel zu geräteseitig erzeugten Ed25519-Schlüsseln betrifft die Geräte-Registrierung (`POST /v1/devices/register`, P2.0) — Details/genaue Endpunkt-Form folgen mit F-S2, hier aktualisiert, sobald implementiert.

## Client-Bibliothek (`client-lib/`)

- **Branch:** unbekannt — noch kein `rework/client-lib-*`-Branch auf `origin` sichtbar (Stand dieses Updates).
- **Status:** `client-lib/` enthält auf `main` bisher nur ein README, kein Code (weder Phase-2-Basis noch Föderations-Überarbeitung).
- *Bitte von der Client-Instanz beim ersten eigenen Update hier ausfüllen.*

---

## Wie diese Datei genutzt wird

1. Vor dem Weiterarbeiten: `git fetch origin main && git show origin/main:docs/status.md` (oder einfach `main` separat auschecken), um zu sehen, was die andere Instanz zuletzt getan hat.
2. Nach jedem eigenen Meilenstein: den eigenen Abschnitt oben aktualisieren (Branch, letzter Commit, Status, "relevant für die andere Instanz"), auf `main` committen und pushen — unabhängig vom Stand des eigenen Feature-Branches.
3. Nicht den Abschnitt der anderen Instanz überschreiben, außer um offensichtlich veraltete Angaben zu korrigieren.
