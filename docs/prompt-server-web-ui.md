# Prompt für Claude Code — Server-Weboberfläche (Karte, Melden, Anleitung)

> **Ziel:** Jeder Knoten liefert unter seiner eigenen Adresse eine kleine, eigenständige Weboberfläche aus: eine Karte mit den aktuellen Daten (Tempolimits, Gefahrenmeldungen), die Möglichkeit, selbst eine Gefahr zu melden und Meldungen zu bestätigen, dazu eine Seite „So verbindest du dich" (eigene App über die Client-Bibliothek, eigener Knoten, API) und ein sichtbarer Verweis auf das GitHub-Projekt.
>
> **Scope:** Reine **Ergänzung** zum bereits fertigen Server — nur ein neues Teilverzeichnis `server/web/` plus Doku. Bestehender Code wird nicht umgebaut, die API bleibt unverändert (keine geänderten Endpunkte, keine geänderten Antworten); neue Endpunkte nur, wenn die Oberfläche ohne sie nicht funktioniert, und dann additiv und dokumentiert. **Kein** Eingriff in `client-lib/`, `ingestion/`, `tools/`.
>
> **Maßgeblich (vollständig lesen):** `docs/status.md`, `server/docs/api.md`, `server/docs/schema.md`, `server/docs/federation-protocol.md`, `server/docs/threat-model.md`, `docs/concept.md` (Abschnitt 8: Blitzer), `docs/federation.md`.

---

## 0. SETUP & KOORDINATION

1. Klon prüfen, `git checkout main && git pull`. **`docs/status.md` lesen** — es arbeiten parallel andere Claude-Instanzen im selben Checkout. Vor jedem Branch-Wechsel `git status`, niemals wechseln, solange fremde Änderungen im Arbeitsverzeichnis liegen.
2. Branch `feature/server-web-ui`. Nach jedem Meilenstein: Commit + Push, eigenen Abschnitt in `docs/status.md` auf `main` aktualisieren, kurze Zusammenfassung an mich. Merge nach `main` nur per Pull Request mit meiner Freigabe.
3. **Voraussetzung:** Die Föderations-Überarbeitung (F-S) ist gemergt und CI grün. Ist sie es nicht, sag es mir und bau trotzdem gegen die dokumentierte API — aber ohne Annahmen über noch nicht existierende Endpunkte.
4. Arbeitsweise: erst planen (Plan-Modus), bei Unklarheit fragen, nichts erfinden (Bibliotheken, Kartenlizenzen, Nutzungsbedingungen mit Link + Datum belegen), inkrementell grün, Code/Doku Englisch, Rückfragen an mich Deutsch.

---

## 1. VERBINDLICHE LEITPLANKEN

- **Teil des Servers, aber abschaltbar:** Auslieferung durch denselben Prozess unter `/` (API bleibt unter `/v1/...`), per `WEB_UI_ENABLED` (Standard: an) abschaltbar. Ein Betreiber, der nur API will, schaltet sie aus.
- **Keine Geheimnisse im Browser.** Im ausgelieferten JavaScript/HTML steht kein App-Schlüssel, kein Client-Secret, kein privater Schlüssel. Wie sich die Seite gegenüber der API ausweist, ist deine Entscheidung (Abschnitt 2.1) — aber nichts, was ein Besucher aus dem Quelltext kopieren und missbrauchen kann.
- **Kein externer Code.** Kein CDN, keine Tracker, keine Fonts von fremden Servern, keine Analytics. Alle Skripte und Stile werden mit ausgeliefert. Einzige externe Verbindung sind die Kartenkacheln (Abschnitt 2.2).
- **Blitzer-Kategorien** erscheinen in der Oberfläche nur, wenn die signierte Netzwerk-Konfiguration sie freigibt — sonst weder auf der Karte noch als Meldeknopf, auch nicht ausgegraut.
- **Missbrauchsschutz:** Meldungen aus dem Browser laufen durch dasselbe Moderationsgate wie alle anderen, mit eigener, strengerer Begrenzung pro IP/Sitzung. Kein Weg an der Moderation vorbei.
- **Datenschutz:** Standort nur nach ausdrücklicher Freigabe durch den Besucher, niemals im Hintergrund. Keine Cookies außer technisch notwendigen, keine Profilbildung, kein Speichern von Positionsverläufen auf dem Server. Kurzer, ehrlicher Datenschutzhinweis direkt auf der Seite (verweist auf `docs/privacy.md`, sobald es existiert).
- **Sicherheitshinweis:** Gut sichtbar, dass die Seite nicht während der Fahrt bedient werden soll.
- **Barrierefrei und mobilfreundlich:** Bedienbar per Tastatur, ausreichende Kontraste, sinnvolle Beschriftungen, funktioniert auf dem Handy in Hochkant.
- **Zwei Sprachen:** Deutsch und Englisch, Umschalter sichtbar, Erkennung über die Browsersprache.

---

## 2. ENTSCHEIDUNGEN, DIE DU TRIFFST (mit Begründung + Beleg im Plan)

1. **Identität der Browser-Besucher:** Wie meldet die Seite, ohne Geheimnis im Quelltext? Kandidaten: serverseitig ausgestellte, kurzlebige Sitzungs-Identität für Webbesucher (eigener, stark begrenzter Scope); oder im Browser per WebCrypto erzeugter, nicht exportierbarer Schlüssel, der über den bestehenden Weg (`bind-key`/`device-token`) gebunden wird. Wichtig: Web-Meldungen müssen für andere Knoten als solche erkennbar bleiben (Reputation!), und ein Massen-Missbrauch über die Seite darf keine Geräte-Identitäten echter Apps entwerten.
2. **Kartenkacheln:** OpenStreetMap ist gesetzt. Welche Kachelquelle — offizielle OSM-Kacheln, ein anderer Anbieter oder eigene Kacheln? **Prüfe und belege die Nutzungsbedingungen der OSM-Tile-Server** (sie sind für Massenzugriffe ausdrücklich nicht gedacht) und mach die Kachel-URL per Umgebungsvariable konfigurierbar, damit ein Betreiber mit viel Verkehr wechseln kann. Attribution korrekt einbinden.
3. **Kartenbibliothek:** Leaflet oder MapLibre GL — lokal ausgeliefert, klein, ohne Kontozwang.
4. **Frontend-Ansatz:** so einfach wie möglich (statische Dateien plus schlankes Framework oder ganz ohne). Kein schwergewichtiges Build-Setup, wenn es nicht nötig ist; der Build muss in das bestehende Docker-Image passen.
5. **Datenquelle der Seite:** direkte API-Aufrufe gegen den eigenen Knoten (`/v1/...`) — inklusive Live-Aktualisierung über WebSocket. Begründe, ob die Seite bei vielen Markern Kacheln/Cluster nutzt.

---

## 3. SEITEN UND FUNKTIONEN

### 3.1 Startseite mit Karte
- Karte, standardmäßig auf die Region zentriert, in der dieser Knoten Daten hat (oder auf die freigegebene Position des Besuchers).
- Angezeigt werden: aktive Gefahrenmeldungen (Symbol je Typ, Alter, Anzahl Bestätigungen), optional Tempolimits als Einfärbung der Straßen oder per Klick auf eine Stelle („Tempolimit hier: 50 km/h").
- Filter nach Kategorie, Anzeige der Restlaufzeit einer Meldung, automatisches Verschwinden abgelaufener Meldungen.
- Live-Aktualisierung: Neue Meldungen erscheinen ohne Neuladen.
- Klick auf eine Meldung: Detailkarte mit „ist noch da" / „ist weg"-Knöpfen (Bestätigen/Widersprechen).

### 3.2 Melden
- Knopf „Gefahr melden": Typ wählen (Stau, Unfall, Baustelle, Glätte, Panne, Hindernis — Blitzer nur bei Freigabe), Position aus der Karte oder aus der Standortfreigabe, absenden.
- Ehrliche Rückmeldung: angenommen, mit einer bestehenden Meldung zusammengeführt, oder abgelehnt (mit Grund, z. B. Begrenzung erreicht).
- Funktioniert ohne Konto und ohne Registrierung durch den Besucher.

### 3.3 Seite „Verbinden"
Verständlich für Leute, die das Projekt nicht kennen:
- **Als App-Entwickler:** Client-Bibliothek einbinden (Kurzbeispiel pro Plattform, verweist auf `client-lib/docs/`), wie man einen App-Schlüssel bekommt, welche Adresse man einträgt bzw. dass die Suche automatisch läuft.
- **Als Knotenbetreiber:** in wenigen Zeilen von „Docker installiert" bis „mein Knoten ist im Netzwerk" — verweist auf `server/docs/installation.md` und `server/docs/operating.md`.
- **Direkt über die API:** Basisadresse dieses Knotens, Link auf `server/docs/api.md`, zwei, drei kopierbare `curl`-Beispiele (Tempolimit abfragen, Umgebung abfragen), Hinweis auf Grenzen und Authentifizierung.
- **Netzwerkstatus:** Knoten-ID dieses Servers, Version, ob Föderation aktiv ist, wie viele Knoten bekannt sind — aus den vorhandenen Endpunkten, keine neuen Datenquellen erfinden.

### 3.4 Über das Projekt
Kurz: Was das Netzwerk ist, dass es quelloffen ist (Apache License 2.0), dass jeder einen Knoten betreiben kann, Datenschutzhinweis, Sicherheitshinweis zur Fahrt — und ein gut sichtbarer **Link zum GitHub-Projekt: `https://github.com/Romsmo/Trafficnetwork`**. Der Link steht zusätzlich in der Fußzeile jeder Seite, zusammen mit Lizenz und Versionsnummer. **Hinweis:** Das Repo ist derzeit privat, der Link führt für Fremde ins Leere — die Adresse trotzdem an genau einer Stelle konfigurierbar halten (`PROJECT_REPO_URL`), damit sie bei einer Veröffentlichung oder einem Fork leicht zu ändern ist.

---

## 4. TESTS

- Unit: Formatierung (Restlaufzeit, Einheiten), Filterlogik, Sprachumschaltung.
- Integration/E2E in CI (z. B. Playwright, headless): Seite lädt gegen einen echten Server, Karte rendert (ohne echte Kachel-Abrufe — Kachelanfragen im Test abfangen), Meldung absetzen erscheint auf der Karte, zweite Browsersitzung sieht sie per Live-Aktualisierung, Bestätigen funktioniert, Blitzer-Kategorien fehlen bei ausgeschaltetem Flag vollständig, `WEB_UI_ENABLED=false` liefert die Seite nicht mehr aus, API bleibt davon unberührt.
- Prüfen: keine externen Anfragen außer den Kacheln (im Test nachweisen), Seite funktioniert ohne Standortfreigabe.

---

## 5. NICHT-ZIELE

- Kein Benutzerkonto, kein Login, keine Profile.
- Keine Route­nplanung, keine Navigation, keine Sprachausgabe.
- Keine Verwaltungs- oder Moderationsoberfläche für Betreiber (kann später kommen).
- Kein Aktivieren des Blitzer-Namensraums.
- Keine Änderungen an `client-lib/` oder `ingestion/`; fehlende Server-Endpunkte melden statt heimlich Sonderwege bauen.

---

## 6. MEILENSTEINE

| # | Inhalt |
|---|---|
| W0 | Stand geprüft, Entscheidungen aus Abschnitt 2 mit Beleg (besonders Kachel-Nutzungsbedingungen und Besucher-Identität), Seitenentwurf, Plan vorgelegt |
| W1 | Auslieferung durch den Server (`WEB_UI_ENABLED`), Grundgerüst, Fußzeile mit GitHub-Link und Lizenz, zwei Sprachen |
| W2 | Karte mit Meldungen und Tempolimit-Abfrage, Filter, Live-Aktualisierung |
| W3 | Melden und Bestätigen inkl. Begrenzungen, ehrlicher Rückmeldung und Standortfreigabe |
| W4 | Seiten „Verbinden" und „Über das Projekt" inkl. Netzwerkstatus und `curl`-Beispielen |
| W5 | E2E-Tests grün, Doku (`server/docs/web-ui.md`: Betrieb, Konfiguration, Kachelwahl), Screenshots im PR — **Abschluss**, Pull Request |

---

## 7. WAS ICH VOR DEM CODE ERWARTE

1. Kurzbericht: Ist F gemergt, CI grün, welche Endpunkte stehen wirklich?
2. Entscheidungen zu Abschnitt 2 mit Begründung und Beleg — vor allem, wie Browser-Meldungen authentifiziert und begrenzt werden, ohne Geheimnis im Quelltext.
3. Grober Seitenentwurf (Aufbau der drei Seiten, mobil und am Desktop).
4. Liste offener Fragen an mich.
