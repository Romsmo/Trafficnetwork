# Prompt für Claude Code — Launch L: Server lokal starten, befüllen und testen (Windows + Docker)

> **Ziel:** Am Ende läuft der Server auf meinem Windows-PC in Docker, ist mit echten Kartendaten einer Region befüllt, und ich kann mit einem kleinen Testwerkzeug Tempolimits abfragen, Meldungen absetzen und den Sync beobachten. **Du arbeitest direkt auf meinem PC** — du darfst Befehle ausführen, Software prüfen und (nach Rückfrage) installieren.
>
> **Voraussetzung:** Überarbeitung F (Server + Client-Bibliothek) ist nach `main` gemergt und CI grün. Phase 3 (`ingestion/`) ist vorhanden oder wird parallel gebaut (`docs/prompt-phase3-ingestion.md`) — ohne sie gibt es nur Testdaten von Hand.
>
> **Maßgeblich (vollständig lesen):** `docs/status.md`, `server/docs/installation.md`, `server/docs/operating.md`, `server/docs/api.md`, `server/docs/federation-protocol.md`, `client-lib/README.md` + `client-lib/docs/`, `ingestion/README.md` (falls vorhanden).

---

## 0. SETUP & KOORDINATION

1. Klon prüfen/anlegen, `git checkout main && git pull`. **`docs/status.md` lesen** — es arbeiten ggf. weitere Claude-Instanzen im selben Checkout; vor jedem Branch-Wechsel `git status` prüfen, nie bei fremden Änderungen wechseln.
2. Branch `launch/local-test` für alles, was im Repo landet (Testwerkzeug, Doku, Beispielkonfigurationen). Nach jedem Meilenstein: Commit + Push und eigenen Abschnitt in `docs/status.md` auf `main` aktualisieren.
3. **Nichts Heimliches auf meinem System:** Bevor du etwas installierst, den Autostart änderst, Ports öffnest oder die Firewall anfasst, sag mir in einem Satz was und warum, und warte auf mein OK. Keine Änderungen an Systemeinstellungen ohne Zustimmung.
4. Geheimnisse (Schlüssel, Client-Secrets, API-Keys) gehören in lokale Dateien außerhalb der Versionskontrolle — nie ins Repo, nie in den Chat kopieren, außer ich frage ausdrücklich danach.
5. Arbeitsweise: erst kurz planen, dann ausführen; bei jedem Fehler die echte Fehlermeldung zeigen statt sie zu umschreiben; nichts erfinden.

---

## 1. MEINE UMGEBUNG

- **Windows-PC**, Docker vermutlich noch nicht installiert. Vorgesehen: **Docker Desktop mit WSL2-Backend**.
- Prüfe zuerst, was schon da ist: `docker --version`, `docker compose version`, `wsl --status`, verfügbarer Plattenplatz, Virtualisierung im BIOS aktiv.
- Fehlt Docker: Installationsweg vorschlagen (z. B. `winget install Docker.DockerDesktop` oder Download), **mein OK abwarten**, dann installieren. Ein Neustart kann nötig sein — sag es vorher, statt ihn auszulösen.
- Reicht Docker Desktop nicht oder will ich es nicht: Rückfallweg ist der Weg ohne Docker aus `server/docs/installation.md` (Node.js + PostgreSQL mit PostGIS direkt unter Windows oder in WSL2). Empfiehl den einfacheren Weg, entscheide nicht allein.

---

## 2. MEILENSTEINE

### L0 — Bestandsaufnahme und Plan
Stand des Repos (F gemergt? CI grün? gibt es `client-lib/`-Code? gibt es `ingestion/`?), Werkzeuge auf dem PC, Plattenplatz- und Laufzeitschätzung für die gewählte Region. Kurzer Plan + offene Fragen an mich. **Frag mich hier, welche Region ich zuerst will** (ein Bundesland-Extrakt von Geofabrik, Größenordnung 100 MB), falls es noch nicht feststeht.

### L1 — Docker und Stack starten
Docker einrichten (siehe Abschnitt 1), dann den Compose-Stack aus `server/` starten: Server + PostgreSQL/PostGIS, Migrationen, Healthcheck. Ergebnis: `GET /v1/health` antwortet lokal, Logs sind sauber. Datenbank liegt auf einem benannten Volume, damit ein Neustart nichts löscht. `FEDERATION_ENABLED=false` für den ersten Lauf — ein einzelner Server, kein Netzwerk.

### L2 — Schlüssel und Zugänge (nur Testschlüssel)
- Netzwerk-Wurzelschlüssel als **Testschlüssel** erzeugen (ausdrücklich nicht der spätere echte Schlüssel), signierte Netzwerk-Konfiguration erstellen, Server damit starten.
- Clients anlegen: einen `bulk-import`-Client für die Befüllung, einen `device-registration`-App-Schlüssel für das Testwerkzeug, einen normalen `client`.
- Alles in einer lokalen, nicht versionierten Datei sammeln und mir sagen, wo sie liegt. **Blitzer-Flag bleibt aus.**

### L3 — Befüllung
Mit `ingestion/` die gewählte Region importieren (Fortschritt sichtbar, Abbruch/Wiederaufnahme geprüft). Danach verifizieren: Anzahl importierter Segmente und Schilder, und eine Handvoll Stichproben — Tempolimit an Koordinaten, die ich vorgebe oder die du aus bekannten Straßen ableitest. Falls `ingestion/` noch nicht existiert: einen kleinen, klar als Testdaten gekennzeichneten Satz über die Bulk-Import-API einspielen, damit L4 trotzdem laufen kann.

### L4 — Testwerkzeug (`tools/test-client/`)
Ein schlankes Werkzeug auf Basis der **Client-Bibliothek** (nicht direkt gegen HTTP, damit wir auch die Bibliothek testen), zwei Oberflächen:
- **Kommandozeile:** Tempolimit an Position abfragen, Umgebung anzeigen, Meldung absetzen, Meldung bestätigen, Sync-Status, Netzwerkstatus.
- **Kleine lokale Weboberfläche:** Karte mit den lokal gespeicherten Daten der Umgebung, simulierte Position (setzen oder entlang einer Route bewegen), Knöpfe für Meldungen, Anzeige von Sync- und Verbindungsstatus.

Anforderungen: nur lokal erreichbar, keine Anmeldedaten im Code, funktioniert auch offline (Server gestoppt → Daten weiter sichtbar, Meldungen werden gepuffert und später gesendet). `tools/test-client/README.md` mit Start in drei Schritten.

### L5 — Abnahmetest
Eine Prüfliste, die du durchgehst und mit echtem Ergebnis dokumentierst (`docs/launch-checklist.md`):
1. Server neu gestartet → Daten noch da.
2. Tempolimit an bekannter Stelle stimmt mit der Realität überein (Stichprobe).
3. Meldung im Testwerkzeug abgesetzt → erscheint in der Abfrage der Umgebung.
4. Zweites Gerät (zweite Instanz des Werkzeugs) sieht die Meldung über Push innerhalb weniger Sekunden.
5. Bestätigung verlängert die Ablaufzeit, Verfall funktioniert.
6. Server während einer Meldung gestoppt → Meldung wird gepuffert und nach dem Start nachgereicht.
7. Blitzer-Kategorien liefern nichts, solange das Flag aus ist.
8. Zweiter Server-Knoten lokal gestartet (`FEDERATION_ENABLED=true`, zweiter Port) → beide finden sich, Daten replizieren, Testwerkzeug wechselt bei Stopp des einen automatisch auf den anderen.
9. Ressourcenverbrauch (RAM, Platte, CPU) notiert.

Am Ende: kurzer Bericht, was funktioniert, was nicht, und was vor einem öffentlichen Betrieb noch fehlt.

---

## 3. NICHT-ZIELE

- Kein öffentlicher Betrieb, keine Domain, keine Portfreigabe im Router (eigener Prompt `docs/prompt-launch-public-server.md`).
- Kein echter Netzwerk-Wurzelschlüssel, kein Aktivieren des Blitzer-Flags.
- Keine kostenpflichtigen Datenquellen ohne meine ausdrückliche Freigabe.
- Keine App, kein UI-Projekt über das Testwerkzeug hinaus.

---

## 4. WAS ICH VON DIR ERWARTE

Nach jedem Meilenstein: ein kurzer Absatz, was läuft, was du auf meinem System verändert hast, und was als Nächstes kommt. Bei Installationen und Systemänderungen vorher fragen. Am Ende von L5 die ausgefüllte Prüfliste.
