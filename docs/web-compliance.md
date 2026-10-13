# Weboberfläche — Prüfung auf Recht und Zugänglichkeit

Stand: 2026-10-11 (Server 1.1.0, Block 6 des Oktober-Sammelauftrags). Geprüft wurde die eingebaute Weboberfläche (`server/web`, Seiten Karte, Verbinden, Über das Projekt und die neuen Seiten Datenschutz, Nutzungsbedingungen, Impressum).

> **Das ist keine Rechtsauskunft.** Es ist eine belegte Prüfung dessen, was die Seite tatsächlich tut, und eine Liste von Entwürfen zur anwaltlichen Durchsicht. Die Entwürfe (`/privacy`, `/terms`) sind auf der Seite selbst als Entwurf gekennzeichnet. Rechtlich bindend wird nichts, bevor der Betreiber es geprüft und freigegeben hat. `docs/privacy.md` (die Datenschutzerklärung des Projekts) liegt weiterhin beim Betreiber und wurde nicht angefasst.

**Methode.** (1) Automatisiert: axe-core (WCAG 2.0/2.1/2.2 A und AA) auf jeder Seite in Hell und Dunkel und auf den neuen Zuständen, ein Netzwerkmitschnitt je Seite, eine Inventur des Browser-Speichers — alles als Playwright-Tests in `server/e2e/compliance.spec.ts` und `server/e2e/pages.spec.ts`, die in der CI laufen. (2) Von Hand: Durchsicht aller Texte (`web/public/assets/i18n/*.js`, die Seiten), des Codes auf Speicherzugriffe und Netzwerkaufrufe, der ausgelieferten Dateien auf Fremdinhalte. **Nicht durchgeführt:** ein Test mit einem echten Screenreader (NVDA, VoiceOver, TalkBack) und eine Prüfung durch eine Fachstelle für Barrierefreiheit — siehe „Bei mir".

## Ergebnis je Prüfpunkt

| Prüfpunkt | Befund | Beleg | Behoben | Bei mir |
|---|---|---|---|---|
| **Farbkontrast** (WCAG 2.2 AA) | Alle Seiten und die neuen Zustände (Meldeformular mit Fehler, Tempolimit-Formular, Telefon mit offenem Blatt und Detail) bestehen axe in Hell und Dunkel ohne Verstoß. Kartenfarben tragen nie allein die Information: Meldungen haben Symbol **und** Text in der Liste, Straßenfarben haben eine Legende mit Zahlenwerten und die Abfrage liefert den Wert als Text (Tipp, oder die Schaltfläche „Tempolimit an der Kartenmitte abfragen“ per Tastatur). | `compliance.spec.ts` („accessibility … every page … light/dark“, „new states“) | ja | nein |
| **Alternativtexte** | Es gibt keine inhaltstragenden Bilder: Symbole sind eingebettetes SVG mit `aria-hidden` und stehen immer neben Text oder an einer Schaltfläche mit Namen; Kartenkacheln tragen leeres `alt`. Kartenelemente haben eine textliche Entsprechung: die Liste „Meldungen in diesem Ausschnitt“ (Kategorie, Alter, Restlaufzeit, „Auf der Karte zeigen“). | axe (`image-alt`, `button-name`, `role-img-alt`) ohne Verstoß; Code-Durchsicht | ja | nein |
| **Barrierefreiheit** (Tastatur, Fokus, Reihenfolge, Zoom) | Vollständig per Tastatur bedienbar: Seiten-Navigation, Karte (Pfeile, +/−), Meldeformular, Tempolimit-Formular, unteres Blatt (Pfeile/Home/End/Escape). Fokus immer sichtbar, Reihenfolge: Sprunglink, Kopf, Inhalt, Fußzeile. Reflow ohne waagerechtes Scrollen bei 320 px; bei 200 % Zoom und doppelter Schrift bleibt nichts abgeschnitten. Die Listenansicht der Meldungen ist die Alternative zur Karte. **Behoben beim Prüfen:** die Tabelle der Rechtsseite lief bei 320 px über. | `compliance.spec.ts` („keyboard and zoom“), `pages.spec.ts` | ja | **Screenreader-Test mit echten Geräten steht aus** |
| **Klare Schaltflächen** | Jede Schaltfläche hat Text oder einen programmatischen Namen (`aria-label`/`title` in der Seitensprache): Standort („Auf mich zentrieren“, mit Zustand), Kategorien und Ebenen, Vergrößern/Verkleinern, Ziehgriff des Blatts („Detailfenster, klein …“), Schließen. Reine Symbole ohne Namen gibt es nicht. | axe (`button-name`); Tests in `mobile.spec.ts` (`toHaveAccessibleName`) | ja | nein |
| **Formulare** | Tastaturbedienbar, Fehler in Worten und per `role=alert` mit Fokus auf dem Feld; **nur notwendige Daten**: Art, Stelle, Dauer (Meldung), Wert, Einheit, Richtung, Grund (Tempolimit) — keine Freitextfelder, keine Namen, keine E-Mail. Offen: Pflichtfelder sind nicht mit einem Stern markiert; da jedes Feld Pflicht ist und die Fehlermeldung das fehlende Feld nennt, wurde es nicht ergänzt. | `duration-and-limits.spec.ts`, Code-Durchsicht | teilweise | nein |
| **Einwilligung im Formular** | Vor dem Absenden steht, was gesendet wird (Stelle, Art, Dauer; IP-Adresse technisch bedingt; Zeitpunkt und zufällige Sitzungskennung kommen vom Knoten dazu; öffentlich sichtbar) mit Link zu den Datenschutzhinweisen. Der Standort wird nur auf ausdrückliche Handlung abgefragt (Zähltest: 0 Aufrufe vor dem Knopfdruck). | `compliance.spec.ts` („the report form tells what is sent“), `map.spec.ts` | ja | Wortlaut prüfen lassen |
| **Datenschutzerklärung** | Seite `/privacy` (Deutsch und Englisch), aus jeder Seite und dem Formular verlinkt; **Entwurf aus den tatsächlichen Datenflüssen**: Zugriffsprotokoll (mit/ohne Datenschutzmodus), IP nur im Arbeitsspeicher für Ratenbegrenzung, anonyme Sitzung nur im Speicher der Seite, Kartenausschnitt wird an den Knoten gesendet (**auch beim Folgen des Standorts** — ausdrücklich genannt), Meldungen sichtbar und nach Ablauf noch `EVENT_LOG_RETENTION_DAYS_DYNAMIC` Tage gehalten, Kacheln vom Kachelserver, „Online“-Zähler, Browser-Speicher, Rechtsgrundlagen (Entwurf), Rechte. Nicht Teil des Entwurfs: Rechtsgrundlagen jenseits der Skizze, Auftragsverarbeitung, Drittlandübermittlung — hängt vom Hosting ab. | `compliance.spec.ts` („legal pages“) | Entwurf ja | **rechtliche Prüfung und Freigabe; `docs/privacy.md`** |
| **Nutzungsbedingungen** | Seite `/terms` als **Entwurf** gekennzeichnet: Zweck, Sicherheit/Fahrt, Angaben sind Hinweise ohne Gewähr, Regeln für Meldungen/Korrekturen, Blitzer-Hinweis, Haftung (nur Skizze), Quellen, Verweis auf Datenschutz und Impressum. Kein Kauf, keine Rückerstattung. | `compliance.spec.ts` | Entwurf ja | **rechtliche Prüfung, besonders „Haftung“** |
| **Betreiberangaben / Impressum** | Seite `/imprint` liest `OPERATOR_NAME`, `OPERATOR_ADDRESS`, `OPERATOR_EMAIL` (und optional `OPERATOR_PHONE`, `OPERATOR_REPRESENTATIVE`, `OPERATOR_REGISTER`, `OPERATOR_VAT_ID`) aus der Konfiguration. **Nichts ist erfunden:** fehlen Name, Anschrift oder E-Mail, sagt die Seite es deutlich, die Datenschutzseite ebenso, und der Knoten schreibt beim Start eine Warnung ins Protokoll. | `compliance.spec.ts` („imprint shows exactly …“, „has not entered anything“), `web-config.test.ts` | ja | **Betreiberangaben eintragen (ohne sie ist die Seite nicht öffentlich betreibbar)** |
| **Cookies und lokaler Speicher** | Inventur: **keine Cookies**, kein `sessionStorage`, keine IndexedDB, kein Cache-Speicher. `localStorage` nur mit drei Schlüsseln: `tn-lang` (Sprachwahl, erst wenn der Besucher umschaltet), `tn.filters.v1` (gewählte Kategorien), `tn.cameraNotice.v1` (Blitzer-Hinweis gesehen). Das Token der anonymen Sitzung liegt nur im Arbeitsspeicher. **Bewertung (konservativ):** alle drei werden nur auf ausdrückliche Handlung des Besuchers geschrieben und dienen genau dem von ihm gewählten Dienst (Sprache, Filter) bzw. dem Verzicht auf Wiederholung eines Hinweises; das fällt nach unserer Lesart unter § 25 Abs. 2 Nr. 2 TDDDG (unbedingt erforderlich für einen vom Nutzer ausdrücklich gewünschten Dienst). **Ein Banner ist deshalb nicht eingebaut**; die Information steht in der Datenschutzseite (Abschnitt 7). Würde der Betreiber später etwas Nichtnotwendiges speichern, wäre ein Banner mit gleichwertigem „Ablehnen“ nötig. | `compliance.spec.ts` („storage inventory“) | ja | **Bewertung bestätigen lassen** |
| **Tracking** | Keine Analyse, keine Werbung, keine Pixel, keine externen Skripte. **Als Test:** auf jeder Seite verlässt keine Anfrage den Knoten außer an den konfigurierten Kachelserver; kein CSP-Verstoß; keine Konsolenfehler. Die CSP ist `default-src 'none'`, Skripte/Stile/Schriften/Verbindungen nur vom Knoten selbst. | `compliance.spec.ts` („nobody but the node is contacted“), `pages.spec.ts` (CSP), `web-static.test.ts` („no third-party URLs“) | ja | nein |
| **Straßendatendienst (vom Knoten, nicht vom Browser)** | Für ein Tempolimit zwischen zwei Stellen fragt der **Knoten** bei Bedarf einen Straßendatendienst (`ROAD_LOOKUP_URL`, Standard öffentliche Overpass-Instanz, `none` = nie) nach den Straßen des Gebiets. Der Dienst erhält das Gebiet und die Adresse des Knotens, nicht die IP-Adresse des Besuchers. Datenschutzseite (Abschnitt 8), Über-Seite und `docs/privacy.md` nennen es; die Seite im Browser verbindet sich weiterhin nur mit dem Knoten (und dem Kachelserver). | `web-ui.test.ts` (`roadLookupHost`), `compliance.spec.ts` | ja | **Betrieb einer eigenen Overpass-Instanz oder `none`** |
| **Drittanbieter-Einbettungen** | Genau ein externer Host: der **Kachelserver** (Standard `tile.openstreetmap.org`, einstellbar mit `MAP_TILE_URL`, abschaltbar mit `none`). Jede Kachelanfrage gibt die IP des Besuchers und den Kartenausschnitt an diesen Anbieter; das steht in Datenschutzseite (Abschnitt 8), Über-Seite und `docs/web-ui.md`. Schriften: Systemschriften, nichts geladen. Symbole: eigene SVG. Leaflet und h3-js werden **vom Knoten selbst** ausgeliefert (vendored). | wie „Tracking“; `web-static.test.ts` | ja | **Wahl der Kartenquelle; eigene PMTiles/Kacheln hosten (Ziel)** |
| **Urheberrecht von Bildern** | Siehe Liste unten: nur eigene Grafiken und zwei frei lizenzierte Bibliotheken. Namensnennung „© OpenStreetMap contributors“ steht auf der Karte und auf der Über-Seite. | Liste unten | ja | nein |
| **Bewertungen / Rückerstattung** | Gibt es nicht und wurde nicht erfunden: keine Bewertungen, Zitate oder „Nutzerstimmen“. Die Seite ist kostenlos, verkauft nichts; eine Rückerstattungsseite entfällt (die Nutzungsbedingungen sagen es in einem Satz). | Durchsuchen der Seiten und Texte | ja (entfällt) | nein |
| **Behauptungen ohne Beleg** | Texte durchsucht nach „Echtzeit“, „genau“, „sicher“, „vollständig“, „Europa“, „garantiert“, Zahlen: keine Zusicherung gefunden. **Geändert:** die Datenschutz-Kurzfassung sagte, eine Meldung werde „für die Dauer ihrer Gültigkeit“ gespeichert — sie bleibt nach Ablauf noch kurz (Standard 3 Tage) und wird dann gelöscht; die Datenquellen-Angabe nannte nur OpenStreetMap, obwohl Baustellen aus amtlichen Quellen kommen können (jetzt mit Namensnennung der Quellen, aber ohne Behauptung, welche dieser Knoten nutzt). „Live“ bedeutet nur „WebSocket-Verbindung steht“ und wechselt bei Abbruch auf „Live-Aktualisierung unterbrochen“. Die „online“-Zahl ist als geschätzt/„weniger als N“ gekennzeichnet. Keine Nutzer- oder Meldungszahlen als Werbeaussage. | Durchsicht der Wörterbücher | ja | nein |
| **Örtliches Recht (Deutschland)** | Geprüft und benannt: Anbieterkennzeichnung (§ 5 DDG; Seite `/imprint`, Angaben beim Betreiber), DSGVO-Informationspflichten (Art. 13; `/privacy` als Entwurf), Zugriff auf Endgeräte (§ 25 TDDDG; Inventur oben), Hinweise zu Blitzer-Warnungen (§ 23 Abs. 1b StVO; Hinweis auf Über-Seite und in den Nutzungsbedingungen, Kategorien standardmäßig aus). **Entschieden wurde nichts:** siehe offene Rechtsfragen. | — | — | **Beratung** |

## Inventur

### Was der Browser speichert

| Ort | Schlüssel | Zweck | Dauer | Notwendig? |
|---|---|---|---|---|
| localStorage | `tn-lang` | Sprachwahl | bis der Besucher löscht | vom Besucher gewählt (er schaltet um) |
| localStorage | `tn.filters.v1` | gewählte Kategorien | bis der Besucher löscht | vom Besucher gewählt |
| localStorage | `tn.cameraNotice.v1` | Blitzer-Hinweis gesehen | bis der Besucher löscht | damit der Hinweis nicht jedes Mal kommt |
| Arbeitsspeicher | Token der anonymen Sitzung | Lesen/Melden | `WEB_SESSION_TTL_SECONDS` (Standard 15 min), Tab zu = weg | technisch erforderlich |

Keine Cookies, kein `sessionStorage`, keine IndexedDB, kein Service-Worker-Cache (alles geprüft im Test).

### Externe Hosts

| Host | Wofür | Was er sieht |
|---|---|---|
| Kachelserver (`MAP_TILE_URL`, Standard `tile.openstreetmap.org`) | Kartenhintergrund | IP des Besuchers, Kartenausschnitt (Kachelnummern), Herkunft = Adresse des Knotens (`Referrer-Policy: strict-origin-when-cross-origin`) |
| GitHub (nur Link in der Fußzeile und auf der Über-Seite, vom Besucher angeklickt) | Projektseite | erst nach Klick, mit `rel=noopener noreferrer` |

Sonst nichts: kein CDN, keine Schriften, keine Symbolbibliothek, keine Analyse.

### Bilder, Symbole, Schriften, Bibliotheken

| Was | Herkunft | Lizenz |
|---|---|---|
| `favicon.svg`, alle Symbole der Oberfläche (Pfeil, Ebenen, Meldungs-Symbole, Achsenbilder) | eigene Grafiken, im Quelltext | Apache License 2.0 (Teil des Projekts) |
| Schrift | Systemschrift des Geräts, keine Webschrift | — |
| Leaflet 1.9.4 (Kartenbibliothek, mit seinen Bildern `layers.png`, `marker-*.png`, die die Seite nicht verwendet) | vom Knoten ausgeliefert | BSD-2-Clause |
| h3-js 4.5.0 | vom Knoten ausgeliefert | Apache-2.0 |
| Kartendaten und -kacheln | konfigurierter Anbieter | OpenStreetMap-Daten: ODbL, „© OpenStreetMap contributors“ sichtbar; die Nutzungsbedingungen des Kachelservers gelten (`docs/web-ui.md`, „Map tiles“) |

## Offene Rechtsfragen (für die Beratung — nicht selbst entschieden)

1. **Impressum:** welche Angaben für diesen Betreiber genau nötig sind (Privatperson, Verein, Gesellschaft; Telemedien-Kontakt „schnell erreichbar“; Vertretungsberechtigte; Registernummer/USt-IdNr.), und ob ein Impressum auch für einen Knoten ohne wirtschaftliche Absicht verlangt wird.
2. **Datenschutz:** Wer ist Verantwortlicher, wenn mehrere Knoten föderiert sind? Brauchen Betreiber einen Vertrag untereinander? Ist die IP-Adresse beim Kachelserver ein Fall für eine Einwilligung statt berechtigtem Interesse, solange die Kacheln von Dritten kommen (Alternative: eigene Kacheln)? Löschfristen (`EVENT_LOG_RETENTION_DAYS_DYNAMIC`) angemessen?
3. **TDDDG:** trägt die Einordnung der drei Speicherschlüssel als „unbedingt erforderlich“ — vor allem `tn.filters.v1` und `tn.cameraNotice.v1` — oder braucht es eine Einwilligung/ein Banner?
4. **Haftung für Nutzermeldungen** (Hostprovider-Privileg, Melde- und Abhilfeverfahren nach DSA für Online-Plattformen, Kleinstunternehmen-Ausnahme) und ob die Seite ein „Vermittlungsdienst“ ist.
5. **Blitzer-Warnungen:** ob und in welchen Ländern die Anzeige der Kategorie, auch ausgeschaltet als Voreinstellung, zulässig ist (steht schon auf der Betreiberliste unter „Blitzer-Politik“), und wie der Hinweistext lauten soll.
6. **Barrierefreiheit:** ob für dieses Angebot gesetzliche Pflichten gelten (BFSG betrifft bestimmte Produkte und Dienstleistungen für Verbraucher; BITV gilt für öffentliche Stellen) und welcher Nachweis dann nötig ist (Konformitätserklärung, Feedback-Mechanismus).
7. **Nutzungsbedingungen:** Wirksamkeit, Haftungsausschluss, anwendbares Recht, ob für eine kostenlose Seite überhaupt ein Vertrag zustande kommt.
8. **Länderbesonderheiten** bei Betrieb oder Nutzung außerhalb Deutschlands (z. B. Schweiz, Österreich).

## Bei mir (Betreiber)

- **Betreiberangaben fürs Impressum** eintragen: `OPERATOR_NAME`, `OPERATOR_ADDRESS`, `OPERATOR_EMAIL` (Pflicht für einen öffentlichen Knoten) und was zutrifft von `OPERATOR_PHONE`, `OPERATOR_REPRESENTATIVE`, `OPERATOR_REGISTER`, `OPERATOR_VAT_ID`. Solange sie fehlen, steht das auf der Impressumsseite und im Start-Protokoll.
- **Rechtliche Prüfung der Entwürfe** `/privacy` und `/terms` (Texte in `server/web/public/pages/`), danach den Entwurfshinweis streichen.
- `docs/privacy.md` (Datenschutzerklärung des Projekts) fertigstellen.
- **Wahl der Kartenquelle** und Hosting eigener Kacheln/PMTiles; bis dahin gilt die Nutzungsrichtlinie des OSM-Kachelservers, die für einen Knoten mit echtem Verkehr nicht gedacht ist.
- **Screenreader-Test** (NVDA/VoiceOver/TalkBack) oder eine Prüfung durch eine Fachstelle.
- Bestätigen, dass kein Cookie-Banner nötig ist (Punkt „Cookies und lokaler Speicher“).
