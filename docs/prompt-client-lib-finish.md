# Prompt für Claude Code — Client-Bibliothek zu Ende bringen (F-C4 Rest + F-C5)

> **Für den Client-Bibliothek-Chat.** PR #10 (`rework/client-lib-europe-scale`) ist grün und wird als Zwischenstand nach `main` gemergt. Dieser Auftrag baut **darauf auf**, auf neuem Branch `rework/client-lib-bindings`, ausgehend vom gemergten `main`.
>
> **Warum noch ein Durchgang:** Die tragende Zusage der Bibliothek ist „maximal kompatibel — ein Kern, viele dünne Anbindungen" (`docs/prompt-phase2-client-lib.md`, Abschnitt 1) und Local-First mit Push. Beides ist heute nicht eingelöst: Es gibt eine Python-Anbindung, aber weder WASM noch JS/TS, Kotlin, Swift oder Dart — und der WebSocket-Transport ist noch nicht echt. Ohne diese Teile ist die Bibliothek ein Prototyp, kein Adapter.

---

## 0. Setup

1. `git fetch`, `git checkout main && git pull` (muss PR #10 enthalten — wenn nicht, melden und warten), Branch `rework/client-lib-bindings`.
2. `docs/status.md` lesen, eigenen Abschnitt nach jedem Meilenstein aktualisieren. Geteilter Checkout: vor jedem Branch-Wechsel `git status`.
3. Wie gehabt: erst planen, bei Unklarheit fragen, nichts erfinden, nach jedem Meilenstein Commit + Push und CI grün.

---

## 1. Reihenfolge — nach Nutzen, nicht nach Bequemlichkeit

**1. Echter WebSocket-Transport.** Das ist kein Binding-Thema, sondern eine Funktionslücke: Ohne ihn gibt es keinen Push, und „neue Meldung erscheint innerhalb von Sekunden" stimmt nicht. Inklusive Reconnect mit Backoff, Lückenschluss per Delta nach dem Wiederverbinden, sauberem Verhalten bei Serverwechsel.

**2. Mehrknoten-Integrationstests.** Gegen das Testnetz aus der Server-Föderation: Kaltstart nur mit Seeds, Ausfall mitten im Sync, Serverwechsel ohne Datenverlust oder Duplikate, bösartiger Server (gefälschte Daten verworfen, zurückgehaltene erkannt), Offline-Meldung an einem anderen Server abgeliefert. Erst damit ist belegt, dass Discovery und Failover im Zusammenspiel halten — die beiden Fehler, die du beim Messen gefunden hast, waren genau von dieser Sorte.

**3. WASM + JS/TS.** Der Browser-Build ist das Ziel mit den meisten Einschränkungen; wenn er trägt, tragen die anderen erst recht. Mit TS-Typen und dokumentierten Grenzen.

**4. Kotlin, Swift, Dart** über die bestehende Toolchain, dünn.

**5. React Native und Paketierung** je Plattform (Build-Artefakte in CI, **keine Veröffentlichung** in Registries ohne meine Freigabe).

**6. Konformitätstests** über mindestens C-ABI, WASM und eine Mobile-Anbindung: derselbe Szenariensatz, gleiches Verhalten überall.

Schaffst du nicht alles: Reihenfolge einhalten und ehrlich abbrechen, statt alles halb zu machen. Jede fertige Stufe wird einzeln gemergt.

---

## 2. Rahmen

- Logik bleibt im Kern, Anbindungen bleiben dünn — keine Funktion, die es nur in einer Sprache gibt.
- Öffentliche API nach SemVer; was in PR #10 dokumentiert ist, bleibt gültig oder wird mit Migrationshinweis versioniert.
- Kein Umbau der Entscheidung „statische Daten vollständig auf jedem Gerät". Dein Messbericht ist Entscheidungsgrundlage für mich, kein Auftrag.
- Domain: **`trafficnetwork.info`** (steht fest). Eingebaute Seeds und Verzeichnis-Anker entsprechend setzen — an genau einer konfigurierbaren Stelle, nicht über den Code verteilt. Die Adressen existieren noch nicht im DNS: keine Tests, die echte Namen auflösen.
- Blitzer-Namensraum bleibt aus; keine echten Schlüssel; keine Server-Änderungen (fehlende Endpunkte melden).

---

## 3. Meilensteine

| # | Inhalt |
|---|---|
| B0 | Plan mit Aufwandsschätzung je Stufe, offene Fragen |
| B1 | WebSocket-Transport echt, mit Reconnect und Lückenschluss |
| B2 | Mehrknoten-Integrationstests grün in CI |
| B3 | WASM + JS/TS inkl. dokumentierter Grenzen |
| B4 | Kotlin, Swift, Dart |
| B5 | React Native, Paketierung, Konformitätstests — **Phase-2-Abschluss**, PR |

Nach jedem Meilenstein: `client-lib/README.md` und `docs/status.md` aktualisieren, eigener PR je Stufe oder gesammelt — sag mir, was dir lieber ist.
