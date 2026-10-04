# Offene Punkte

Nur noch, was wirklich offen ist. Was erledigt ist, steht im [`CHANGELOG.md`](../CHANGELOG.md), die Belege dafür in [`docs/audit.md`](audit.md) und [`docs/final-report.md`](final-report.md). Der Ursprungsplan und die Begründung der Architektur stehen in [`docs/concept.md`](concept.md) und [`docs/federation.md`](federation.md).

Der Code gibt von sich aus nichts frei, was rechtlich entschieden werden muss: Wo unten „Betreiber" steht, ist es eine Entscheidung oder Handlung, die nur du treffen oder ausführen kannst.

## 1. Beim Betreiber — verhindert einen öffentlichen Start

- [ ] `docs/privacy.md` (DSGVO) fertigstellen und rechtlich prüfen lassen — Geräteregistrierung, Positions-Tiles, Föderation („Daten werden über Server Dritter verteilt"), Weboberfläche
- [ ] Betreiberbedingungen für Server-Betreiber (wer föderiert beitreten darf, unter welchen Bedingungen) schreiben und prüfen lassen
- [ ] Domain `trafficnetwork.info` registrieren und DNS betreiben (die eingebauten Seeds `seed1.`/`seed2.trafficnetwork.info` zeigen sonst ins Leere)
- [ ] Netzwerk-Wurzelschlüssel offline erzeugen und sicher verwahren (`server/scripts/network-generate-root-key.mts`, Anleitung in `server/docs/operating.md`)
- [ ] Mindestens zwei Seed-Server bei unterschiedlichen Anbietern bereitstellen
- [ ] Backups mit belegtem Wiederherstellungstest, Überwachung und Update-Weg für den öffentlichen Knoten einrichten
- [ ] Entscheiden, ab wann Repository und Container-Images (GHCR) öffentlich sind (beides ist derzeit privat)

## 2. Beim Betreiber — Blitzer-Politik

Ausgeliefert ist: Kategorien freigeschaltet, Standard `full` in jedem Land, Filter in Weboberfläche und Client-Bibliothek standardmäßig aus, Rechtshinweis beim Anhaken. Offen bleibt:

- [ ] Rechtliche Einschätzung je Land, vor allem Schweiz und Frankreich; danach entscheiden, welche Länder `zones` oder `off` bekommen
- [ ] Echten Grenzdatensatz laden (`npm run cameras -- load-boundaries …`, Natural Earth 1:10m) — die Tests, auch der Abschlussdurchstich, nutzen nur synthetische Rechtecke; **vor** der ersten Einschränkung laden
- [ ] Die Einschränkung mit dem Wurzelschlüssel signieren und auf den Knoten verteilen (`server/docs/operating.md`, „Camera policy")
- [ ] Wortlaut des Rechtshinweises freigeben (`cameraPolicy.notice`, Standardtext in `server/docs/camera-country-policy.md`)

## 3. Beim Betreiber — Daten und Quellen

- [ ] Autobahn-API-Lizenz bei der Autobahn GmbH/BMV erfragen; die Quelle (`de-autobahn`) bleibt bis dahin aus
- [ ] Lizenz von NDW (Niederlande) klären, danach `nl-ndw` einschalten
- [ ] Auf dem Knoten `tn-europe`: die 2.000 doppelt importierten Segmente entfernen (SQL im Europa-Bericht), dann `pg_dump` als Grundstock ziehen; danach das Server-Image dort starten (Migration `0007`/`0008` sperrt `speed_limit_segments` etwa 6 Minuten, siehe `server/docs/operating.md`)
- [ ] NVDB-Norwegen-Vollimport ausführen (`--region norway`, 20–40 min; auf einem Knoten mit den Europa-Daten nur mit `--allow-non-empty`)
- [ ] NVDB Schweden nur, wenn ein Lastkajen-Zugang samt Beispieldatei vorliegt
- [ ] Entscheiden, ob „alles auf jedem Gerät" für Europa so bleibt (Messung in `client-lib/docs/bootstrap-measurements.md` und `server/docs/europe-scale.md`)
- [ ] Entscheiden: Mapillary/KartaView einbinden? (nur nach belegter Lizenzprüfung, wäre standardmäßig aus)
- [ ] Baustellen-Dauerbetrieb einrichten: der Import ist gebaut, läuft aber nicht als wiederkehrender Lauf (`ingestion/docs/roadworks.md`; Frankreich an, Niederlande/Deutschland aus)

## 4. Entwicklung — bewusst zurückgestellt oder nie zugesagt

Server und Weboberfläche:

- [ ] `federationEventId` in Snapshot/Delta ausliefern (Voraussetzung für föderiertes Bestätigen/Widersprechen; heute sind Bestätigungen pro Knoten)
- [ ] Weboberfläche: „Stimmt nicht?"-Formular und Herkunftsanzeige für Tempolimit-Korrekturen (die Server-Pfade sind für Web-Sitzungen offen)
- [ ] Weboberfläche: Startansicht Europa, nur den sichtbaren Ausschnitt laden, Cluster bei kleiner Zoomstufe
- [ ] Weboberfläche: Quellen-Attribution aus `ingestion/docs/attribution.md` anzeigen (braucht `source_feed` in der Hazard-API)
- [ ] Weboberfläche: in sehr großen Ausschnitten (Hinweis „Ausschnitt sehr groß") kommen neue Meldungen erst mit dem Minutentakt statt live, weil die Push-Abos begrenzt sind (`WEB_WS_MAX_TILES_PER_CONNECTION`) — in `server/docs/web-ui.md` vermerkt, nicht behoben
- [ ] Tempolimit-Korrekturen: temporäre Korrekturen (Baustelle) automatisch auslaufen lassen; `deviceAssertion` bei Meldungen an den gebundenen Schlüssel knüpfen; Stimmen nach Ruf des weiterleitenden Knotens gewichten
- [ ] Dauerhafte Anlagen: Abschnittskontrolle (`enforcement=average_speed`) — erst entscheiden, dann bauen; ob Nutzer eine Meldung „dauerhaft" machen können (Schwelle) oder Nutzermeldungen immer verfallen; die acht Standardwerte aus `server/docs/persistent-enforcement-devices.md` §10 bestätigen oder ändern
- [ ] Blitzer nach Land: `GET /v1/config` nennt `staticDataVersion` sofort, das Manifest aber erst nach dem Neubau der Pakete — bei einem Knoten ohne statische Daten bewegt sich die Manifest-Version bei einem Politikwechsel nie (die Bibliothek fragt deshalb zusätzlich in kurzem Takt)
- [ ] Blitzer nach Land: das Land des *Fahrers* berücksichtigt weder Server noch Bibliothek (`server/docs/camera-country-policy.md`, Abschnitt 9)
- [ ] Unbenutzte Abhängigkeit `pino` in `server/package.json` entfernen (Fastify bringt sein eigenes Logging mit; kein direkter Import)

Client-Bibliothek:

- [ ] Pakete in Registern veröffentlichen (npm, Maven, pub.dev, CocoaPods) — jede Veröffentlichung ist eine eigene Freigabe; bis dahin `private` bzw. `publish_to: none`
- [ ] Kotlin/Android, Swift/iOS und React Native auf Emulator/Simulator/Gerät *ausführen* (heute: gebaut und gelinkt, Konformität auf JVM bzw. macOS; nur die Flutter-App läuft auf einem Android-Emulator)
- [ ] Das von `uniffi-bindgen-react-native` erzeugte JSI-Zwischenstück in einem Test ausführen
- [ ] Einen echten TLS-Handshake gegen einen Server mit gültigem Zertifikat testen (alle Tests laufen über `http://`; sinnvoll, sobald Domain und Seed-Server stehen)
- [ ] Flutter-Plugin auch für Desktop bündeln (heute Android und iOS)
- [ ] Die Bibliothek liest die Blitzer-Politik von dem Knoten, der `GET /v1/config` beantwortet — Knoten desselben Netzes mit unterschiedlichen lokalen Obergrenzen geben unterschiedliche Lesarten; „strengstes über alle Knoten" wäre eine eigene Entscheidung
- [ ] Gespeicherte Daten an die Knoten-Identität binden: wird ein Server unter derselben Adresse neu aufgesetzt, behält ein schon vorhandener lokaler Speicher alte statische Segmente (im Abschlussdurchstich beobachtet, siehe `docs/final-report.md`)
- [ ] `tools/test-client/` auf die Bibliothek umstellen, statt direkt gegen HTTP/WebSocket zu sprechen

Sonstiges:

- [ ] Flutter-App (eigenes Projekt, startet erst, wenn das Backend steht)
- [ ] ESP32-Firmware (Blitzer-Anzeige) — eigenständiges Projekt, hier nicht enthalten
