# Abschluss-Auftrag — für **jede** laufende Instanz (Server, Client-Bibliothek, Weboberfläche, Ingestion)

> Diesen Text bekommt jede Instanz **unverändert**. Jede arbeitet nur in ihrem eigenen Bereich und bringt ihn zu Ende. Danach wird eine eigene Instanz das Repo aufräumen und abschließen (`docs/prompt-repo-finalization.md`) — die kann erst starten, wenn **alle** hier fertig gemeldet haben.

---

## Was jetzt zu tun ist

1. **Bestandsaufnahme zuerst.** `git fetch`, `docs/status.md` und `docs/todo.md` lesen, `git status` prüfen (im geteilten Checkout niemals den Branch wechseln, solange fremde Änderungen im Arbeitsverzeichnis liegen). Stelle fest: Was ist in *deinem* Bereich wirklich fertig, was ist angefangen, was fehlt?
2. **Offene Aufträge deines Bereichs abschließen** — das sind die Meilensteine aus den Prompts, die dir zugewiesen wurden (siehe `docs/todo.md`). Nichts Neues erfinden, nichts aus anderen Bereichen anfassen.
3. **Grün machen:** `typecheck`, `lint`, `build`, Unit- und Integrationstests lokal und **in CI**. Ein Meilenstein gilt erst als fertig, wenn der CI-Lauf auf deinem Branch grün ist — nicht, wenn es lokal lief.
4. **Doku nachziehen:** README deines Pakets, API-/Schema-/Betriebsdoku, `.env.example` vollständig (jede Variable, die der Code liest, steht dort mit Erklärung), Beispiele, die tatsächlich funktionieren.
5. **Aufräumen im eigenen Bereich:** kein toter Code, keine auskommentierten Reste, keine `TODO`/`FIXME` ohne Eintrag in `docs/todo.md`, keine Debug-Ausgaben, keine Geheimnisse in Dateien oder Testfixtures.
6. **Pull Request** deines Branches nach `main` öffnen (oder, falls schon offen, auf grün bringen). **Nicht selbst mergen** — die Freigabe liegt beim Betreiber.
7. **`docs/status.md` auf `main` aktualisieren:** dein Abschnitt, mit Stand „abgeschlossen" oder „offen, weil …".

## Was du **nicht** tust

- Keine Arbeit in fremden Paketen, kein Merge nach `main`, kein Löschen fremder Branches.
- Keine Blitzer-Freigabe: `SPEED_CAMERA_NAMESPACE_ENABLED` bleibt aus.
- Kein echter Netzwerk-Wurzelschlüssel, keine Veröffentlichung in Paket-Registries, keine Domainbestellung.
- Nichts „schnell noch" umbauen, was außerhalb deines Auftrags liegt — melden statt anfassen.

## Wenn etwas nicht fertig werden kann

Das ist ein zulässiges Ergebnis. Dann: **nicht** halbfertig mergen, sondern im Lagebericht klar benennen, was fehlt, warum, und was es bräuchte. Ein ehrliches „offen" ist mir lieber als ein grünes Häkchen auf wackeligem Code.

---

## Lagebericht (erst ganz am Ende, kurz)

Wenn du fertig bist, gib **genau diesen Block** aus — nicht mehr:

```
BEREICH:        <server | client-lib | web-ui | ingestion>
BRANCH:         <name>            LETZTER COMMIT: <hash>
CI:             grün / rot (<Lauf-Nummer>)
PULL REQUEST:   <Nummer/Link> oder "keiner, weil ..."
FERTIG:         <Stichpunkte, was abgeschlossen ist>
OFFEN:          <Stichpunkte, was fehlt — oder "nichts">
RISIKEN:        <was beim Zusammenführen Ärger machen könnte — oder "keine">
BESTÄTIGUNG:    Ich bestätige, dass in meinem Bereich alle Tests in CI grün sind,
                die Doku dem Code entspricht und keine Geheimnisse im Repo liegen.
                (Wenn etwas davon nicht stimmt, ersetze diesen Satz durch die Einschränkung.)
```

Diesen Block schreibst du zusätzlich in deinen Abschnitt in `docs/status.md`, damit die Abschluss-Instanz ihn dort findet.
