# Prompt für Claude Code — Launch P: Öffentlicher Betrieb (gemieteter Server, Domain, HTTPS)

> **Ziel:** Der lokal erprobte Stand (siehe `docs/prompt-launch-local-test.md`, Prüfliste `docs/launch-checklist.md`) läuft dauerhaft auf einem gemieteten Server, ist unter meiner Domain per HTTPS erreichbar, dient als **Seed-Knoten** des Netzwerks und ist so abgesichert und dokumentiert, dass andere Betreiber dazukommen können.
>
> **Voraussetzung:** Lokaler Test (L0–L5) abgeschlossen, Prüfliste ausgefüllt, CI grün. Ich habe: einen Server (Root-/VPS-Zugang) und eine Domain. Fehlt eines davon — fragen, nicht raten.
>
> **Maßgeblich:** `server/docs/installation.md`, `server/docs/operating.md`, `server/docs/federation-protocol.md`, `docs/federation.md` (Abschnitte 6–8), `docs/status.md`.

---

## 0. SETUP & KOORDINATION

1. Klon prüfen, `main` aktuell, `docs/status.md` lesen (parallele Instanzen, vor Branch-Wechsel `git status`).
2. Branch `launch/public-server` für alles, was ins Repo kommt (Betriebsdoku, Beispielkonfigurationen, Skripte). Nach jedem Meilenstein Commit + Push + Statusdatei aktualisieren.
3. **Vor jedem Eingriff auf dem gemieteten Server oder in DNS: sagen, was passiert, und mein OK abwarten.** Keine Passwörter oder Schlüssel im Chat; Zugangsdaten bleiben in lokalen Dateien bzw. auf dem Server.
4. Belege statt Annahmen: Let's-Encrypt-Grenzen, Firewall-Verhalten, Backup-Werkzeuge mit Link und Datum dokumentieren.

---

## 1. MEILENSTEINE

### P-L0 — Plan und Bestandsaufnahme
Servergröße (CPU, RAM, Platte) gegen erwarteten Bedarf prüfen (Ergebnisse aus L5), Betriebssystem, Domain und aktuelle DNS-Einträge. Plan mit Ports, Datenpfaden, Backup- und Update-Strategie. Offene Fragen an mich.

### P-L1 — Grundabsicherung
Aktuelle Pakete, SSH nur mit Schlüssel, Firewall (nur 80/443 und SSH), automatische Sicherheitsupdates, eigener Benutzer statt root, Zeitsynchronisation. Kurz dokumentieren, was gesetzt wurde.

### P-L2 — Stack in Betrieb
Server per Docker Compose (oder ohne Docker, falls ich das will) installieren, Datenbank auf dauerhaftem Volume, Reverse-Proxy mit automatischem HTTPS, Neustart-Verhalten (startet nach Reboot von allein), Logrotation. `GET /v1/health` öffentlich erreichbar, `GET /v1/network/node-info` liefert die Knoten-Identität.

### P-L3 — Domain und Netzwerk-Identität
DNS-Einträge setzen (ich gebe die Domain vor): der Knoten selbst, dazu die Anker aus `docs/federation.md` — Verzeichnis und mindestens ein Seed-Name. Zertifikate prüfen (auch Erneuerung). **Echten Netzwerk-Wurzelschlüssel**: Anleitung geben, wie ich ihn offline erzeuge und verwahre; du signierst die Netzwerk-Konfiguration nur mit dem, was ich dir dafür freigebe — der private Schlüssel gehört nicht auf den Server. Signierte Konfiguration und Verzeichnis veröffentlichen, Spiegel einrichten.

### P-L4 — Föderation aktivieren und prüfen
`FEDERATION_ENABLED=true`, Seed-Liste setzen, zweiten Knoten (zweiter Anbieter oder zweite Maschine) beitreten lassen und nachweisen: Beitritt, Replikation, Heartbeats, Verzeichnis, Failover bei Ausfall eines Knotens, Ausschluss eines Knotens über die signierte Konfiguration.

### P-L5 — Befüllung und Abnahme
Grundbestand über `ingestion/` einspielen (Region oder größer, nach meiner Vorgabe), danach dieselbe Prüfliste wie lokal gegen die öffentliche Adresse durchgehen, inklusive Testwerkzeug aus `tools/test-client/` über das echte Internet.

### P-L6 — Betrieb und Übergabe
- **Backups:** automatisch, verschlüsselt, mit belegtem Wiederherstellungstest (einmal wirklich zurückspielen).
- **Überwachung:** Erreichbarkeit, Plattenplatz, Fehlerrate, Zertifikatsablauf — Benachrichtigung an mich.
- **Updates:** wie ich eine neue Version einspiele und zurückrolle.
- **Betreiber-Doku für Dritte** (`server/docs/operating.md` erweitern): wie jemand anderes in 20 Minuten einen Knoten aufsetzt und beitritt.
- **Rechtliche Vorbereitung:** Entwürfe für Betreiberbedingungen und `docs/privacy.md` (DSGVO) bereitstellen — als Entwurf zur anwaltlichen Prüfung, nicht als fertige Rechtstexte. **Bevor echte Nutzermeldungen angenommen werden, muss das stehen.**

---

## 2. NICHT-ZIELE

- Kein Aktivieren des Blitzer-Namensraums (bleibt aus, bis ich nach rechtlicher Beratung freigebe).
- Keine Werbung für das Netzwerk, keine Registrierung echter Nutzer, solange Datenschutz und Betreiberbedingungen nicht geprüft sind.
- Keine kostenpflichtigen Dienste oder Verträge ohne meine ausdrückliche Freigabe — auch keine Domain- oder Serverbestellung in meinem Namen.

---

## 3. WAS ICH VON DIR ERWARTE

Vor jedem Eingriff eine Zeile, was passiert. Nach jedem Meilenstein: was läuft, was geändert wurde, was noch offen ist. Am Ende eine Betriebsübersicht: Adressen, Dienste, Datenpfade, Backup- und Wiederherstellungsweg, und was ich regelmäßig selbst prüfen sollte.
