# Datenschutzhinweis für die Weboberfläche eines Knotens / Privacy notice for a node's web UI

> **Entwurf / Draft.** Dieses Dokument beschreibt, was die Software beim Aufruf der Weboberfläche technisch tut. Es ist
> **keine Rechtsberatung** und ersetzt nicht die Datenschutzerklärung des Betreibers eines Knotens: Wer einen Knoten
> öffentlich betreibt, ist selbst Verantwortlicher und muss eine eigene Erklärung mit seinen Angaben (Name, Kontakt,
> Rechtsgrundlagen, Hosting, Speicherfristen) bereitstellen und die Software entsprechend seiner Konfiguration prüfen.
> *This describes what the software does technically. It is not legal advice and does not replace the notice of whoever
> operates a node, who is the data controller and needs their own notice.*

Stand / as of: 2026-09-24 · gilt für / applies to `server/web` (Weboberfläche, `WEB_UI_ENABLED=true`)

## Deutsch

### Was die Seite technisch tut

* **Kein Konto, keine Anmeldung, keine Cookies, kein Tracking, keine Analyse-Dienste, keine externen Schriftarten oder Skripte.**
* Gespeichert wird im Browser nur die gewählte **Sprache** (`localStorage`, Schlüssel `tn-lang`).
* Beim Öffnen der Karte erhält der Browser eine **anonyme, zufällige Sitzung** (ein Token, das nur im Arbeitsspeicher der Seite
  liegt und nach kurzer Zeit — standardmäßig 15 Minuten — verfällt). Sie ist nicht mit früheren Sitzungen oder mit dir
  verknüpft und wird nicht in der Datenbank gespeichert.
* **Standort:** Die Seite fragt deinen Standort **nur**, wenn du selbst eine Schaltfläche dafür drückst („Mein Standort“,
  „Meinen Standort verwenden“); der Browser fragt dann zusätzlich um Erlaubnis. Er wird einmalig verwendet, nie im Hintergrund,
  und nicht gespeichert. Alles funktioniert auch ohne.
* **Meldungen:** Gespeichert werden die Stelle (Koordinaten) der Meldung, ihre Art, Zeitpunkte und eine zufällige Kennung der
  anonymen Sitzung. Meldungen sind für alle Besucher des Knotens sichtbar, aber nicht mit dir verknüpft; die Kennung wird
  Besuchern nicht ausgeliefert. Meldungen von Browsern bleiben auf dem Knoten und werden **nicht** an andere Knoten weitergegeben.
  Abgelaufene Meldungen werden nach der Aufbewahrungsfrist (`EVENT_LOG_RETENTION_DAYS_DYNAMIC`, Standard 3 Tage) gelöscht.
* **IP-Adresse:** Sie wird kurz im Arbeitsspeicher gezählt (Missbrauchsbegrenzung, Fenster bis zu einer Stunde) und nicht in
  der Datenbank gespeichert. Die **Zugriffsprotokolle** des Knotens enthalten standardmäßig weder Koordinaten (Query-String) noch
  IP-Adressen (`LOG_PRIVACY_MODE=true`). Ein vorgeschalteter Webserver/Proxy des Betreibers kann eigene Protokolle führen.
* **Anzeige „online“ (nur wenn der Knoten sie anbietet):** Die Seite ruft alle 30 Sekunden eine öffentliche Zählung ab (`GET /v1/stats/online`, ohne Token und ohne Cookie). Es wird nur gezählt: dafür werden keine Personen, Adressen, Kennungen oder Standorte gespeichert; unter einem Mindestwert wird „weniger als N“ statt einer Zahl ausgegeben. Die Zahl für das Netzwerk beruht auf Angaben anderer Knoten und ist eine ungeprüfte Schätzung.
* **Kartenkacheln:** Dein Browser lädt die Kacheln **direkt vom konfigurierten Kartenserver** (Standard:
  `tile.openstreetmap.org`, betrieben von der OpenStreetMap Foundation). Dieser sieht deine IP-Adresse, deinen Browser und den
  angezeigten Kartenausschnitt und unterliegt seiner eigenen Datenschutzerklärung. Betreiber können einen anderen Kartenserver
  einstellen oder die Karte ganz abschalten (`MAP_TILE_URL=none`).
* **Externe Links** (z. B. zum GitHub-Projekt) öffnen sich in einem neuen Tab ohne Übermittlung der Adresse des Knotens
  (`noreferrer`); ab dann gilt die Erklärung der Zielseite.

### Was der Betreiber ergänzen muss

Name und Kontakt des Verantwortlichen, ggf. Datenschutzbeauftragte, Rechtsgrundlagen, Hosting-Anbieter und Serverstandort,
Angaben zu Protokollen von Reverse-Proxy/CDN/Firewall, Rechte der Betroffenen und Beschwerdemöglichkeit, sowie — sofern
der Betreiber den Geschwindigkeitskontroll-Bereich aktiviert — die dafür nötigen rechtlichen Hinweise (siehe `docs/concept.md`,
Abschnitt 8).

## English

### What the page does technically

* **No account, no sign-in, no cookies, no tracking, no analytics, no external fonts or scripts.**
* The browser only stores the chosen **language** (`localStorage`, key `tn-lang`).
* Opening the map gives your browser an **anonymous, random session** (a token held only in the page's memory that expires
  after a short time — 15 minutes by default). It is not linked to earlier sessions or to you and is not stored in the database.
* **Location:** the page asks for your location **only** if you press a button for it ("My location", "Use my location"); the
  browser then asks for permission as well. It is used once, never in the background, and not stored. Everything works without it.
* **Reports:** what is stored is the spot (coordinates) of the report, its type, times and a random identifier of the anonymous
  session. Reports are visible to every visitor of the node but not linked to you; the identifier is not sent to visitors.
  Reports made in a browser stay on the node and are **not** passed on to other nodes. Expired reports are deleted after the
  retention period (`EVENT_LOG_RETENTION_DAYS_DYNAMIC`, default 3 days).
* **IP address:** counted briefly in memory for abuse limiting (window of up to one hour), not stored in the database. The
  node's **access logs** contain neither coordinates (query string) nor IP addresses by default (`LOG_PRIVACY_MODE=true`). A web
  server/proxy in front of the node may keep its own logs.
* **"Online" display (only if the node offers it):** the page reads a public count every 30 seconds (`GET /v1/stats/online`, no token, no cookie). It only counts: no people, addresses, identifiers or locations are stored for it; below a minimum the page says "fewer than N" instead of a number. The network figure rests on what other nodes report and is an unverified estimate.
* **Map tiles:** your browser loads tiles **directly from the configured tile server** (default `tile.openstreetmap.org`,
  operated by the OpenStreetMap Foundation). It sees your IP address, browser and the map area shown and is subject to its own
  privacy policy. Operators can configure another tile server or switch the map background off (`MAP_TILE_URL=none`).
* **External links** (e.g. to the GitHub project) open in a new tab without sending the node's address (`noreferrer`); the
  target site's own policy applies from there.

### What the operator has to add

Name and contact of the controller, data protection officer if any, legal bases, hosting provider and server location,
information on reverse-proxy/CDN/firewall logs, data subject rights and the right to complain — and, if the operator enables
the speed-camera namespace, the legal notices that requires (see `docs/concept.md`, section 8).
