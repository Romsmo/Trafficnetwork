# Prompt für Claude Code — Überarbeitung Client-Bibliothek: Föderiertes Netzwerk (Phase F-Client)

> **Scope:** Überarbeitung von `client-lib/` im Monorepo `https://github.com/Romsmo/Trafficnetwork` (privat, Owner: Romsmo), damit die Bibliothek mit dem **föderierten Server-Netzwerk** arbeitet: Server selbst finden, Anfragen verteilen, bei Ausfall wechseln, alle Daten per Signatur prüfen und Meldungen gerätesigniert senden.
>
> **Voraussetzung:** Die Server-Überarbeitung (`docs/prompt-rework-server-federation.md`, Meilensteine F-S0 bis F-S5) ist abgeschlossen und nach `main` gemergt. Falls nicht: **abbrechen und mir melden.**
>
> **Maßgeblich:** `docs/federation.md` (vollständig lesen), `docs/concept.md`, `docs/prompt-phase2-client-lib.md` (ursprünglicher Auftrag), `client-lib/README.md` + vorhandene Doku, `server/docs/api.md`, `server/docs/federation-protocol.md`, `server/docs/threat-model.md`.

---

## 0. SETUP — REPO SELBST KLONEN & STAND PRÜFEN

1. Prüfe, ob du in einem Klon von `Romsmo/Trafficnetwork` bist (`git remote -v`). Falls ja: `git checkout main && git pull`. Falls nicht: `git clone https://github.com/Romsmo/Trafficnetwork.git` (alternativ `gh repo clone` oder SSH), `cd Trafficnetwork`.
2. Repo ist **privat** — bei Auth-Fehler: Fehlermeldung zeigen, Optionen nennen (`gh auth login`, SSH-Key, PAT). Nie nach Geheimnissen fragen, nichts davon in Dateien.
3. **Stand feststellen und mir berichten:** Welche Phase-2-Meilensteine (P2.1–P2.5) sind in `client-lib/` tatsächlich umgesetzt und gepusht? Ist die Server-Föderation gemergt? CI grün?
   - Ist `client-lib/` **noch leer oder unvollständig**: dann baue die fehlenden Phase-2-Teile gleich föderationsfähig (Auftrag aus `docs/prompt-phase2-client-lib.md` gilt weiter, dieser Prompt ergänzt/ersetzt die betroffenen Stellen).
   - Ist Phase 2 **fertig**: überarbeite gezielt die betroffenen Module.
4. Branch `rework/client-lib-federation`, Push nach jedem Meilenstein, Merge per Pull Request nach meiner Freigabe.

---

## ROLLE & ARBEITSWEISE

Wie in `docs/prompt-phase2-client-lib.md`: erst planen (Plan-Modus), bei Unklarheit fragen, nichts erfinden (Belege), inkrementell grün, Code/Doku Englisch, Rückfragen Deutsch. Die Anforderung **„maximal kompatibel"** (Android, iOS/macOS, Flutter, React Native, C-ABI inkl. Python/Node, Web/WASM) gilt unverändert — **alle** neuen Funktionen müssen im gemeinsamen Kern liegen und über alle Bindings gleich funktionieren. Öffentliche API: SemVer; brechende Änderungen nur mit Major-Version und Migrationshinweis.

---

## 1. VERBINDLICHE ENTSCHEIDUNGEN

- **Keine feste Server-Adresse nötig:** Die Host-App muss nichts konfigurieren; die Bibliothek bringt Seed-Liste + öffentlichen Netzwerk-Wurzelschlüssel mit (per Build-Konfiguration überschreibbar, z. B. für Forks/eigene Netze). Domain existiert noch nicht → Platzhalter `trafficnetwork.example`, zentral an einer Stelle.
- **Server sind nicht vertrauenswürdig:** Jede empfangene Konfiguration, jedes Verzeichnis, jedes statische Paket und jedes Ereignis wird vor dem Einspielen kryptografisch geprüft; Ungültiges wird verworfen und der liefernde Server intern abgewertet.
- **Gerätesignierte Identität:** Schlüsselpaar wird auf dem Gerät erzeugt, der private Schlüssel liegt nur im sicheren Speicher der Plattform (Keystore/Keychain/… über das bestehende `secureStore`-Interface; im Browser WebCrypto mit nicht exportierbarem Schlüssel, Einschränkungen dokumentieren). Registrierung per App-Schlüssel-Zertifikat. Bestehende Geräte-Credentials migrieren.
- **Blitzer-Daten nur**, wenn die **signierte Netzwerk-Konfiguration** sie freigibt **und** die Host-App sie aktiviert hat (Standard aus).
- **Datenschutz:** Standort verlässt das Gerät nur als grobe H3-Tiles/Meldungen; Anfragen werden über mehrere Server gestreut, damit kein einzelner Betreiber das vollständige Bewegungsprofil sieht; keine Telemetrie.

---

## 2. ENTSCHEIDUNGEN, DIE DU TRIFFST (mit Begründung)

1. **Server-Auswahlstrategie** (Region/Tile-Nähe, Latenz, Last, Reputation, Streuung, Anzahl paralleler Server).
2. **Failover & Backoff** (Erkennung, Umschalten, Rückkehr, Umgang mit 503 + Alternativen).
3. **Sync beim Serverwechsel** gemäß dem in der Server-Überarbeitung gewählten server-unabhängigen Sync-Punkt.
4. **Stichproben-Prüfung** (wie oft und wie gegen mehrere Server abgleichen, um zurückgehaltene Daten zu erkennen) — akku- und datensparsam.
5. **Verzeichnis-Cache & Aktualisierung** (Intervalle, Gültigkeit, Verhalten ganz ohne erreichbaren Seed).

---

## 3. ARBEITSPAKETE

1. **Discovery-Modul:** eingebaute Seeds + Wurzelschlüssel, signiertes Verzeichnis laden/prüfen/cachen (auch von Mirrors), Server-Bewertung lokal, optionale feste Server der Host-App, Discovery abschaltbar.
2. **Transport-Schicht:** Mehrserver-fähig (Pool), Lastverteilung, Failover, WebSocket-Push mit Wechsel auf anderen Server inkl. Lückenschluss; bestehendes austauschbares Transport-Interface bleibt.
3. **Kryptografie im Kern:** Signaturprüfung (Konfiguration, Verzeichnis, Pakete, Ereignisse), Gerätesignatur für Meldungen/Bestätigungen/Anfragen; etablierte Bibliotheken, auf allen Zielen inkl. WASM lauffähig.
4. **Sync-Engine anpassen:** server-unabhängiger Sync-Punkt, Neu-Snapshot nur der abonnierten Tiles beim Wechsel, Paket-Updates von beliebigem Server mit Hash-Prüfung.
5. **Offline-Schreibpuffer:** signierte Meldungen puffern; Senden an beliebigen verfügbaren Server; idempotent über Ereignis-Hash (doppeltes Senden an mehrere Server unschädlich).
6. **Öffentliche API ergänzen** (Skizze, final im Plan): `getNetworkStatus()` → { knownNodes, activeNodes, currentNodes[], directoryVersion, configVersion }, Konfigurationsoptionen `nodes` (feste Server), `discovery: on|off`, `networkRootKey`/`seeds` (für Forks). Bestehende Aufrufe bleiben semantisch gleich.
7. **Doku:** `client-lib/docs/api.md`, Integrations-Guides pro Plattform, neuer Abschnitt „Netzwerk & Datenschutz" (was sieht welcher Server).

---

## 4. TESTS

- Unit: Signaturprüfung, Auswahlstrategie, Backoff, Sync-Punkt-Logik.
- Integration gegen das **Mehrknoten-Testnetz** aus der Server-Überarbeitung: Kaltstart nur mit Seeds, Ausfall des aktuellen Servers mitten im Sync, bösartiger Server (gefälschte Daten → verworfen; zurückgehaltene Daten → erkannt), Serverwechsel ohne Datenverlust/Duplikate, Offline-Meldungen an anderen Server gesendet, Blitzer-Freigabe nur über signierte Konfiguration, Einzelserver-Konfiguration (Discovery aus), leeres Netz gültig.
- Konformitätstests über Bindings (mind. C-ABI, eine Mobile-Plattform, WASM) für Discovery/Failover/Signaturen.

---

## 5. NICHT-ZIELE

Keine Server-Änderungen (nur Fehler melden), kein Ingestion-Code, keine App/UI, keine Veröffentlichung in Paket-Registries ohne Freigabe, kein echter Wurzelschlüssel (Tests mit Test-Schlüsseln).

---

## 6. MEILENSTEINE

| # | Inhalt |
|---|---|
| F-C0 | Stand geprüft (Phase 2 fertig oder nicht), Entscheidungen Abschnitt 2, Plan + API-Änderungen + Migrationspfad vorgelegt |
| F-C1 | Kryptografie im Kern + gerätesignierte Identität + Migration bestehender Geräte |
| F-C2 | Discovery-Modul + Mehrserver-Transport + Failover |
| F-C3 | Sync-Engine & Offline-Puffer föderationsfähig, Stichproben-Prüfung |
| F-C4 | Bindings aktualisiert, Konformitätstests grün |
| F-C5 | Mehrknoten-Integrationstests grün, Doku aktualisiert — **Abschluss**, Pull Request |

Nach jedem Meilenstein: `client-lib/README.md` und `docs/todo.md` aktualisieren, Commit + Push, kurze Zusammenfassung.

---

## 7. WAS ICH VOR DEM CODE VON DIR ERWARTE

1. Kurzbericht zum tatsächlichen Stand von `client-lib/` und der Server-Föderation.
2. Entscheidungen zu Abschnitt 2 mit Begründung.
3. Architektur-Skizze (Discovery, Transport-Pool, Krypto, Sync) und API-Änderungen.
4. Migrationspfad für bestehende Integrationen/Geräte.
5. **Liste offener Fragen an mich.**
