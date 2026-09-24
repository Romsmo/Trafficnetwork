# Zusatz-Prompts — Anzeige „aktuell online" (Server, Weboberfläche, Client-Bibliothek)

> **Wunsch des Betreibers:** Die Weboberfläche zeigt unten rechts, wie viele Nutzer gerade online sind. Dieselbe Zahl ist über die API abrufbar.
>
> Dieses Dokument enthält **drei kleine Zusatz-Aufträge** — einen pro Arbeitsbereich. Jeder ist rein additiv: kein Umbau bestehender Funktionen, keine geänderten Antworten bestehender Endpunkte.
>
> **Reihenfolge:** erst Server (A), dann Weboberfläche (B); die Client-Bibliothek (C) ist unabhängig davon und optional.

---

## Gemeinsame Leitplanken (gelten für alle drei)

- **Nur Zahlen, keine Personen.** Keine Speicherung von IP-Adressen, Kennungen oder Positionen für diese Funktion. Es wird gezählt, nicht protokolliert.
- **Schwellenwert gegen Rückschlüsse:** Liegt die Zahl unter einem konfigurierbaren Mindestwert (Vorschlag: 5), wird „weniger als 5" ausgegeben statt der genauen Zahl. In einem kleinen Netz wäre „1 Nutzer online" sonst eine Aussage über eine einzelne Person.
- **Fremde Zahlen sind Behauptungen.** Im föderierten Netz meldet jeder Knoten seine eigene Zahl selbst. Ein bösartiger Knoten kann lügen. Die netzweite Summe wird deshalb als **geschätzt** gekennzeichnet, und es zählen nur Knoten mit ausreichender Reputationsstufe.
- **Billig und begrenzt:** Die Zahl wird im Speicher geführt und serverseitig zwischengespeichert (Vorschlag: 10 Sekunden). Keine zusätzliche Datenbanktabelle, wenn es ohne geht; keine Abfrage, die mit vielen Nutzern teuer wird.
- **Abschaltbar:** `ONLINE_COUNTER_ENABLED` (Standard: an). Aus bedeutet: Endpunkt meldet, dass die Funktion aus ist, die Oberfläche blendet die Anzeige aus.

---

## A — Server (Chat „Trafficnetwork Backend", Branch `feature/online-counter`)

**Auftrag:** Zähle, wie viele Clients aktuell an diesem Knoten hängen, und liefere die Zahl — zusammen mit einer geschätzten netzweiten Summe — über einen neuen, öffentlichen Endpunkt aus.

1. **Was zählt als „online"?** Deine Entscheidung mit Begründung im Plan. Ausgangspunkt: bestehende WebSocket-Verbindungen (die Registrierung dafür gibt es schon) **plus** optional Clients, die innerhalb eines konfigurierbaren Fensters (Vorschlag: 5 Minuten) eine Sync- oder Schreibanfrage gemacht haben, damit reine Polling-Clients nicht unsichtbar sind. Mehrfachverbindungen desselben Geräts dürfen nicht doppelt zählen.
2. **Neuer Endpunkt** (öffentlich, ohne Auth, gleiche Rate-Limits wie andere öffentliche Leseendpunkte), Vorschlag:
   `GET /v1/stats/online` →
   ```json
   { "node": { "online": 12, "windowSeconds": 300 },
     "network": { "online": 87, "nodes": 4, "estimated": true, "asOf": "..." },
     "minDisplayThreshold": 5 }
   ```
   Unterhalb des Schwellenwerts wird die Zahl nicht exakt ausgegeben (z. B. `"online": null, "below": 5`) — Format ist deine Entscheidung, Hauptsache eindeutig und dokumentiert.
3. **Netzweite Summe:** Die eigene Zahl reist in den ohnehin vorhandenen signierten Heartbeats mit; die Summe bildet sich aus den zuletzt gemeldeten Zahlen der bekannten Knoten. Knoten in der Probezeit oder mit veraltetem Heartbeat fließen nicht ein. Läuft der Knoten ohne Föderation, entfällt `network` bzw. entspricht dem eigenen Wert.
4. **Doku:** `server/docs/api.md` um den Endpunkt ergänzen, `server/docs/federation-protocol.md` um das neue Heartbeat-Feld, `.env.example` um die neuen Variablen.
5. **Tests:** Zähler steigt und fällt mit Verbindungen, Doppelverbindungen zählen einmal, Schwellenwert greift, abgeschaltete Funktion antwortet sauber, netzweite Summe im Mehrknoten-Test, veralteter Heartbeat fällt heraus.

**Nicht-Ziele:** keine Historie, keine Statistikseite, keine Zählung pro Region, kein Tracking einzelner Geräte.

---

## B — Weboberfläche (Chat der Weboberfläche, Branch `feature/server-web-ui`)

**Auftrag:** Zeige die Zahl aus `GET /v1/stats/online` **unten rechts** auf jeder Seite an.

1. Kleine, dezente Anzeige unten rechts, z. B. „🟢 12 online" mit Titel/Tooltip: eigener Knoten und geschätzte Zahl im Netzwerk. Auf dem Handy nicht störend, nicht über Bedienelementen der Karte.
2. Aktualisierung alle 30 Sekunden (oder über die bestehende WebSocket-Verbindung, wenn das ohne Zusatzlast geht). Bei Fehler oder abgeschalteter Funktion: Anzeige verschwindet still, keine Fehlermeldung.
3. Unter dem Schwellenwert: „weniger als 5 online" statt einer Zahl. Netzweite Zahl immer als geschätzt kennzeichnen.
4. Zugänglich: Text lesbar für Screenreader, ausreichender Kontrast, kein reines Farbsignal; die Anzeige darf keine Layoutsprünge verursachen.
5. Test: Anzeige erscheint mit Zahl, verschwindet bei abgeschalteter Funktion, zeigt unter dem Schwellenwert den Textfall.

**Voraussetzung:** Teil A ist gemergt — sonst gibt es den Endpunkt nicht. Vorher nur gegen einen Mock bauen und das kennzeichnen.

---

## C — Client-Bibliothek (Chat „Client-Sync-Bibliothek", optional, Branch `feature/online-counter`)

**Auftrag:** Mach die Zahl auch für Host-Apps verfügbar.

1. `getNetworkStatus()` um Felder ergänzen: `onlineNode`, `onlineNetwork`, `onlineEstimated`, `onlineAsOf` (Namen final im Plan). Werte kommen aus `GET /v1/stats/online` des gerade genutzten Knotens, lokal zwischengespeichert (Vorschlag: 30 Sekunden), nie blockierend.
2. Rein additiv: bestehende Felder und Signaturen bleiben unverändert, kein Major-Versionssprung. Ältere Server ohne den Endpunkt: Felder bleiben leer, kein Fehler.
3. Die Bibliothek sendet dafür **nichts Zusätzliches** — ein Gerät zählt ohnehin als online, solange es verbunden ist.
4. Tests: Felder werden befüllt, fehlender Endpunkt führt nicht zum Fehler, Zwischenspeicher wird beachtet.
