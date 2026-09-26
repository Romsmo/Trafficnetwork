# Roadworks import (add-on Q3) — operation and cost

Roadworks are **time-limited reports** (`construction`), not static data, so the importer is built to run **periodically**:
one invocation is one poll pass over the enabled feeds, then it exits. *When* it runs is the operator's scheduler's business.

```powershell
npm run ingest -- --roadworks                    # one pass over every enabled feed
npm run ingest -- --roadworks --dry-run          # read and parse the feeds, report what would be sent, send nothing (needs no server login)
npm run ingest -- --roadworks --feed fr-tipi-rrn # only this feed (it must be enabled, or switched on, see below)
npm run report:quality                           # what every source took over, discarded and merged (from STATE_DIR)
```

Exit code: `0` if every feed that ran was read (a feed reported `incomplete` is *not* a failure — see "Safety rules"),
`1` if any feed could not be read or sent. A scheduler can alert on `1`.

## The feeds

Feeds are configuration: `config/roadworks-feeds.json`. Live numbers were measured on 2026-09-26 with `--dry-run`.

| Feed id | Source | License (Ampel) | On by default | One pass costs | Roadworks active at that moment |
|---|---|---|---|---|---|
| `fr-tipi-rrn` | France, national non-conceded network (Bison Futé / DIR), DATEX II 2.0, hourly aggregate | Licence Ouverte 2.0, attribution (**frei**) | **yes** | 1 request, 3.4 MB | 103 of 613 records (18 with a timing detail not evaluated) |
| `nl-ndw` | Netherlands, NDW planning feed, DATEX II v3 | not confirmed in NDW's own text (**ungeklärt**) | no | 1 request, 18.2 MB (gzip) | 4,586 of 67,330 records |
| `de-autobahn` | Germany, Die Autobahn GmbH des Bundes, own JSON API (not DATEX II) | none stated by the publisher (**ungeklärt**) | no | 109 requests, 6.8 MB | 1,642 of 3,058 entries |

`ungeklärt` sources ship `enabled: false` and stay off until the operator decides (the reasons are in `docs/sources.md`).
Every row a feed writes carries its license text as `sourceLicense` (`ungeklärt` for the Autobahn API, so a source can be found and removed later).

Switches, strongest first:

1. `ROADWORKS_ENABLED=false` — kill switch for everything.
2. `ROADWORKS_FEEDS_OFF=de-autobahn,…` — these feeds do not run, whatever else says so.
3. `ROADWORKS_FEEDS_ON=nl-ndw,…` — turn a disabled feed on, on purpose. (`AUTOBAHN_API_ENABLED=true`, the switch this source had from the start, still enables `de-autobahn`.)
4. `enabled` in `config/roadworks-feeds.json`.

Other settings: `ROADWORKS_LOOKAHEAD_MINUTES` (default 30: a roadwork that starts within this time is already announced),
`ROADWORKS_MERGE_RADIUS_METERS` (default 250: see "The same roadwork in two feeds"), `ROADWORKS_FEEDS_CONFIG_PATH`.
Per feed in the JSON: `minIntervalMinutes` (the importer will not fetch this feed more often, whatever the scheduler does), `ttlHours`,
`maxFeedAgeHours` (default 24), `requestDelayMs` (Autobahn: pause between the per-road requests).

## Scheduling

Any scheduler works; a pass takes seconds (FR) to about half a minute (Autobahn: 109 requests, 250 ms apart). Suggested: every 60 minutes.
`minIntervalMinutes` makes a too-frequent schedule harmless: the feed is skipped and the run says so.

**Windows Task Scheduler** (runs only while the PC is on — see "What a permanent operation costs"):

```powershell
$action  = New-ScheduledTaskAction -Execute "npm.cmd" -Argument "run ingest -- --roadworks" -WorkingDirectory "D:\Recent\Projects\TrafficNetwork\ingestion"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "Trafficnetwork roadworks" -Action $action -Trigger $trigger
```

**cron** (`crontab -e`): `7 * * * * cd /opt/trafficnetwork/ingestion && npm run ingest -- --roadworks >> /var/log/tn-roadworks.log 2>&1`

**systemd**: a `oneshot` service running the same command and a timer with `OnCalendar=hourly` and `Persistent=true`.

Credentials (`SERVER_URL`, `CLIENT_ID`, `CLIENT_SECRET`, a client with the `bulk-import` scope) come from `ingestion/.env`, as for every other run.

## What a permanent operation costs

There is no money involved: none of the three feeds needs an account, key or fee. What it costs:

| | Hourly | Every 30 min |
|---|---:|---:|
| Download, FR | 82 MB/day | 165 MB/day |
| Download, DE (Autobahn API, 109 requests/pass) | 163 MB/day, 2,600 requests/day | 327 MB/day, 5,200 requests/day |
| Download, NL (NDW, if switched on) | 436 MB/day | 872 MB/day |

* **Being polite to the publishers is the real limit.** The Autobahn API states no limits; ~2,600 requests a day from one client is what the tool does by default at an hourly schedule, spaced 250 ms apart.
  Do not shorten `minIntervalMinutes` for feeds you do not run yourself without a reason.
* **Server load**: each pass sends every roadwork that is active (FR ≈ 100, DE ≈ 1,600, NL ≈ 4,600 rows) as an upsert. Rows that did not change only get their expiry renewed; an event for clients is created only when a roadwork is new, returns, moves more than 100 m or changes its end date. The server hard-deletes expired reports after its retention period, so the table does not grow without bound.
* **A machine that is on**: a scheduler on a PC only works while the PC runs. That is by design safe: a roadwork without an end date lives `ttlHours` (FR 72 h, DE 48 h) and is renewed on every sighting, so if the importer stops, its roadworks **expire by themselves** instead of standing on the map forever.
* **Attention**: an exit code `1`, or a feed reported `incomplete` for days, means a feed changed format or stopped. `npm run report:quality` shows the last pass of every feed.

## Safety rules (why an empty or broken feed can not wipe the map)

A roadwork that disappears from a feed must end on the server — but "disappeared" must never be inferred from a bad read.

* A feed **not read completely** (truncated download, one failed Autobahn road request, a document that does not parse to its end) is still used for what it delivered, but **retires nothing**, and its pass does not count as a success.
* A feed whose own publication time is **older than `maxFeedAgeHours`** (it silently stopped updating) is treated the same way.
* A pass with **nothing active** neither posts nor retires; the server itself refuses to retire on an empty run (`409 SEED_RUN_EMPTY`). Such rows end by their own expiry.
* A feed that **cannot be read at all** sends nothing, retires nothing, and does not affect the other feeds.
* Retiring is a separate step after every batch was accepted: a pass that failed while sending retires nothing.

## The same roadwork in two feeds

Feeds are compared in the order of `config/roadworks-feeds.json` (first = highest priority). A roadwork of a lower-priority feed is **left out**
when a higher-priority feed has one within `ROADWORKS_MERGE_RADIUS_METERS` whose time interval overlaps. Roadworks of the *same* feed are never merged with each other.
The count is in the run report (`mergedIntoOtherFeed`). If the higher-priority feed failed to load, the lower one keeps its own roadwork.

## How times become "active now"

* Explicit windows (a night work `21:00–06:00` on given days): active **only while a window runs** (or starts within the lookahead); the report expires at that window's end and the next pass brings the next window.
* Overall start/end: active from start until end. No times at all: the feed's `ttlHours`, renewed at every pass.
* Anything a reader cannot evaluate is **counted, not guessed**: DATEX II recurring patterns and suspended records are skipped with a reason; a `validPeriod` that carries only a *name* (the French feed writes "Uniquement de nuit" / "Uniquement de jour" in every one of its 120 periods) is sent on its overall dates and **counted as a caveat** in the report (`sentWithCaveat`), because the data does not say which hours that means.
* A time without a zone offset is never given one.

## Adding a country that publishes DATEX II

It is a new entry in `config/roadworks-feeds.json`, not new code — *if* the document is DATEX II v2 or v3 with `MaintenanceWorks` / `ConstructionWorks` records:

```json
"xx-example": {
  "enabled": false, "kind": "datex2", "country": "XX",
  "name": "Example country - roadworks",
  "url": "https://…", "sourceLicense": "the license text as the publisher states it",
  "attribution": "the credit line the license asks for", "minIntervalMinutes": 60, "ttlHours": 72,
  "notes": "where the license was read, and when"
}
```

Before switching a feed on: read the publisher's terms (redistribution must be allowed — `docs/sources.md` has the rule and the Ampel), check whether registration or a key is needed (the importer has no support for either, on purpose), and run `--dry-run --feed xx-example` to see what it makes of the document. The reader handles gzip by content, any namespace prefix, WGS 84 as `pointCoordinates` or GML `posList` (axis order from `srsName`; any other coordinate system is skipped and reported, never guessed).
It does **not** handle: DATEX II payloads with a proprietary extension as their only location, feeds that need a login or client certificate (Germany's Mobilithek, Austria's mobilitaetsdaten.at, Switzerland's opentransportdata.swiss), or JSON dialects — those need an adapter of their own (`autobahn-de-json` is the example).

## Known limits

* A roadwork is stored as **one point** (the start of the affected stretch); the server has no geometry for hazard reports.
* The Autobahn API gives its times only as German text; three shapes plus recurring weekday phrases are understood (`pipeline/roadworks/autobahn-de.ts`), 7 of 3,058 entries on 2026-09-26 were not evaluable and are reported as skipped. Its own `future` flag is not used (undocumented, and wrong for works starting in days).
* Seed reports are **not federated** to other servers and pass no moderation gate; they are the operator's imported data, marked `source: seed` with `source_feed`, `external_id` and the license.
* To remove a feed's data completely: `delete from hazard_reports where source_feed = 'de-autobahn';` (or stop it: its rows expire within `ttlHours`).
