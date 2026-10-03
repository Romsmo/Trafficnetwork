# Abschlussbericht (R5)

Stand: 2026-09-28. Server ist als `v1.0.0` freigegeben, Ingestion als `v0.2.0` (siehe [`CHANGELOG.md`](../CHANGELOG.md), Releases: [server-v1.0.0](https://github.com/Romsmo/Trafficnetwork/releases/tag/server-v1.0.0), [ingestion-v0.2.0](https://github.com/Romsmo/Trafficnetwork/releases/tag/ingestion-v0.2.0)). Vollständige Belege, jeder Fund einzeln nachvollziehbar: [`docs/audit.md`](audit.md).

Kurz und ehrlich, ohne Beschönigung.

---

## 1. Was fertig und benutzbar ist

**Server (`server/`, v1.0.0):** Läuft self-hosted (Docker oder ohne Docker hinter Apache/nginx/Caddy), einzeln oder föderiert mit anderen Knoten (offene Mitgliedschaft, Reputation, signierte Daten). Ereignisprotokoll, Snapshot-/Delta-Sync, Moderationsgate, Bulk-Import, WebSocket-Push, Blitzer-Namensraum standardmäßig aus. Zusatzfunktionen: eingebaute Weboberfläche, „aktuell online"-Anzeige, Community-Tempolimit-Korrekturen, Europa-Maßstab (vorgebaute Statikdaten-Pakete), dauerhafte Überwachungsanlagen (Rotlicht/Abstand). Selbst durchgespielt, nicht nur behauptet: frischer Klon → `docker compose up` → `GET /v1/health` → Meldung über die echte Client-Bibliothek abgesetzt → im Browser auf der Karte gefunden.

**Client-Bibliothek (`client-lib/`, v1.0.0):** Ein Rust-Kern mit dünnen Anbindungen für alle zugesagten Plattformen — C-ABI (Linux, macOS, Windows) mit Python und Node.js, WebAssembly für den Browser, Kotlin/Android, Swift/iOS/macOS, Dart/Flutter, React Native —, an einem gemeinsamen Szenariensatz gemessen (gleiches Ergebnis über Python, Node.js, WebAssembly, Kotlin, Swift, Dart), gegen ein echtes Mehrknoten-Testnetz und gegen den Docker-Server vom frischen Klon aus verifiziert (Abschnitt 4). Je Plattform eine Integrationsanleitung mit nachbaubarem Minimalbeispiel in [`client-lib/docs/`](../client-lib/docs/); die Pakete entstehen als Build-Artefakte in CI, veröffentlicht ist nichts. Was nicht belegt ist, steht in [`client-lib/README.md`](../client-lib/README.md) unter „Was noch fehlt“.

**Ingestion (`ingestion/`, v0.2.0):** OSM-Bulk-Import mit Wiederaufnahme nach Abbruch, Europa-Grundstock einmalig importiert (13,68 Mio. Zeilen), Baustellen-Import (DATEX II, Autobahn-JSON), amtliche Schilder aus Norwegen, Qualitätsbericht. Läuft ausschließlich als gewöhnlicher Client gegen die öffentliche API — kein privilegierter Zugriff, jederzeit abschaltbar.

**Rundherum:** keine echten Geheimnisse im Repo oder in der Historie (gitleaks über 217 Commits geprüft), keine Lizenzkonflikte in den Node-Paketen, ODbL-Attribution sichtbar, Apache-2.0-`LICENSE` vorhanden, `README.md` mit Schnellstart oben, `CHANGELOG.md` mit dem Weg bis hierher, GitHub Actions grün auf allen vier Workflows.

## 2. Was bewusst offen ist (keine Betreiber-Aufgabe, sondern weitere Entwicklung)

- **Client-Bibliothek nach 1.0 (nie zugesagt, aber wichtig zu wissen):** Veröffentlichung in Paketregistern (npm, Maven, pub.dev, CocoaPods) wartet auf eine ausdrückliche Freigabe; Kotlin/Android, Swift/iOS und React Native werden gebaut, aber nicht auf Gerät, Emulator oder Simulator ausgeführt (nur die Flutter-App läuft auf einem Android-Emulator); ein echter TLS-Handshake gegen einen Server ist nirgends getestet (alle Tests laufen über `http://`). Das Release selbst (`client-lib-v1.0.0`) löst erst ein Tag aus, das du setzt.
- **Baustellen-Dauerbetrieb:** Der Import ist gebaut und getestet, aber nicht als wiederkehrender Lauf eingerichtet — das war für diesen Stand bewusst nicht der Auftrag (`ingestion/docs/roadworks.md`).
- **Ungeklärte Quellen:** HERE, TomTom, Mobilithek sind katalogisiert, aber abgeschaltet (keine Zugänge, keine belastbare Lizenz-/Preisrecherche). NDW (Niederlande) wartet auf Lizenzklärung. Schweden-Schilder brauchen einen Lastkajen-Zugang, den es nicht gibt.
- **Kleinere, benannte Lücken ohne Betreiber-Bezug:** `federationEventId` fehlt weiterhin in Snapshot/Delta (Confirm/Deny-Föderation braucht das später); Abschnittskontrolle (`enforcement=average_speed`) nicht gebaut; acht kleinere Konfigurationsfragen zu den dauerhaften Überwachungsanlagen sind mit dokumentierten Standardwerten entschieden, nicht mit dir abgestimmt (`server/docs/persistent-enforcement-devices.md` §10) — jede davon ist eine kleine, spätere Änderung.

## 3. Was bei dir als Betreiber liegt

Das sind die Punkte, die einen öffentlichen Start verhindern, unabhängig vom Code-Zustand:

- **`docs/privacy.md` (DSGVO):** existiert nur als Entwurf, keine rechtliche Prüfung.
- **Betreiberbedingungen für fremde Knoten:** fehlen komplett — wer föderiert beitreten darf und unter welchen Bedingungen, ist nirgends fixiert.
- **Rechtliche Prüfung des Blitzer-Betreiberrisikos (§23 Abs. 1b StVO):** steht aus. Das Flag bleibt technisch aus, bis das geklärt ist — das ist absichtlich hart verdrahtet, nicht nur eine Empfehlung.
- **Domain `trafficnetwork.info`:** in Code und Doku bereits als die feste Adresse eingetragen (eine konfigurierbare Stelle je Paket) — aber real weder registriert noch im DNS. Ohne das laufen `client-lib`s eingebaute Seeds ins Leere.
- **Netzwerk-Wurzelschlüssel:** muss offline erzeugt und sicher verwahrt werden, bevor die signierte Netzwerk-Konfiguration (und damit z. B. eine spätere Blitzer-Freigabe) irgendeine Bedeutung hat. Die Werkzeuge dafür sind fertig (`server/scripts/network-*.mts`), der eigentliche Schlüssel nicht.
- **Mindestens zwei Seed-Server, verschiedene Anbieter:** noch nicht bereitgestellt — ohne die findet ein neuer Knoten das Netzwerk nicht.
- **Autobahn-API-Lizenz:** direkt bei der Autobahn GmbH/BMV erfragen — die Quelle bleibt bis dahin abgeschaltet.
- **`tn-europe` selbst:** die 2.000 doppelt importierten Segmente entfernen, danach `pg_dump` als Grundstock ziehen (SQL liegt im Europa-Bericht bereit, ausgeführt werden muss es auf dem echten Knoten).

Keiner dieser Punkte ist ein Code-Mangel — das sind durchweg Entscheidungen und Handlungen, die nur du treffen bzw. ausführen kannst.

---

## `docs/status.md` — mein Vorschlag

**Bleibt vorerst.** Die Client-Bibliothek-Instanz arbeitet aktiv weiter (B3–B5), und `docs/status.md` ist genau dafür da: laufende Arbeit zwischen Instanzen zu koordinieren, ohne dass jede ihren eigenen Kontext neu aufbauen muss. Sie jetzt zu entfernen, würde diese Koordination beenden, während sie noch gebraucht wird.

Mein Vorschlag: Wenn B3–B5 abgeschlossen sind (oder du die Arbeit an der Client-Bibliothek anderweitig für beendet erklärst), räumt die dann tätige Instanz `docs/status.md` in einem letzten, kurzen Schritt weg — Inhalt, der noch von Dauer ist (z. B. offene Nebenbefunde), wandert vorher nach `docs/todo.md`, der Rest ist dann wirklich nur noch Verlaufsprotokoll und kann raus. Das ist keine große Aufgabe, aber eine eigene, nicht Teil von R5 selbst, weil R5 explizit *vor* dem Abschluss der Client-Bibliothek stattfindet.

**Update (Client-Bibliothek-Instanz, 2026-10-03): B3–B5 sind abgeschlossen** (Version `1.0.0`, siehe `CHANGELOG.md`). Die Abschluss-Instanz kann `docs/status.md` jetzt entfernen; was darin noch von Dauer ist, steht in `docs/todo.md` (Eintrag „Client-Bibliothek nach 1.0“) und in `client-lib/README.md` („Was noch fehlt“).
