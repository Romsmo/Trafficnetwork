# ingestion

Optionales Ingestion-Programm zur Erstbefüllung der Datenbank (OSM, Autobahn-API, HERE, TomTom, weitere kostenlose Quellen). **Kein Kernbestandteil des Systems** — läuft nur als gewöhnlicher Client gegen die öffentliche Bulk-Import-API von `server/`, ohne privilegierten Zugriff. Jederzeit abschaltbar oder ersetzbar, ohne dass `server/` oder `client-lib/` sich ändern müssen.

**Status**: Noch nicht implementiert — Phase 3 des Projekts, startet erst nach Abschluss von Phase 2 (`client-lib/`). Details siehe [`docs/concept.md`](../docs/concept.md) (Abschnitt 7) und [`docs/todo.md`](../docs/todo.md).
