# Changelog

Versionierung je Paket, kein gemeinsames Release-Datum oder gemeinsame Versionsnummer: `server/` (inklusive der eingebauten Weboberfläche) und `ingestion/` folgen SemVer eigenständig; `client-lib/` bleibt bei `0.x`, solange die Anbindungen (WASM/JS-TS, Kotlin, Swift, Dart, React Native) und paketübergreifende Konformitätstests fehlen — eine `1.0.0` wäre dort ein Stabilitätsversprechen, das die öffentliche API noch nicht einlöst.

## server v1.0.0 — 2026-09-28

Erster stabiler Release: self-hostbarer Relay-/Moderator-Server mit Föderation, eingebauter Weboberfläche und optionalen Zusatzfunktionen. Vollständig unabhängig geprüft, siehe [`docs/audit.md`](docs/audit.md).

**Kern (Phase 1):** Ereignisprotokoll, Snapshot-/Delta-Sync, Moderationsgate, Blitzer-Namensraum (standardmäßig aus), Client-Credential-Auth, Bulk-Import, WebSocket-Push.

**Self-Hosting & Föderation:** Docker-Image (Multi-Arch amd64+arm64) und Installation ohne Docker (Apache/nginx/Caddy); offene Mitgliedschaft mit Reputation, signierte Peer-Daten, Server-Verzeichnis, geräteseitig signierte Auth als additive Alternative zum gemeinsamen `JWT_SECRET`; echtes Mehrknoten-Testnetz in CI.

**Eingebaute Weboberfläche:** Karte mit Live-Meldungen, Tempolimit per Klick/als Straßenfarben, Melden und Bestätigen, Seiten „Verbinden" und „Über das Projekt", Deutsch/Englisch, mobil und tastaturbedienbar, abschaltbar (`WEB_UI_ENABLED=false`).

**Weitere Zusatzfunktionen:**
- „Aktuell online"-Anzeige (`GET /v1/stats/online`), datensparsam (keine IP/Position gespeichert)
- Community-Korrekturen falscher Tempolimits — Vorschlagen/Bestätigen/Widersprechen, überlagert den Import, ändert ihn nie
- Europa-Maßstab: vorgebaute, inhaltsadressierte, komprimierte Statikdaten-Pakete statt Berechnung pro Anfrage
- Dauerhafte Überwachungsanlagen (Rotlicht-/Abstandskontrolle) als additive Erweiterung der bestehenden Blitzer-Tabelle
- Performance: räumlicher Index statt Sequential Scan für Tempolimit-/Umgebungsabfragen (≈ 40× schneller gemessen)

**Zwei Fehler behoben**, die zunächst nur clientseitig toleriert wurden, nicht an der Wurzel: Zeitstempel-Felder (`reportedAt`/`expiresAt`/`occurredAt`) kamen bei Roh-SQL-Lesepfaden als Postgres-eigenes `timestamptz`-Textformat statt dem dokumentierten RFC 3339 zurück; `sequence`/`snapshotSequence`/`nextSince` kamen als JSON-*String* statt Zahl zurück. Beide durch eigene Postgres-Parser für die betroffenen zwei Spaltentypen behoben (`server/src/db/raw-sql-types.ts`), nicht durch Nacharbeit an jeder einzelnen Abfragestelle.

**Bekannt offen, kein Grund gegen dieses 1.0 (siehe [`docs/todo.md`](docs/todo.md), [`docs/audit.md`](docs/audit.md) Abschnitt 10):** `docs/privacy.md` ist ein Entwurf ohne rechtliche Prüfung; Betreiberbedingungen für fremde Knoten fehlen; der Blitzer-Namensraum bleibt bis zur rechtlichen Prüfung aus; die Autobahn-API-Lizenz ist ungeklärt (Quelle bleibt abgeschaltet). Alles Betreiber-/Rechtsfragen, keine Code-Mängel.

## ingestion v0.2.0 — 2026-09-28

**Bewusst kein `1.0.0`:** Das Paket ist ein optionaler, austauschbarer Client gegen die öffentliche Bulk-Import-API, kein Kernbestandteil. Der Quellenkatalog ist noch in Bewegung (mehrere Quellen mangels geklärter Lizenz abgeschaltet), ein wiederkehrender Aktualisierungslauf ist bewusst nicht Teil dieses Stands — eine `1.0` wäre ein Stabilitätsversprechen, das dieses Paket noch nicht geben will.

- OSM-Bulk-Import, regionsparametrisiert, mit Wiederaufnahme nach Abbruch und `DE:*`-Sonderfällen für implizite Tempolimits
- Europa-Grundstock einmalig importiert (13,68 Mio. Zeilen, Bericht in `ingestion/docs/europe-run-report.md`)
- Quellenkatalog: Baustellen (DATEX II v2/v3, Autobahn-JSON), amtliche Verkehrszeichen (NVDB Norwegen)
- Qualitätsbericht (`npm run report:quality`), vollständige Quellen-Attribution
- HERE/TomTom/Mobilithek katalogisiert, standardmäßig abgeschaltet (keine Zugänge bzw. keine Lizenzentscheidung)

## client-lib v0.1.0 — unverändert, kein 1.0-Release

**Bleibt bei `0.x`:** der plattformunabhängige Kern ist fertig und gegen ein echtes Mehrknoten-Testnetz verifiziert — Kryptografie, Server-Discovery mit Mehrserver-Failover, Sync-Engine mit echtem WebSocket-Push (Wiederverbindung, Lückenschluss), Offline-Schreibpuffer, lokales Map-Matching, Tempolimit-Korrekturen, „aktuell online"-Anzeige. Ein C-ABI und ein erstes Binding (Python) existieren. Es fehlen noch: WASM/JS-TS, Kotlin, Swift, Dart, React Native und Konformitätstests über mehrere Anbindungen hinweg — siehe [`client-lib/README.md`](client-lib/README.md), „Was noch fehlt". Bis die stehen, ist die öffentliche API nicht stabil genug für ein Versprechen wie `1.0.0`.
