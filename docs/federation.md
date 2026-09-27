# Konzept: Self-Hosting & Föderation (offenes Server-Netzwerk)

> **Status:** Entschieden (Grundsatz), Umsetzung über `docs/prompt-rework-server-federation.md` und `docs/prompt-rework-client-lib-federation.md`. Ergänzt `docs/concept.md` (Abschnitt 13). Bei Widerspruch gilt dieses Dokument für alle Fragen zu Betrieb, Verteilung und Erreichbarkeit.

---

## 1. Ziel

1. **Jeder kann einen Server betreiben** — per Docker (ein Befehl) oder klassisch ohne Docker (Node.js + PostgreSQL/PostGIS hinter Apache, nginx oder Caddy).
2. **Neue Server verbinden sich automatisch** mit dem bestehenden Netzwerk, übernehmen Daten und Last. Mehr Betreiber = mehr Kapazität, ohne dass ein zentraler Betreiber aufrüsten muss.
3. **Clients finden Server selbstständig**, verteilen ihre Anfragen und weichen bei Ausfall automatisch aus — ohne dass die Host-App etwas konfigurieren muss.
4. **Offene Mitgliedschaft mit Reputation** (Entscheidung des Projektinhabers): Jeder darf beitreten; unzuverlässige oder manipulierende Server werden automatisch erkannt und herabgestuft/ausgeschlossen.

---

## 2. Grundprinzip: „Vertraue Signaturen, nicht Servern"

Bei offener Mitgliedschaft kann jeder Server bösartig sein. Deshalb darf **kein Client und kein Server einem einzelnen fremden Server glauben**, sondern nur kryptografisch prüfbaren Daten:

| Datum | Wer signiert | Wer prüft |
|---|---|---|
| Meldung / Bestätigung eines Geräts | **Das Gerät selbst** (eigener Schlüssel, erzeugt bei der Registrierung, verlässt das Gerät nie) | Jeder Server, jeder Client |
| Statisches Datenpaket | Inhaltsadressiert (Hash) + Manifest, signiert vom **Netzwerk-Wurzelschlüssel** bzw. einem von ihm delegierten Import-Schlüssel | Jeder Client vor dem Einspielen |
| App-Schlüssel (für Geräteregistrierung) | Netzwerk-Wurzelschlüssel (Zertifikat) | Jeder Server |
| Netzwerk-Konfiguration (Verfallsregeln, Blitzer-Flag, Mindestversionen, Ausschlussliste) | Netzwerk-Wurzelschlüssel | Jeder Server, jeder Client |
| Server-Identität, Heartbeat, Kapazität | **Der Server selbst** (eigener Node-Schlüssel) | Andere Server, Verzeichnis |
| Server-Verzeichnis (Liste bekannter, gut bewerteter Server) | Verzeichnisdienst mit delegiertem Schlüssel des Netzwerks | Clients |

Konsequenz: Ein bösartiger Server kann Daten **zurückhalten oder verzögern**, aber **nicht fälschen**. Zurückhalten wird über Reputation (Abschnitt 5) und Mehrfachquellen (Clients fragen gelegentlich mehrere Server) erkannt.

Der **Netzwerk-Wurzelschlüssel** gehört dem Projektinhaber (offline aufbewahrt, nur zum Signieren von Delegationsschlüsseln und Netzwerk-Konfiguration). Ein Fork des Projekts erzeugt einfach einen eigenen Wurzelschlüssel und damit ein eigenes, getrenntes Netzwerk.

**Auswirkung auf Geräte-Identität (ersetzt/erweitert P2.0):** Statt serverseitig ausgestellter JWTs mit gemeinsamem `JWT_SECRET` (funktioniert nur auf einem Server) erzeugt jedes Gerät ein eigenes Schlüsselpaar. Die Registrierung bindet den öffentlichen Schlüssel per App-Schlüssel-Zertifikat an eine pseudonyme Reporter-ID. Jeder Server kann Anfragen und Meldungen dann ohne gemeinsames Geheimnis prüfen. Kurzlebige Zugriffstokens bleiben möglich, müssen aber asymmetrisch signiert sein (z. B. Ed25519/EdDSA), nie mit einem Secret, das alle Server teilen müssten.

---

## 3. Datenverteilung zwischen Servern

Das konkrete Replikationsmodell entscheidet Claude Code mit Begründung (Delegation durch den Projektinhaber). Leitplanken:

- **Statische Daten** sind unkritisch: inhaltsadressierte, signierte Pakete — jeder Server spiegelt sie einfach (wie ein CDN/Mirror). Kein Konsens nötig.
- **Dynamische Meldungen** sind geräte-signiert und damit überall prüfbar. Kandidaten:
  - **Signierte, zusammenführbare Ereignisse (empfohlene Richtung):** Jeder Server nimmt Meldungen an, verteilt sie per Gossip/Pub-Sub an Nachbarn; Deduplizierung über Ereignis-Hash; Zusammenführung von Meldungen (Duplikat-Merge) und Verfall deterministisch aus den signierten Ereignissen berechnet, sodass alle Server zum gleichen Ergebnis kommen (CRDT-artig). Kein zentraler Schreibpunkt.
  - **Koordinator + Replikate:** einfacher, aber zentraler Engpass und Ausfallpunkt — widerspricht dem Ziel „Kapazität wächst mit Betreibern" teilweise.
  - **Regionale Zuständigkeit (Sharding nach H3-Tile):** Server übernehmen Tiles, Zuordnung über konsistentes Hashing; Replikation an k Nachbarn.
- **Sequenznummern sind pro Server lokal.** Clients dürfen nicht annehmen, dass `since=1234` auf einem anderen Server dasselbe bedeutet. Wechselt ein Client den Server, braucht er einen server-unabhängigen Synchronisationspunkt (z. B. Zeitstempel + Vektoruhr/Hash-Menge) oder einen gezielten Neu-Snapshot der abonnierten Tiles (bei dynamischen Daten klein genug).
- **Moderationsgate gilt netzwerkweit:** Rate-Limits pro Gerät müssen serverübergreifend greifen (sonst verteilt ein Angreifer seine Meldungen auf viele Server). Ansatz: Limits werden beim Zusammenführen deterministisch auf die signierten Ereignisse eines Geräts angewendet, nicht nur lokal beim Empfang.
- **Bulk-Import** bleibt ein normaler Client; erzeugte Pakete werden mit einem vom Wurzelschlüssel delegierten Import-Schlüssel signiert.

---

## 4. Beitritt eines neuen Servers (automatisch)

1. Betreiber startet den Server (Docker oder manuell) mit einer öffentlichen HTTPS-Adresse.
2. Beim ersten Start erzeugt der Server seinen **Node-Schlüssel** und lädt die **signierte Netzwerk-Konfiguration** + **Seed-Liste** (im Image/Paket enthalten, zusätzlich aus dem Verzeichnis).
3. Der Server kontaktiert Seed-Server, meldet sich an (signierter Beitrittsantrag mit Adresse, Version, Kapazität, Region), bekommt Nachbarn genannt (Gossip), beginnt mit der **Synchronisation** (statische Pakete spiegeln, dynamische Ereignisse der letzten Aufbewahrungsperiode übernehmen).
4. Status zunächst **„Probezeit"**: Der Server wird geprüft (Abschnitt 5), bekommt nur wenig Client-Traffic zugeteilt und steigt mit guter Reputation auf.
5. Heartbeats (signiert) halten Adresse, Last und Version aktuell. Server ohne Heartbeat fallen nach einer Frist aus dem Verzeichnis.

Ein Betreiber kann den Beitritt abschalten (`FEDERATION_ENABLED=false`) und einen rein privaten Einzelserver betreiben.

---

## 5. Reputation von Servern (offene Mitgliedschaft)

Automatisch gemessen, von mehreren unabhängigen Prüfern (andere Server, Verzeichnisdienst, stichprobenartig Clients):

- **Verfügbarkeit & Latenz** (Health-Checks).
- **Datenintegrität:** liefert der Server Pakete mit korrektem Hash? Reicht er gültige Ereignisse weiter oder hält er welche zurück (Abgleich: „Ereignis X ist seit Minuten bei anderen Servern bekannt, bei dir nicht")?
- **Protokolltreue:** korrekte Versionen, keine ungültigen Signaturen, keine Spam-Weiterleitung.
- **Kapazitätsangaben vs. gemessene Leistung.**

Stufen: *Probezeit → aktiv → bevorzugt*; Abstufung bis *ausgeschlossen*. Ausschlüsse landen in der signierten Netzwerk-Konfiguration (Ausschlussliste). Sybil-Schutz (viele Fake-Server eines Angreifers): Reputation wird langsam aufgebaut, Beitrittsanträge sind rate-limitiert (z. B. Proof-of-Work oder Wartezeit pro IP-Bereich), und kein einzelner Server sieht mehr als einen kleinen Anteil der Clients.

**Restrisiko, bewusst akzeptiert:** Ein fremder Server sieht die IP-Adresse und die abonnierten H3-Tiles der Clients, die ihn nutzen (Positionsnähe!). Minderung: grobe Tiles, Clients streuen Anfragen über mehrere Server, Datenschutzhinweis (siehe Abschnitt 8).

---

## 6. Installation (Server)

Beide Wege sind gleichwertig und dokumentiert:

**Docker (empfohlen):**
- Offizielles Image (z. B. `ghcr.io/romsmo/trafficnetwork-server`), Multi-Arch (amd64 + arm64, damit auch Raspberry Pi / ARM-VPS).
- `docker compose up -d` startet: API-Server, PostgreSQL+PostGIS, optional Caddy als Reverse-Proxy mit automatischem Let's-Encrypt-Zertifikat.
- Konfiguration nur über `.env`; Migrationen laufen beim Start automatisch; Healthcheck eingebaut.

**Ohne Docker:**
- Node.js-LTS + PostgreSQL mit PostGIS (Distribution-Pakete), Server als systemd-Dienst (Beispiel-Unit mitgeliefert) bzw. Windows-Dienst-Anleitung.
- Reverse-Proxy-Beispielkonfigurationen für **Apache** (`mod_proxy`, `mod_proxy_wstunnel` für `/v1/ws`), **nginx** und **Caddy**, jeweils mit TLS.
- Externe Datenbank (z. B. Neon) bleibt möglich, ist aber keine Voraussetzung mehr.

---

## 7. Domain, Erreichbarkeit & Server-Suche

### 7.1 Optionen im Vergleich

| Ansatz | Vorteile | Nachteile |
|---|---|---|
| **A. Eine Projekt-Domain, alle Server dahinter (DNS-Round-Robin / GeoDNS)** | Für Clients trivial (`api.<domain>`) | Community-Server müssten in die DNS-Zone des Projekts → zentrale Verwaltung, TLS-Zertifikate für einen gemeinsamen Namen auf fremden Servern = Schlüsselweitergabe (inakzeptabel). DNS-Ausfall = Totalausfall |
| **B. Jeder Server hat eine eigene Adresse + signiertes Server-Verzeichnis (empfohlen)** | Kein gemeinsames Zertifikat, jeder Betreiber bleibt eigenständig; Clients wählen nach Region/Last/Reputation; Verzeichnis kann beliebig gespiegelt werden | Clients brauchen eine Such-Logik (liefert die Client-Bibliothek) |
| **C. Projekt vergibt Subdomains an Server ohne eigene Domain** (`<node-id>.nodes.<domain>`, automatisch per DNS-API) | Auch Betreiber ohne Domain können mitmachen; gültiges TLS per Let's Encrypt (DNS-01 durch Projekt-DNS oder HTTP-01) | Projekt muss DNS-Automatisierung betreiben; Missbrauchsschutz nötig |
| **D. Kostenlose DynDNS-Namen** (z. B. DuckDNS, deSEC) | Kein Projektaufwand | Abhängigkeit von Drittanbietern |
| **E. DNS-SRV/TXT-Records** (`_trafficnet._tcp.<domain>`) | Standardisierte Suche | Browser/WASM können SRV nicht direkt abfragen; nur Ergänzung |
| **F. Reines Peer-to-Peer (DHT, libp2p)** | Keine Domain nötig | Für mobile Geräte/Browser schwer (NAT, Akku), großer Aufwand — nicht jetzt |
| **G. Tunnel-Dienste (z. B. Cloudflare Tunnel, Tailscale Funnel)** | Server hinter NAT/Heimnetz erreichbar, TLS inklusive | Anbieterabhängigkeit; als optionale Betreiber-Anleitung sinnvoll |

### 7.2 Empfehlung (Grundsatz, Details entscheidet Claude Code)

**B als Basis, C und G als Komfort-Optionen, A nur für den Einstieg:**

1. **Projekt-Domain** (`trafficnetwork.info`, entschieden 2026-09-27; Registrierung/DNS-Betrieb liegt beim Betreiber) dient nur als **Anker**, nicht als Nadelöhr:
   - `directory.<domain>` → signiertes Server-Verzeichnis (JSON), zusätzlich gespiegelt (z. B. GitHub Pages / Repo, weitere Mirrors), damit ein Domain-Ausfall das Netzwerk nicht lahmlegt.
   - `seed1.<domain>`, `seed2.<domain>` → vom Projekt betriebene Seed-Server.
   - optional `nodes.<domain>` → automatische Subdomains für Community-Server ohne eigene Domain (Option C).
2. **Jeder Community-Server** läuft unter seiner **eigenen HTTPS-Adresse** (eigene Domain, Projekt-Subdomain, DynDNS oder Tunnel) mit eigenem Let's-Encrypt-Zertifikat. Nackte IP-Adressen/selbstsignierte Zertifikate werden nicht unterstützt (Browser/WASM und Mobile-Plattformen verlangen gültiges TLS).
3. **Clients (Client-Bibliothek):**
   - Enthalten eine **eingebaute Seed-Liste** (mehrere Adressen, unterschiedliche Domains) + den öffentlichen Netzwerk-Wurzelschlüssel.
   - Laden beim Start das **signierte Verzeichnis** (von Seeds, Mirrors oder jedem bekannten Server), cachen es lokal und aktualisieren es regelmäßig.
   - Wählen Server nach Region (Nähe zu den abonnierten Tiles), gemessener Latenz, Last und Reputation; nutzen mehrere Server parallel/rotierend; wechseln bei Fehlern automatisch (Failover mit Backoff).
   - Prüfen alle Daten per Signatur — der gewählte Server muss nicht vertrauenswürdig sein.
   - Host-Apps können optional eigene Server fest vorgeben (z. B. Firmen-Server) oder die Suche abschalten.
4. **Lastverteilung** passiert primär **clientseitig** (Auswahl aus dem Verzeichnis). Server können zusätzlich überlasten-signalisieren (HTTP 503 + `Retry-After` + Liste alternativer Server).

---

## 8. Rechtliches (neu durch Föderation)

- **DSGVO:** Jeder Server-Betreiber verarbeitet Positions-Tiles, IP-Adressen und pseudonyme Reporter-IDs → jeder ist selbst Verantwortlicher. Nötig: Betreiberbedingungen (Beitritt setzt Zustimmung voraus), Datenschutzhinweise für Clients inkl. „Daten werden über Server Dritter verteilt", Aufbewahrungsfristen netzwerkweit in der signierten Konfiguration. `docs/privacy.md` muss das abdecken.
- **Blitzer-Namensraum:** Die Aktivierung erfolgt ausschließlich über die **signierte Netzwerk-Konfiguration** (Projektinhaber, nach rechtlicher Prüfung). Client-Bibliothek und Referenz-Server ignorieren lokale Abweichungen. Ein modifizierter Fork kann das technisch umgehen — dann ist es dessen eigenes Netzwerk mit eigenem Wurzelschlüssel und eigener Verantwortung.
- **Lizenzen der Daten:** Provenienz-Metadaten reisen mit jedem Paket/Ereignis zu jedem Server; Betreiber müssen über das Lizenzrisiko einzelner Quellen informiert werden (Betreiberbedingungen).

---

## 9. Offene Punkte für den Projektinhaber

- [ ] Domain `trafficnetwork.info` registrieren und DNS betreiben (Platzhalter im Code/in der Doku sind bereits ersetzt, siehe `client-lib/core/src/api/options.rs`s `DEFAULT_SEEDS`)
- [ ] Netzwerk-Wurzelschlüssel erzeugen und sicher offline aufbewahren (Anleitung liefert die Überarbeitung)
- [ ] Mindestens zwei Seed-Server bereitstellen (verschiedene Anbieter/Standorte)
- [ ] Betreiberbedingungen (Terms for node operators) + Datenschutz rechtlich prüfen lassen
