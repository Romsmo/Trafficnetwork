# Den Server aktualisieren

Für einen laufenden Knoten mit Docker (`server/docker-compose.yml`, der empfohlene Weg) und für einen Knoten ohne Docker.
Datenbank, Knotenidentität und Pakete bleiben erhalten; die **Migrationen laufen beim Start automatisch**. Ein Update braucht
keine Abstimmung mit anderen Knoten (die Föderation ist abwärtskompatibel, ein kurzer Ausfall wird toleriert).

Die Befehle sind (in der Git Bash unter Windows) auf einem frischen Stack durchgespielt: Installation von `server-v1.0.0`, ein Datensatz, Sicherung, Update auf
`server-v1.2.0` (Migrationen 11 → 14, Datensatz noch da, Weboberfläche meldet 1.2.0), danach der Weg zurück aus der Sicherung
(wieder 1.0.0, Datensatz da, die neuen Tabellen weg).

## Auf einen Blick (Docker)

Im Ordner `server/` des Klons (dort liegen `docker-compose.yml` und `.env`):

```bash
# 1. Sicherung der Datenbank (landet als vorher.dump im aktuellen Ordner)
docker compose exec -T postgres sh -c 'pg_dump -U $POSTGRES_USER -Fc $POSTGRES_DB -f /tmp/vorher.dump'
docker compose cp postgres:/tmp/vorher.dump ./vorher.dump
docker compose exec -T postgres sh -c 'rm -f /tmp/vorher.dump'

# 2. den neuen Stand holen (ein Release-Tag, z. B. server-v1.2.0)
git fetch --tags
git checkout server-v1.2.0

# 3. neu bauen und starten (die Migrationen laufen vor dem Start des Servers)
docker compose up -d --build

# 4. prüfen
curl http://localhost:3000/v1/health
curl -s http://localhost:3000/web-config.json | grep -o '"version":"[^"]*"'
```

`3000` ist der Standard-Port; steht in `.env` ein anderer `PORT`, nimm den. Die Einzelzeichen-Anführungszeichen um `sh -c '…'` sind Absicht: die Variablen sollen im Container ausgewertet werden, nicht auf
deinem Rechner (und sie enthalten kein eingebettetes `"`, das die Windows-PowerShell verschlucken würde). Unter Linux und in der
Git Bash sind die Zeilen geprüft; für die PowerShell sind sie so geschrieben, dass sie gleich laufen, ohne eigenen Lauf.

## 1. Vorher

**Welche Version läuft, welche kommt?**

```bash
curl -s http://localhost:3000/web-config.json | grep -o '"version":"[^"]*"'   # läuft jetzt
git tag -l "server-v*"                                                         # verfügbare Versionen
```

Lies den passenden Abschnitt `## server v…` in [`CHANGELOG.md`](../CHANGELOG.md): was neu ist, was sich im Verhalten ändert,
welche Einstellungen dazugekommen sind. Mehrere Versionen auf einmal zu überspringen ist in Ordnung (die Migrationen laufen der
Reihe nach durch); lies dann alle Abschnitte dazwischen.

**Sicherung.** Die Datenbank ist das Einzige, was der Server nicht aus dem Code wiederherstellen kann (Meldungen, Tempolimits,
Blitzer, Stimmen, Straßennetz und die **Knotenidentität**, mit der andere Knoten dich kennen). Mach die Sicherung aus Schritt 1
vor jedem Update, und bewahre `vorher.dump` außerhalb des Servers auf. Die Pakete der statischen Daten (Volume
`static-packages`) sind abgeleitet und werden bei Bedarf neu gebaut.

**Neue Einstellungen.** Neue Variablen haben einen sinnvollen Standard und müssen nicht gesetzt werden; ob du bei einer
(vor allem Datenschutz-)Voreinstellung anders entscheiden willst, siehst du hier: Variablen, die in `.env.example` stehen, aber
nicht in deiner `.env`:

```bash
# Bash
comm -13 <(grep -oE '^[A-Z0-9_]+=' .env | sort -u) <(grep -oE '^[A-Z0-9_]+=' .env.example | sort -u)
```

```powershell
# PowerShell
$mine = Get-Content .env | Where-Object { $_ -match '^[A-Z0-9_]+=' } | ForEach-Object { ($_ -split '=')[0] }
Get-Content .env.example | Where-Object { $_ -match '^[A-Z0-9_]+=' } | ForEach-Object { ($_ -split '=')[0] } | Where-Object { $mine -notcontains $_ }
```

Alles in `.env` erreicht den Server (auch Variablen, die nicht in `docker-compose.yml` aufgezählt sind). Wenn du eine neue
Einstellung setzen willst, trag sie in `.env` ein, bevor du in Schritt 3 neu startest.

## 2. Aktualisieren (Docker)

```bash
cd Trafficnetwork/server
git fetch --tags
git checkout server-v1.2.0        # der Tag, den du willst; für den neuesten Stand von main: git checkout main && git pull
docker compose up -d --build
```

- **`--build` ist nötig.** Compose benutzt ein schon gebautes Image gleichen Namens weiter; ohne `--build` startet der alte Code.
- Der Container startet erst die Migrationen (`node dist/db/migrate.js`) und dann den Server (`Dockerfile`, `CMD`). Während
  das läuft, antwortet der Server nicht. Das ist bei den neueren Versionen nach Sekunden vorbei: die Migrationen `0011` bis `0013`
  legen nur neue Tabellen und Spalten mit Voreinstellung an und schreiben keine bestehende Tabelle um.
- **Große Knoten, ältere Stände:** Wer von einem Stand **vor** den Tempolimit-Korrekturen (Migration `0007`) mit sehr vielen
  Segmenten kommt, braucht ein Wartungsfenster (etwa 20–30 Sekunden je Million Segmente) — siehe
  [`server/docs/operating.md`](../server/docs/operating.md), Abschnitt „Migrations that take a heavy lock“. Die Migration nicht
  unterbrechen; ein Abbruch rollt sie vollständig zurück und der nächste Start beginnt von vorn. Der Container kann in dieser
  Zeit als `unhealthy` angezeigt werden, er wird nicht neu gestartet.
- Mit dem Reverse Proxy Caddy aus dem Stack: `docker compose --profile with-caddy up -d --build`.
- **Nie `docker compose down -v`** (oder `docker volume rm …`): `-v` löscht die Datenbank und damit die Knotenidentität.
  `docker compose down` und `docker compose up -d` ohne `-v` lassen die Daten stehen.

## 3. Danach prüfen

```bash
docker compose ps                                    # beide Dienste „healthy“
curl http://localhost:3000/v1/health                 # {"status":"ok","database":"ok"}
curl -s http://localhost:3000/web-config.json | grep -o '"version":"[^"]*"'   # die neue Version
docker compose logs --tail 30 server | grep -i -E "migrat|listening|warning"  # „Migrations complete.“, „Server listening“
```

- Kurz nach dem Start baut der Server die vorgefertigten Pakete der statischen Daten bei Bedarf neu (im Hintergrund); in dieser
  Zeit kann `GET /v1/static-data/manifest` mit `503 PACKAGES_BUILDING` antworten — Clients versuchen es wieder.
- Öffne die Weboberfläche (`http://localhost:3000/`), tipp auf eine Straße, melde im Test eine Gefahr.
- Die Betriebsbefehle für das Straßennetz und die als fehlerhaft gemeldeten Einträge (`npm run roads -- status`, seit 1.1.0)
  brauchen den Quelltext und eine `DATABASE_URL`; das Image enthält nur den gebauten Server. Siehe
  [`server/docs/road-network.md`](../server/docs/road-network.md).

## 4. Zurück auf die alte Version

Eine Migration lässt sich nicht rückwärts ausführen; der Weg zurück ist die **Sicherung aus Schritt 1** plus der alte Code. Alles,
was seit der Sicherung in die Datenbank geschrieben wurde (Meldungen, Stimmen), geht dabei verloren.

```bash
docker compose stop server
docker compose cp ./vorher.dump postgres:/tmp/vorher.dump
docker compose exec -T postgres sh -c 'dropdb -U $POSTGRES_USER --force $POSTGRES_DB && createdb -U $POSTGRES_USER $POSTGRES_DB && pg_restore -U $POSTGRES_USER -d $POSTGRES_DB --no-owner /tmp/vorher.dump'
docker compose exec -T postgres sh -c 'rm -f /tmp/vorher.dump'
git checkout server-v1.1.0        # der Tag, der vorher lief
docker compose up -d --build
```

Danach wie in Schritt 3 prüfen (die Version muss die alte sein). Hast du keine Sicherung, bleibt nur vorwärts: den Fehler melden
und auf die nächste Version aktualisieren, nicht die Datenbank von Hand zurückbauen.

## 5. Ohne Docker

```bash
cd Trafficnetwork/server
pg_dump -Fc -f vorher.dump "$DATABASE_URL"         # Sicherung
git fetch --tags
git checkout server-v1.2.0
npm ci
npm run build
npm run db:migrate:prod                            # Migrationen
sudo systemctl restart trafficnetwork-server       # bei der Beispiel-Unit aus server/deploy/ (sie migriert beim Start ohnehin)
curl http://localhost:3000/v1/health
```

Die Beispiel-Unit `server/deploy/trafficnetwork-server.service` führt `node dist/db/migrate.js` vor jedem Start aus; der
separate Schritt `npm run db:migrate:prod` ist dann nur der Vorab-Lauf, um Fehler zu sehen, bevor der Dienst neu startet. Zurück:
`pg_restore` der Sicherung in eine neu angelegte Datenbank, alten Tag auschecken, `npm ci && npm run build`, Dienst neu starten.

## Was bei den Versionen zu beachten ist

| Von → nach | Migrationen | Zu beachten |
|---|---|---|
| 1.1.0 → 1.2.0 | keine | **Ortssuche** auf der Karte: der Knoten fragt standardmäßig den öffentlichen Dienst `nominatim.openstreetmap.org` (Suchbegriff und gerundeter Kartenausschnitt, nicht die Adresse der Besucher). Das willst du nicht? `PLACE_SEARCH_URL=none` in `.env` (die Suche verschwindet) oder einen eigenen Dienst eintragen. Die Datenschutzseite nennt den Dienst; prüfe ihren Text. [`server/docs/place-search.md`](../server/docs/place-search.md) |
| 1.0.0 → 1.1.0 | `0011` bis `0013` (neue Tabellen/Spalten, keine Sperre) | Neue Verfallszeiten für Blitzer-Meldungen, eigene Dauer je Meldung, Tempolimit-Vorschläge für ein Stück Straße (zwei Punkte), Straßennetz (der Knoten fragt bei Bedarf einen Straßendatendienst, standardmäßig eine öffentliche Overpass-Instanz: `ROAD_LOOKUP_URL=none` schaltet es ab), Schilder/Kameras werden an Straßen gebunden (in Gebieten, deren Straßen der Knoten kennt, werden Einträge abseits jeder Straße nicht ausgeliefert), „Fehlerhaften Eintrag melden“. Im Hintergrund läuft alle paar Minuten ein Anbindungsschritt; hat der Knoten Schilder oder Kameras in Gebieten, deren Straßen er nicht kennt, fragt er dabei je Durchlauf wenige Gebiete beim Straßendatendienst an (`ROAD_ATTACH_TILES_PER_RUN`). [`server/docs/road-network.md`](../server/docs/road-network.md), [`CHANGELOG.md`](../CHANGELOG.md) |

## Wenn etwas nicht klappt

| Beobachtung | Ursache / Abhilfe |
|---|---|
| Nach dem Update meldet die Weboberfläche die alte Version | `docker compose up -d --build` ohne `--build` gelaufen, oder `git checkout` hat den Tag nicht gefunden (`git fetch --tags`; `git status`). |
| `git checkout` bricht ab („local changes would be overwritten“) | Du hast Dateien im Klon geändert. `git status` zeigen lassen; eigene Änderungen mit `git stash` beiseite legen (`.env` ist ignoriert und bleibt). |
| Der Server-Container startet immer wieder neu | `docker compose logs --tail 100 server`: meist eine fehlende oder ungültige Einstellung (der Server nennt die Variable beim Namen) oder eine fehlgeschlagene Migration (Fehlermeldung am Ende der Migrationsausgabe). Migration fehlgeschlagen = nichts wurde geändert, sie läuft beim nächsten Start von vorn. |
| `docker compose` meldet „POSTGRES_PASSWORD must be set“ | Du bist nicht im Ordner `server/` oder `.env` fehlt dort. |
| Die Datenbank ist nach `down -v` leer | Aus der Sicherung wiederherstellen (Schritt 4, ohne den `git checkout`); die Knotenidentität ist dann dieselbe wie in der Sicherung. |

## Fertige Images (optional)

Zu jedem Server-Release gibt es ein Image `ghcr.io/romsmo/trafficnetwork-server:<version>` (Prüfsumme/Digest in den
Release-Notizen, `checksums.txt`). Der Compose-Stack im Repo **baut aus dem Quelltext** (`build:` in `docker-compose.yml`) — das
ist der getestete Weg und das Gleiche wie das Release-Image (dasselbe `Dockerfile`). Wer das fertige Image verwenden will,
meldet sich bei `ghcr.io` an (`docker login ghcr.io`; die Pakete sind privat, solange der Betreiber sie nicht freigibt) und ersetzt
im `server`-Dienst der Compose-Datei `build:` durch `image: ghcr.io/romsmo/trafficnetwork-server:<version>`; `docker compose pull
server && docker compose up -d` aktualisiert dann. (Dieser Weg ist nicht durchgespielt; getestet ist der Bau aus dem Tag.)
