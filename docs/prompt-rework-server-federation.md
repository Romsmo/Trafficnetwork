# Prompt für Claude Code — Überarbeitung Server: Self-Hosting & Föderation (Phase F-Server)

> **Scope:** Überarbeitung des bestehenden Pakets `server/` im Monorepo `https://github.com/Romsmo/Trafficnetwork` (privat, Owner: Romsmo), damit der Server (1) per Docker **oder** klassisch hinter Apache/nginx/Caddy installierbar ist und (2) sich als Knoten eines **offenen, föderierten Server-Netzwerks** automatisch mit anderen Servern verbindet, um Kapazität und Last zu teilen.
>
> **Maßgeblich:** `docs/federation.md` (**neu, vollständig lesen — Grundsatzentscheidungen**), `docs/concept.md`, `server/README.md`, `server/docs/api.md`, `server/docs/schema.md`.
>
> **Nicht Teil dieses Prompts:** Anpassung von `client-lib/` (eigener Prompt `docs/prompt-rework-client-lib-federation.md`, läuft **nach** diesem), `ingestion/`, Apps.

---

## 0. SETUP — REPO SELBST KLONEN & STAND PRÜFEN

1. Prüfe, ob du bereits in einem Klon von `Romsmo/Trafficnetwork` bist (`git remote -v`). Falls ja: `git checkout main && git pull`. Falls nicht: `git clone https://github.com/Romsmo/Trafficnetwork.git` (alternativ `gh repo clone Romsmo/Trafficnetwork` oder SSH) und `cd Trafficnetwork`.
2. Das Repo ist **privat**. Schlägt der Clone fehl: Fehlermeldung zeigen, Optionen nennen (`gh auth login`, SSH-Key, PAT über Credential-Helper). Nie nach Passwörtern/Tokens fragen, keine Zugangsdaten in Dateien.
3. Prüfe den tatsächlichen Stand: Welche Server-Meilensteine sind umgesetzt (P1.0–P1.5, P2.0)? Gibt es bereits Code in `client-lib/`? Ist der letzte CI-Lauf grün (`gh run list`)? Berichte mir kurz, bevor du planst. Bei roter CI: erst melden.
4. Arbeite auf einem Branch `rework/server-federation`, pushe nach jedem Meilenstein; Merge nach `main` erst nach meiner Freigabe (Pull Request).

---

## ROLLE & ARBEITSWEISE

1. **Erst planen, dann bauen** (Plan-Modus). Plan + Meilensteine vorlegen, auf Freigabe warten.
2. **Bei offenen Fragen: frag mich** — konkrete Optionen mit Empfehlung.
3. **Nichts erfinden:** Protokolle, Bibliotheken, Kryptografie, Let's-Encrypt-/DNS-Verhalten, Docker-/Apache-Details mit Beleg (Link/Datum).
4. **Sicherheit vor Bequemlichkeit:** Kryptografie nur mit etablierten Bibliotheken (keine Eigenbauten), Bedrohungsmodell schriftlich (`server/docs/threat-model.md`).
5. **Rückwärtskompatibilität:** Ein Einzelserver ohne Föderation (`FEDERATION_ENABLED=false`) muss weiterhin funktionieren. Brechende API-Änderungen nur versioniert (z. B. `/v2`) oder mit Übergangsphase — begründen.
6. **Inkrementell und grün:** Nach jedem Meilenstein Build + Tests (auch CI) grün, Commit + Push, `server/README.md` aktualisieren, kurze Zusammenfassung an mich.
7. **Sprache:** Code/Doku Englisch, Rückfragen Deutsch.

---

## 1. VERBINDLICHE ENTSCHEIDUNGEN (nicht neu verhandeln)

- **Offene Mitgliedschaft mit Reputation:** Jeder darf einen Server betreiben und beitreten; Schutz durch Signaturen + automatische Reputation (siehe `docs/federation.md` Abschnitt 2 und 5).
- **„Vertraue Signaturen, nicht Servern":** Gerätemeldungen sind gerätesigniert, statische Pakete inhaltsadressiert + signiert, Netzwerk-Konfiguration vom Netzwerk-Wurzelschlüssel signiert.
- **Geräte-Identität asymmetrisch:** Kein gemeinsames `JWT_SECRET` zwischen Servern. Geräte erzeugen ihr Schlüsselpaar selbst; App-Schlüssel sind vom Wurzelschlüssel signierte Zertifikate. Die bestehende P2.0-Geräteregistrierung wird entsprechend umgebaut (Migrationspfad für bereits registrierte Geräte beschreiben).
- **Blitzer-Flag nur über signierte Netzwerk-Konfiguration**; standardmäßig aus; ein lokales Env-Flag darf die Netzwerkvorgabe nicht aufheben.
- **Installation:** Docker **und** ohne Docker (Apache, nginx, Caddy) gleichwertig dokumentiert und getestet.
- **Erreichbarkeit:** Jeder Server unter eigener HTTPS-Adresse; Projekt-Domain nur als Anker (Verzeichnis, Seeds, optionale Node-Subdomains). Domain existiert noch nicht → Platzhalter `trafficnetwork.example`, zentral konfigurierbar.
- **Provenienz-Metadaten, Local-First-Prinzip, „Ingestion ist optional"** bleiben unverändert.

---

## 2. ENTSCHEIDUNGEN, DIE DU TRIFFST (mit Begründung + Beleg)

1. **Replikationsmodell** für dynamische Daten (Kandidaten und Leitplanken: `docs/federation.md` Abschnitt 3). Muss: ohne zentralen Schreib-Engpass skalieren, bösartige Server tolerieren (fälschen unmöglich, zurückhalten erkennbar), deterministisches Zusammenführen (Duplikat-Merge, Verfall, geräteweite Rate-Limits).
2. **Server-zu-Server-Transport** (z. B. HTTP + WebSocket-Gossip, bestehende Infrastruktur weiterverwenden vs. zusätzliches Protokoll).
3. **Signaturverfahren und Formate** (z. B. Ed25519, kanonische Serialisierung, Schlüsselrotation, Widerruf).
4. **Server-unabhängiger Sync-Punkt** für Clients, die zwischen Servern wechseln (Sequenznummern sind lokal).
5. **Reputationsverfahren** (Messgrößen, Prüfer, Stufen, Sybil-Schutz beim Beitritt).
6. **Verzeichnisdienst**: eigener Modus des Servers vs. separates kleines Programm; Format; Spiegelung (z. B. statische Datei auf GitHub Pages).
7. **Automatische Node-Subdomains** (`docs/federation.md` 7.1 Option C): umsetzen oder nur als Anleitung (DynDNS/Tunnel) — mit Aufwand/Nutzen begründen.
8. **Umgang mit dem Datenbank-Anbieter** (Neon weiter optional; Standard = PostgreSQL+PostGIS im Compose-Stack).

---

## 3. ARBEITSPAKETE

### 3.1 Paketierung & Installation
- Multi-Arch-Docker-Image (amd64/arm64), veröffentlicht über GitHub Container Registry per CI (Veröffentlichung erst nach meiner Freigabe; Build in CI reicht zunächst).
- `docker-compose.yml`: Server + PostgreSQL/PostGIS (+ optional Caddy mit Auto-TLS). Automatische Migrationen beim Start, Healthchecks, Volumes, sinnvolle Ressourcen-Defaults.
- Ohne Docker: Installationsanleitung (Linux zuerst, Windows-Hinweise), systemd-Unit, Beispielkonfigurationen für **Apache** (inkl. `mod_proxy_wstunnel` für `/v1/ws`), **nginx**, **Caddy**; Upgrade- und Backup-Anleitung.
- Konfiguration ausschließlich per Umgebungsvariablen, vollständig in `.env.example` dokumentiert; Start bricht mit klarer Meldung ab, wenn Pflichtwerte fehlen.
- CI: Smoke-Test des Compose-Stacks und eines Apache-Reverse-Proxy-Setups (Container).

### 3.2 Identitäten & Kryptografie
- Node-Schlüssel (beim ersten Start erzeugt, sicher gespeichert), Netzwerk-Wurzelschlüssel-Konzept inkl. Delegationsschlüsseln (Verzeichnis, Import), CLI zum Erzeugen/Signieren/Widerrufen (`npm run network:*`) mit Anleitung für sichere Offline-Aufbewahrung.
- Umbau Geräteregistrierung/Auth auf gerätesignierte Anfragen/Meldungen; App-Schlüssel-Zertifikate.
- Signierte Netzwerk-Konfiguration (Verfallsregeln, Blitzer-Flag, Aufbewahrungsfristen, Mindestversion, Ausschlussliste) — `GET /v1/config` liefert sie inkl. Signatur.

### 3.3 Föderation
- Beitritt über Seeds, Gossip-basierte Peer-Liste, signierte Heartbeats (Adresse, Version, Region, Kapazität, Last).
- Replikation statischer Pakete (inhaltsadressiert, Hash-Prüfung) und dynamischer Ereignisse gemäß deiner Entscheidung 2.1.
- Netzwerkweites Moderationsgate (Duplikat-Merge, Verfall, geräteweite Rate-Limits deterministisch).
- Probezeit/Reputation, Ausschluss, Überlast-Signal (503 + `Retry-After` + Alternativen).
- `FEDERATION_ENABLED=false` → isolierter Einzelserver.

### 3.4 Verzeichnis & Discovery
- Signiertes Server-Verzeichnis (Endpunkt + exportierbare statische Datei), Filter nach Region/Reputation/Version.
- Server-seitige Discovery-Endpunkte für Clients (z. B. `GET /v1/network/nodes`), die ebenfalls das signierte Verzeichnis ausliefern.
- Domain-Konfiguration zentral (`NETWORK_DOMAIN`, `SEED_URLS`), keine hart codierte Domain im Code.

### 3.5 Beobachtbarkeit & Betrieb
- Strukturierte Logs, Metriken-Endpunkt (z. B. Prometheus-Format), Status-Seite/Endpunkt mit Föderationszustand.
- Betreiber-Doku: `server/docs/operating.md` (Installation, Beitritt, Updates, Backup, Troubleshooting, Datenschutzpflichten des Betreibers).

---

## 4. TESTS

- Unit: Signaturen, kanonische Serialisierung, Merge-/Verfallsdeterminismus, Reputation.
- Integration: **Mehrknoten-Testnetz** (mind. 3 Server + DBs via Testcontainers/Compose) — Beitritt, Replikation, Failover eines Knotens, Netzwerkpartition + Wiedervereinigung, bösartiger Knoten (fälscht Daten → abgelehnt; hält Daten zurück → Reputation sinkt), geräteweites Rate-Limit über mehrere Server, Blitzer-Flag nur per signierter Konfiguration, Einzelserver-Modus, leerer Server gültig.
- Installations-Smoke-Tests (Compose, Apache-Proxy inkl. WebSocket).

---

## 5. NICHT-ZIELE

- Kein reines P2P/DHT, keine Blockchain.
- Keine Client-Bibliotheks-Änderungen (eigener Prompt).
- Keine Veröffentlichung von Images/Paketen, kein DNS-/Domain-Kauf, kein Signieren mit einem echten Wurzelschlüssel ohne meine Freigabe (Tests nutzen Test-Schlüssel).
- Kein Aktivieren des Blitzer-Flags.

---

## 6. MEILENSTEINE

| # | Inhalt |
|---|---|
| F-S0 | Stand geprüft, Bedrohungsmodell, Entscheidungen Abschnitt 2, Plan + Migrationspfad vorgelegt |
| F-S1 | Docker-Image + Compose, Installation ohne Docker (Apache/nginx/Caddy), Installations-CI |
| F-S2 | Identitäten & Kryptografie: Node-/Wurzel-/Delegationsschlüssel, gerätesignierte Auth, signierte Netzwerk-Konfiguration, Migration bestehender Geräte |
| F-S3 | Föderation: Beitritt, Gossip, Replikation statisch + dynamisch, netzwerkweites Moderationsgate |
| F-S4 | Reputation, Ausschluss, Überlast-Signal, Verzeichnis + Discovery-Endpunkte |
| F-S5 | Mehrknoten-Testnetz grün, Betreiber-Doku, `server/docs/api.md`/`schema.md`/`federation`-Protokollspezifikation (`server/docs/federation-protocol.md`) aktualisiert — **Abschluss**, Pull Request |

Nach jedem Meilenstein: `server/README.md` und `docs/todo.md` aktualisieren, Commit + Push, kurze Zusammenfassung.

---

## 7. WAS ICH VOR DEM CODE VON DIR ERWARTE

1. Kurzbericht zum tatsächlichen Repo-Stand (inkl. `client-lib/`).
2. Bedrohungsmodell (Kurzfassung).
3. Deine Entscheidungen zu Abschnitt 2 mit Begründung und Beleg.
4. Protokoll-Skizze (Nachrichten, Signaturen, Sync-Punkt) und Schemaänderungen.
5. Migrationspfad vom heutigen Einzelserver (inkl. bestehender Geräte und API-Kompatibilität).
6. **Liste offener Fragen an mich.**
