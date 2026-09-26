# Zusatz-Prompts — Grundstock auf ganz Europa erweitern (einmalig, aktueller Stand)

> **Entscheidung des Betreibers:**
> 1. Der Grundstock deckt **ganz Europa** ab, eingespielt **einmalig mit dem aktuellsten verfügbaren Stand**. Ein regelmäßiger Aktualisierungslauf ist jetzt **nicht** Teil des Auftrags — der Weg dorthin wird aber offengehalten (siehe A.5).
> 2. Am Konzept „statische Daten vollständig an jedes Gerät" wird **festgehalten**. Ob das für Handys praktikabel bleibt, wird nicht geraten, sondern nach dem Import **gemessen** und berichtet (siehe C).
>
> Vier Teile, jeder rein additiv. **Reihenfolge:** A (Ingestion) → B (Server) → C (Client-Bibliothek) und D (Weboberfläche) können parallel.

---

## A — Ingestion (Chat „Ingestion", Branch `phase3/europe-basemap`)

**Auftrag:** Den bestehenden, regionsparametrisierten OSM-Worker auf ganz Europa hochziehen und den Grundstock einmal vollständig einspielen.

1. **Quelle:** aktuellster Europa-Extrakt von Geofabrik (`europe-latest.osm.pbf`, Größenordnung 30 GB roh — aktuelle Zahl und Datum belegen). Prüfsumme prüfen, Download wiederaufnehmbar. Als Alternative prüfen und begründen, ob der Import in Länder-Extrakten statt einem Europa-Stück stabiler läuft (Speicher, Wiederaufnahme nach Abbruch).
2. **Vor dem Lauf: Machbarkeitsbericht an mich** — benötigter Plattenplatz (Rohdaten, Zwischenstände, Datenbank), Arbeitsspeicher, geschätzte Laufzeit, und wo der Lauf sinnvoll stattfindet (mein PC oder der gemietete Server). Erst danach starten.
3. **Filtern, bevor importiert wird:** nur Straßensegmente mit relevanten Merkmalen (Tempolimit, Verkehrszeichen), keine Gebäude, POIs, Landnutzung. Implizite Limits (z. B. `maxspeed=DE:urban`) entweder auflösen oder bewusst weglassen — Entscheidung dokumentieren, weil sie die Datenmenge stark beeinflusst.
4. **Robust laufen:** in Abschnitten arbeiten (z. B. pro Land oder pro Kachelgruppe), Fortschritt persistent, jederzeit abbrechbar und fortsetzbar, keine Duplikate bei Wiederaufnahme, Backoff gegen die Rate-Limits des Servers.
5. **Update-Weg offenhalten (billig, jetzt gleich mitnehmen):** Zeitstempel bzw. Sequenznummer des verwendeten Extrakts festhalten und dokumentieren, wie ein späterer Lauf auf dieser Basis nur Änderungen nachzieht (Geofabrik-Änderungsdateien). **Nicht bauen**, nur notieren, damit später kein Neustart bei null nötig ist.
6. **Community-Korrekturen nicht zerstören:** Wo bereits eine wirksame Korrektur existiert, überschreibt der Import den Wert nicht still, sondern markiert sie zur Prüfung (siehe `docs/prompt-addon-speed-limit-corrections.md`).
7. **Lizenz:** OSM ist ODbL — Provenienz auf jedem Datensatz, Attribution in Doku und Weboberfläche sicherstellen.
8. **Nach dem Lauf berichten:** Zeilen je Entität, Dauer, Datenbankgröße, Abdeckung stichprobenartig geprüft (ein paar bekannte Orte in verschiedenen Ländern), aufgetretene Fehler.

---

## B — Server (Chat „Trafficnetwork Backend", Branch `feature/europe-scale`)

**Auftrag:** Prüfen und sicherstellen, dass Speicherung und Auslieferung bei Europa-Größe tragen.

1. **Messen statt schätzen:** Datenbankgröße, Indexgrößen, Antwortzeiten der Leseendpunkte und der Paket-Erzeugung mit vollem Bestand. Ergebnisse in `server/docs/operating.md`.
2. **Statische Pakete:** Anzahl und Größe der Pakete bei Europa-Abdeckung, Größe des Manifests, Kompression, Erzeugungsdauer. Falls das Manifest unhandlich wird: Aufteilung oder Zusammenfassung vorschlagen — additiv, ohne bestehende Endpunkte zu brechen.
3. **Auslieferung:** Pakete möglichst als vorab erzeugte, zwischenspeicherbare Dateien (`ETag`/`Cache-Control`), damit ein Reverse-Proxy oder CDN sie übernehmen kann und der Server nicht bei jedem Bootstrap rechnet.
4. **Kein Ereignis-Sturm:** Der Massenimport darf das Ereignisprotokoll nicht fluten (bestehende Regel), muss aber die Paketversionen zuverlässig erhöhen.
5. **Betrieb:** Empfehlung für Plattenplatz, Arbeitsspeicher und Wartung (Autovacuum, Reindex) bei diesem Bestand; Hinweis in der Betreiber-Doku, was ein Knoten mindestens braucht.

---

## C — Client-Bibliothek (Chat „Client-Sync-Bibliothek", Branch `feature/europe-scale`)

**Auftrag:** Den vollständigen Europa-Bestand tatsächlich synchronisieren — und ehrlich berichten, was das kostet.

1. Bootstrap mit vollem Bestand durchführen und **messen**: übertragene Datenmenge, Dauer über schnelle und langsame Verbindung, Größe des lokalen Speichers, Speicherbedarf beim Einspielen, Zeit bis zur ersten Abfrage, Auswirkung auf Map-Matching und Startzeit.
2. Robustheit: Bootstrap muss unterbrechbar und fortsetzbar sein, ohne von vorn zu beginnen; bei zu wenig freiem Speicher ein klarer, abfangbarer Fehler für die Host-App statt eines Absturzes.
3. **Bericht an mich** mit den gemessenen Zahlen. Falls sich zeigt, dass ganz Europa auf typischen Handys nicht tragfähig ist: Zahlen vorlegen und Optionen vorschlagen (nur Umgebung plus wählbare Offline-Regionen wäre die naheliegende) — **aber nichts eigenmächtig umstellen**; die Entscheidung „alles auf jedem Gerät" gilt, bis ich sie ändere.
4. Rein additiv: keine Änderung der öffentlichen API außer, was für Fortschritt und Speicherfehler nötig ist.

---

## D — Weboberfläche (Chat der Weboberfläche, Branch `feature/server-web-ui`)

**Auftrag:** Die Karte auf Europa-Bestand vorbereiten.

1. Startansicht: Europa, wenn keine Position freigegeben ist; mit Position wie bisher die Umgebung.
2. Nur laden, was sichtbar ist: Abfragen an den aktuellen Kartenausschnitt binden, bei weit herausgezoomter Ansicht keine Einzelmeldungen holen, sondern zusammenfassen (Cluster oder Zahl je Region).
3. Tempolimit-Abfrage bleibt punktuell (Klick), keine flächige Einfärbung über ganz Europa.
4. OSM-Attribution sichtbar; Kachelquelle konfigurierbar, weil Europa-Publikum deutlich mehr Kachelabrufe bedeutet.
