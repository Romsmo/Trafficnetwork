# Prompt für Claude Code — Abschluss-Instanz: Projekt prüfen, Repo fertigstellen

> **Diese Instanz startet erst, wenn alle Arbeits-Instanzen ihren Lagebericht abgegeben haben** (`docs/prompt-finalize-all-instances.md`) und deren Pull Requests offen und grün sind. Prüfe das zuerst in `docs/status.md` und auf GitHub; ist etwas offen, melde es mir und warte.
>
> **Auftrag:** Das gesamte Projekt unabhängig überprüfen und das Repo in einen fertigen Zustand bringen: nur noch Quellcode, Dokumentation und ein nutzbarer Build. Die Arbeits-Prompts wandern in einen **externen Ordner außerhalb des Repos**.
>
> **Arbeite gründlich und misstrauisch.** Du bist die letzte Instanz vor der Nutzung — verlasse dich nicht auf die Selbstauskünfte der anderen, sondern prüfe nach.

---

## 0. Setup

1. Repo klonen bzw. `git checkout main && git pull`. **Eigener Checkout in einem eigenen Ordner**, nicht der geteilte — du wirst Branches wechseln und mergen.
2. Branch `release/finalize` für deine eigenen Änderungen. Merges der fremden Pull Requests nach `main` nur nach meiner Freigabe, Stück für Stück.
3. Nichts löschen, was nicht ersetzt oder gesichert ist. Vor jeder Umstellung mit Datenverlust-Risiko: fragen.

---

## 1. Unabhängige Prüfung (vor dem Aufräumen)

Gehe das ganze Projekt durch und berichte als Prüfbericht (`docs/audit.md`):

- **Bauen und testen:** frischer Klon, saubere Installation, `typecheck`, `lint`, `build`, alle Tests je Paket — lokal und der letzte CI-Lauf. Was rot ist, wird benannt, nicht überredet.
- **Läuft es wirklich?** Compose-Stack hochfahren, Migrationen, `GET /v1/health`, ein Bootstrap über die Client-Bibliothek, eine Meldung absetzen und über die Weboberfläche wiederfinden. Ein kurzer, echter Durchstich, kein Papiertest.
- **Doku gegen Code:** Stimmen `README`s, `api.md`, `schema.md`, `installation.md`, `operating.md`, `federation-protocol.md` mit dem tatsächlichen Verhalten überein? Jede Umgebungsvariable, die der Code liest, muss in `.env.example` stehen (bekannte Lücke: die `HAZARD_EXPIRY_*`-Werte) — und umgekehrt keine Variable dokumentiert sein, die es nicht gibt.
- **Versprechen aus dem Konzept:** Blitzer-Namensraum standardmäßig aus; Provenienz auf jedem Datensatz; leerer Server ist ein gültiger Zustand; Server ohne Föderation läuft; Ingestion ist optional. Jede dieser Zusagen einmal wirklich testen.
- **Sicherheit:** keine Geheimnisse im Repo **und nicht in der Git-Historie** (Scan, z. B. `gitleaks` oder gleichwertig; Fund sofort melden, nicht selbst „bereinigen"). Abhängigkeiten auf bekannte Schwachstellen prüfen (`npm audit` o. Ä.). Standardwerte sind sicher, nicht bequem.
- **Lizenz und Attribution:** `LICENSE` vorhanden, Lizenzen aller Abhängigkeiten mit Apache 2.0 vereinbar (Liste erzeugen), ODbL-Attribution für OSM-Daten in Doku und Weboberfläche sichtbar.
- **Loses Ende:** offene Branches, verwaiste Dateien, toter Code, `TODO`/`FIXME`, nicht genutzte Abhängigkeiten, Testreste.

Den Prüfbericht legst du mir vor, **bevor** du etwas umbaust. Gravierende Funde arbeitest du nicht selbst ab, wenn sie in ein fremdes Paket gehören — sag mir, wer das reparieren muss.

---

## 2. Zusammenführen

- Pull Requests der Arbeits-Instanzen nacheinander nach `main` bringen, nach jedem Merge CI abwarten und einen kurzen Durchstich testen. Konflikte löst du, ohne fremde Absichten zu verfälschen; im Zweifel fragen.
- Nach dem letzten Merge: alle zusammengeführten Feature-Branches entfernen (nur die gemergten, und erst nach meiner Bestätigung).

---

## 3. Prompts auslagern

- Alle Arbeits-Prompts (`docs/prompt-*.md`, inklusive dieses hier und `docs/prompt-finalize-all-instances.md`) wandern **aus dem Repo heraus** in einen Ordner neben dem Repo, Vorgabe: `../Trafficnetwork-prompts/`, Struktur beibehalten, Dateinamen unverändert.
- Verfahren: Dateien kopieren, Kopie überprüfen (Anzahl und Prüfsummen vergleichen), erst dann im Repo entfernen und committen. Kein Verlust, keine Umbenennung.
- **Hinweis, den du mir bestätigst:** Die Dateien bleiben in der Git-Historie sichtbar. Das ist in Ordnung, solange dort keine Geheimnisse stehen — prüfe genau das.
- Bleiben im Repo: `docs/concept.md`, `docs/federation.md`, `docs/todo.md`, `docs/status.md` (falls noch sinnvoll, sonst archivieren), `docs/audit.md`, `docs/privacy.md` (siehe unten) sowie alle Paket-Dokumentationen.
- Verweise, die auf ausgelagerte Dateien zeigen, in der verbleibenden Doku so umschreiben, dass keine toten Links bleiben.

---

## 4. Fertiger, nutzbarer Build

Mein Wunsch: „der fertige Build liegt bereit". Setze das so um:

- **Reproduzierbar bauen:** ein Befehl je Paket, dokumentiert, ohne Handgriffe. Ergebnis: Server-Container-Image (Multi-Arch), Client-Bibliothek-Artefakte je Zielplattform, Weboberfläche gebündelt, Ingestion lauffähig.
- **Auslieferung als Release, nicht als Commit:** Build-Ergebnisse gehören **nicht** in die Versionsverwaltung — sie blähen das Repo auf und veralten still. Stattdessen: CI baut sie, hängt sie mit Prüfsummen an ein **GitHub-Release** (Tag `v1.0.0`), das Container-Image geht in die GitHub Container Registry. Das Repo enthält den Bauplan, das Release das Ergebnis.
- Willst du die Artefakte trotzdem im Repo haben, sag es — dann lege ich sie in einem eigenen Ordner mit Prüfsummen ab. Frag mich einmal danach, bevor du das Release baust.
- `CHANGELOG.md` mit dem Weg bis `v1.0.0`, Versionsnummern in allen Paketen konsistent.
- Eine **Schnellstart-Anleitung ganz oben im Haupt-README**: von „Repo geklont" bis „Server läuft und antwortet" in wenigen Schritten, einmal von dir selbst nachvollzogen.

---

## 5. Vor dem Freigeben: Blocker benennen

Diese Punkte verhindern einen öffentlichen Start, auch wenn der Code fertig ist. Prüfe den Stand und schreibe ihn klar in den Prüfbericht — **bauen sollst du sie nicht**:

- `docs/privacy.md` (DSGVO) fehlt oder ist unvollständig; Betreiberbedingungen für fremde Knoten ebenso.
- Rechtliche Prüfung zum Blitzer-Betreiberrisiko steht aus — das Flag bleibt aus.
- Autobahn-API-Lizenz ungeklärt; Quellen mit Ampel „ungeklärt" bleiben abgeschaltet.
- Projekt-Domain und Netzwerk-Wurzelschlüssel liegen beim Betreiber.

---

## 6. Meilensteine

| # | Inhalt |
|---|---|
| R0 | Alle Lageberichte gesichtet, Prüfplan, offene Fragen an mich |
| R1 | Prüfbericht `docs/audit.md` inkl. echtem Durchstich — **vor** Umbauten |
| R2 | Pull Requests gemergt, CI auf `main` grün, Branches aufgeräumt |
| R3 | Prompts ausgelagert (verifiziert), Doku entrümpelt und stimmig, Schnellstart im README |
| R4 | Reproduzierbarer Build, Release `v1.0.0` mit Artefakten und Prüfsummen, `CHANGELOG.md` |
| R5 | Abschlussbericht: Was ist fertig, was ist bewusst offen, was muss ich als Betreiber noch tun |

---

## 7. Was ich von dir erwarte

Nach R1 und am Ende jeweils **kurz und ehrlich**: was funktioniert, was nicht, was du bewusst liegen gelassen hast. Keine Schönfärberei — dieses Repo soll jemand benutzen können, der nichts über seine Entstehung weiß.
