# Persistent enforcement devices (red-light, distance) in the data model — plan (D0)

Status: **implemented (D1–D4)** on `feature/persistent-enforcement-devices`, stacked on `feature/europe-scale`. The plan (D0) was
written first, before any code; the open questions in section 10 were **not answered by the operator before the final round**, so the
implementation follows the defaults named there — each is a small change if the operator decides otherwise (list in section 10).
Everything below marked *measured* was measured on 2026-09-26; everything marked *checked in code* names the file. Tests:
`tests/integration/persistent-devices.test.ts` (reads, lifecycle, flag off, packages), `persistent-devices-migration.test.ts`
(legacy data, forward, idempotent, rollback, refusal), the extended `federation-multi-node.test.ts` and `static-data-partitions.test.ts`.

## 0. What is being decided, in short

* `fixed_speed_cameras` keeps its name and gets **one column**, `camera_type` (Postgres enum, `NOT NULL DEFAULT 'fixedSpeedCamera'`).
  Every existing row is correct the moment the column exists; nothing is copied, rewritten or backfilled.
* The migration is **metadata-only**: milliseconds at any row count (*measured*, section 2). It does not need a maintenance window,
  and it is not affected by the lock policy of add-on E-B (`operating.md`, "Migrations that take a heavy lock").
* The API grows **only additively**. The one place where "additive" is not automatically safe for the clients that exist today is
  called out in section 4 (events of a new kind must not look like events of a speed camera).
* One premise of the prompt does not match the code: **fixed cameras are not federated today**, so persistent devices have nothing to
  "follow the same rules" as (section 5). This needs the operator's decision (question 2).

## 1. Data that exists today (question 1 of the prompt)

| | `tn-europe` (real Europe import, unmigrated: 0000–0006 applied) | local Bayern node |
|---|---|---|
| `fixed_speed_cameras` | **45,025** rows, all `source = osm`, 8.4 MB incl. indexes | 142 rows, 72 kB |
| `hazard_reports` | 0 | 8 |
| `event_log` | 0 | 18 |
| `camera_removal_reports` | 0 | 0 |
| `speed_limit_segments` (context) | 12,083,574 | 438,595 |

The bulk import writes no `event_log` rows (E-B), which is why the Europe node has none. The number of red-light and distance
devices the ingestion will find in OSM is not known yet (the import of `type=enforcement` relations has not been done); OSM
mapping of these is sparse, so expect far fewer than the 45 k cameras — but no number in this plan depends on it.

**How long does the migration take?** Measured in a scratch PostgreSQL 16.4 (the image the project ships), on a probe table shaped like
`fixed_speed_cameras` (uuid primary key + GiST on the point) with **1,000,000 rows — 22× the real table**:

| Statement | Time at 1 M rows |
|---|---|
| `CREATE TYPE camera_type AS ENUM (3 labels)` | 4 ms |
| `ADD COLUMN camera_type camera_type NOT NULL DEFAULT 'fixedSpeedCamera'` (**the proposed migration**) | **5 ms** — PostgreSQL ≥ 11 stores a constant default in the catalogue; no row is touched |
| variant: `ADD COLUMN … text NOT NULL DEFAULT …` + `CHECK … NOT VALID` + `VALIDATE CONSTRAINT` | 3 + 3 + 92 ms (the validation is the only part that reads the table) |
| for contrast: the same column with a *volatile* default (forces a rewrite) | 5,820 ms — this is what the migration must **not** contain |
| rollback: `DROP COLUMN` + `DROP TYPE` | 2 + 2 ms |
| rows before / after, rows carrying the default | 1,000,000 / 1,000,000 / 1,000,000 |

Run for real on the copy of the Europe node's database (after 0007/0008, 45,025 cameras): **2.1 s including the start of the Node
process**, no lock warning, all 45,025 rows `fixedSpeedCamera`. On the real 45,025 rows it is faster still (the one size-dependent statement, `VALIDATE`, would take about 4 ms). "Work in blocks" (rule 4 of the
prompt) is therefore not needed for *this* migration — there is no backfill to block. What the plan does instead is what the rule is
for: no long transaction, no lock that lasts. `ALTER TABLE … ADD COLUMN` takes `ACCESS EXCLUSIVE` for the catalogue update only.
(On `tn-europe` the migrator will still run 0007 first, which *is* the known 5-minute rewrite of the segment table; 0009 adds nothing to it.)

## 2. Schema

### 2.1 The column

```sql
-- 0009_persistent_enforcement_devices.sql (hand-guarded so that a second run changes nothing)
DO $$ BEGIN
  CREATE TYPE "public"."camera_type" AS ENUM ('fixedSpeedCamera', 'redLightCamera', 'distanceControl');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "fixed_speed_cameras" ADD COLUMN IF NOT EXISTS "camera_type" "camera_type" DEFAULT 'fixedSpeedCamera' NOT NULL;
--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE IF NOT EXISTS 'enforcementDevice';   -- see 4.3; allowed in a transaction since PostgreSQL 12
--> statement-breakpoint
-- The packages change shape (section 6): bump the static-data version once so clients refresh.
-- lock-trivial: static_data_state has exactly one row
UPDATE "static_data_state" SET "version" = "version" + 1 WHERE "id" = 1;
```

No index on `camera_type`: 45 k rows, three values, always combined with the spatial index — an index would not be used. (If a table with
millions of devices ever exists, a partial index is one `CREATE INDEX CONCURRENTLY` outside the migrator.)

### 2.2 Enum or checked text? — enum

The repository uses Postgres enums for every closed vocabulary (`camera_status`, `speed_limit_unit`, `correction_*`, `hazard_type`).
An enum is stricter (the database refuses a typo, not only the API), and it extends cheaply: `ALTER TYPE camera_type ADD VALUE 'averageSpeedCheck'`
is metadata-only and transaction-safe on PostgreSQL 16, which is exactly the "append, never reorder" rule the hazard enum already follows.
Checked text would be extended by replacing a constraint (still cheap here) but gives no additional safety. The price of an enum is that a
label can never be removed — which the append-only rule accepts. The application side is one constant, `PERSISTENT_CAMERA_TYPES`, from which the
Drizzle enum, the Zod schemas and a test that compares the constant with the labels in the database are all derived.

### 2.3 What deliberately does not change

* Table name `fixed_speed_cameras` (a rename would need a view under the old name and is a separate, later step — not proposed now).
* `hazard_reports.type` / the `hazard_type` enum: same eleven values, same order. `camera_removal_reports` and `CAMERA_REMOVAL_THRESHOLD`
  apply to every device type unchanged.
* Mobile and trailer cameras, and — by default — red-light and distance *reports* from users: still expiring `hazard_reports`.

## 3. Migration path, backup and rollback

**Forward.** Drizzle applies 0009 in the migrator's single transaction, like every migration. The SQL above is guarded (`IF NOT EXISTS`, the
`duplicate_object` handler) so it can be run by hand twice; the migrator itself never re-applies a migration it has recorded. The migrate step's
lock warning (E-B) stays silent for 0009 because there is nothing heavy in it — the lint test `tests/unit/migration-locks.test.ts` checks this.

**Before (operator).** `pg_dump -Fc` of the database, or at least `pg_dump -Fc -t fixed_speed_cameras -t camera_removal_reports -t event_log`; documented in
`operating.md`. Count check the operator can run: `select count(*) from fixed_speed_cameras;` before and after must match.

**Rollback** (`src/db/rollback/0009_persistent_enforcement_devices.down.sql`, run by hand with `psql -f`, tested):

1. Refuse (with the number of affected rows in the error message) if any row has `camera_type <> 'fixedSpeedCamera'`. Never silently reclassify a
   red-light device as a speed camera; the operator exports or deletes those rows on purpose (a `\copy` line is in the docs) and runs the script again.
2. `ALTER TABLE fixed_speed_cameras DROP COLUMN IF EXISTS camera_type;` then `DROP TYPE IF EXISTS camera_type;`.
3. `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = <0009's journal timestamp>;` — without this the next start of the new code would believe
   0009 is applied and find the column missing.
4. The extra label `enforcementDevice` in `entity_type` stays: PostgreSQL cannot drop an enum label. It is harmless (nothing writes it after the rollback).
5. Whether `static_data_version` moves back is irrelevant — a version only ever grows; clients that saw the bumped version simply refresh once more.

**Migration test with legacy data** (`tests/integration/persistent-devices-migration.test.ts`, Testcontainers): copy the migration folder into a temp
directory with the journal cut after 0008, migrate a fresh database to that state, fill it with **legacy-format** data (cameras incl. one removed camera and
removal reports, `hazard_reports` of every dynamic camera type, `event_log` rows, static segments and signs), record the responses of the old endpoints
(`nearby`, `snapshot`, static-data manifest and packages, `delta`), run the *real* migrator to 0009 and check: row counts of every table identical; every
old camera carries `fixedSpeedCamera`; every old response equals the recorded one after removing the fields the plan adds; the migration ran twice (raw SQL) without
effect; the rollback script runs, the data equals the recording again, and a second forward migration works (proving step 3 above). A second case inserts a
red-light device and asserts that the rollback refuses.

## 4. API — what changes, and why no client breaks

### 4.1 Evidence about the clients that exist

* **client-lib (Rust, `rework/client-lib-europe-scale`).** Decodes `FixedSpeedCamera` (`sync/types.rs:144`) with `type` as the closed enum `HazardType`
  (`sync/types.rs:18–32`, eleven values, **no** `#[serde(other)]`), ignores unknown JSON fields (no `deny_unknown_fields` anywhere), skips events of an unknown
  `entityType` without error (`sync/engine.rs:390–394`, a deliberate forward-compatibility rule), and does not call `/v1/speed-cameras/*` at all. Consequences:
  additive fields and arrays are safe; new *values* of a decoded enum are **not** (a `type` string outside the eleven aborts the decode of the whole snapshot/event).
* **Web UI (`feature/server-web-ui`).** Merges `/v1/speed-cameras/nearby` items into its hazard list by their own `type` (`map-page.js:125–128`), renders confirm/deny
  buttons for every item whose `type` is not `fixedSpeedCamera` (`hazard-layer.js:190`), and for a live event with `entityType === "fixedSpeedCamera"` **overwrites
  `type` with `"fixedSpeedCamera"`** (`map-page.js:151–153`).

Two rules follow. (1) A persistent red-light or distance device may use the `type` values `redLightCamera` / `distanceControl` — both are among the eleven every client
already knows — but must **not** be announced under `entityType: fixedSpeedCamera`, or the web UI would draw it as a speed camera. (2) No value outside the existing
eleven may appear in any field an existing client decodes into `HazardType` (this matters for section control, section 8).

### 4.2 Reads

| Endpoint / field | Change | Why old clients are unaffected |
|---|---|---|
| Item shape (`FixedSpeedCameraApi`) | new field `cameraType`; `type` equals `cameraType` (for every existing row: still `"fixedSpeedCamera"`) | new field is ignored by the Rust client and the web UI; `type` values are within the known eleven |
| `GET /v1/speed-cameras/nearby` | without `types`: fixed + **all** persistent devices + the four dynamic types (as the prompt asks); `types=` filters as before, now also persistent devices of a listed type (`types=redLightCamera` returns persistent **and** expiring red-light items) | the list already mixes `type` values from two tables today; the new items use values already in it. **One visible effect:** the current web UI would show confirm buttons on a persistent red-light item (they answer 404: "no active hazard report"). It is a three-line fix in the web UI (skip the buttons when `cameraType` is present); see question 3 for the alternative |
| `GET /v1/speed-cameras/by-tile` | additionally returns persistent devices of the **new** types (not `fixedSpeedCamera`, which stay excluded exactly as today) for the requested cells, found through the cells' bounding boxes and an exact H3 check (persistent devices have no `region_tile`; adding one would need a backfill) | fixed cameras' behaviour is byte-identical; the extra items are new information in an existing list (question 5) |
| `GET /v1/snapshot` | `fixedSpeedCameras`: **unchanged meaning** — only `cameraType = fixedSpeedCamera`; new `enforcementDevices`: **all** persistent devices, each with `cameraType` (duplicates the fixed cameras by design, as the prompt asks — a few MB at Europe scale) | old clients read `fixedSpeedCameras` only |
| `GET /v1/config` | new `persistentCameraTypes: [...]` next to `cameraNamespaceHazardTypes` | this is the "version hint": a client discovers whether the server knows persistent devices by looking for the key; no API version bump |
| Static packages | see section 6 | additive key, omitted when empty |
| Camera policy | every read path above is gated exactly like the cameras: by the country-based camera policy (`camera-country-policy.md`; supersedes the single `SPEED_CAMERA_NAMESPACE_ENABLED` switch, which is now the emergency brake): country not released → `[]`, no `enforcementDevices`, no packages entry; at level `zones` a zone instead of the device | unchanged rule, one more consumer |

### 4.3 Events

A change to a persistent device produces `StaticDataUpdated` / `StaticDataRemoved` as today, with `entityType`:

* `fixedSpeedCamera` for `cameraType = fixedSpeedCamera` — exactly as now;
* **`enforcementDevice`** (new, appended to the `entity_type` enum and `ENTITY_TYPES`) for the other types. The Rust client skips it, the web UI ignores it. New clients
  handle both entity types and key their store by device id. The delta type filter (`getDeltaPage`) treats it like `fixedSpeedCamera`: `payload.type` is matched against `types`.

Which changes produce events at all: removal by community votes (threshold reached) and, for fixed cameras, community creation/confirmation — as today. Bulk import writes none (E-B).

### 4.4 Writes

* **Bulk import** `POST /v1/bulk-import/speed-cameras`: optional `cameraType`, default `fixedSpeedCamera`; a call without the field is byte-for-byte today's behaviour;
  an unknown value is a 400 (validated against `PERSISTENT_CAMERA_TYPES`). Tiles are marked dirty and the static-data version bumped as today.
* **User reports.** `POST /v1/hazard-reports` with `type: "fixedSpeedCamera"` still goes to the persistent table; `redLightCamera`, `distanceControl`, mobile and trailer stay expiring reports.
  **One trap to close:** the duplicate-merge lookup for a community `fixedSpeedCamera` report (`findDuplicateFixedSpeedCamera`, 500 m default) does not know types yet — after the
  change a speed-camera report next to a red-light device (the same junction!) would merge into the red-light row. The lookup gets `camera_type = 'fixedSpeedCamera'`; a test covers it.
* `POST /v1/speed-cameras/:id/removal-reports` works on the id, so it serves every type unchanged.
* **Not built, not proposed for now** (section 9, question 8): a "permanent" flag on user reports.

## 5. Federation — premise check

The prompt asks that persistent devices follow "the same rules as fixed cameras: signed, deterministically merged, not deliverable on nodes with the flag off".
**Fixed cameras are not federated.** *Checked in code and docs:* `modules/federation/ingest.ts:67–75` rejects `fixedSpeedCamera` with `camera_out_of_scope`;
`federation-protocol.md` §7 lists "Fixed-camera federation" as a tracked gap (no merge semantics for a lifecycle with removal votes); the static base data (segments, signs,
cameras) reaches a node by its own import or a `pg_dump` seed, never by replication; and there is no device signature on bulk-imported rows to verify.

So, for persistent devices:

* **What is true today and stays true:** device-signed *events* for `redLightCamera` / `distanceControl` federate as **expiring reports** (they are `hazard_reports` rows);
  the flag-off rule holds (a node with the flag off does not deliver any camera type; the flag is also overridable by the signed network config).
* **What cannot be true without new work:** replication of a persistent device between nodes. That needs the merge semantics §7 says are missing (identity of a device across
  nodes, merge of removal votes, provenance without device signatures). It is a project of its own, and it would apply to the 45 k existing fixed cameras first.

Proposal (question 2): document exactly this in `federation-protocol.md` §7 (persistent devices are node-local static data, seeded by import or dump, like fixed cameras), and reduce
milestone D3's multi-node test to the properties that *are* testable: a peer with an older schema is unaffected by (a) `redLightCamera` device events, which arrive as expiring reports,
and (b) a persistent device on the sending node, which stays on that node; a node with the flag off delivers no device type. "Older node with an unknown `cameraType`" cannot
occur, because `cameraType` never crosses the federation boundary.

## 6. Static packages and snapshot

* Package tile JSON gets a fifth key, appended after `fixedSpeedCameras`: `"enforcementDevices":[…]`, **written only when the tile has at least one persistent device**. A tile
  without any keeps its bytes and therefore its hash — no forced re-download there. `fixedSpeedCameras` keeps its meaning (only fixed cameras).
* Consequence to state plainly: tiles that contain any camera change content once (`cameraType` on each item, plus the new array), so the first manifest after the deploy lists
  them as changed. There are no real users and the Europe packages have not been built yet, so the cost today is zero; it would not be later — which is why the shape is fixed now.
* Both builders change: the streaming builder (`package-builder.ts`) and the legacy in-memory partitioner (`partitions.ts`, still behind `GET /v1/static-data/partitions/:tile`).
* The builder fingerprint (`v1|res|cameras|overlay`) gets a `v2`, so a node upgraded from E-B rebuilds its packages once, on its own.
* Dirty-tile marking: every writer of `fixed_speed_cameras` already marks the tile (E-B); the bulk import path does too. Nothing new to mark, but a test proves it per device type.
* `static_packages.camera_count` (informational) counts persistent devices of all types.
* Snapshot: as in 4.2; the E-B guard (`SNAPSHOT_STATIC_MAX_ROWS`) is unaffected.

## 7. Tests (mapping to section 4 of the prompt)

| Prompt requirement | Test |
|---|---|
| Migration with legacy data, counts, all old rows `fixedSpeedCamera`, old responses unchanged, rollback | `persistent-devices-migration.test.ts`, described in section 3 |
| Import and delivery per type, filter by `cameraType`, removal reports for a red-light device | integration test: import one device of each type, `nearby`/`by-tile`/snapshot/`types=`, three removal reports remove the red-light device and emit an `enforcementDevice` event |
| No expiry: an imported red-light device survives the expiry windows | integration test with the clock moved past every band (the expiry worker runs; the device is still there and served) — the existing expiry tests show how the clock is controlled |
| Flag off: nothing delivered, writes still work | same fixture with the flag off: `nearby`, `by-tile`, snapshot, package, delta empty of every type; `POST` and bulk import succeed |
| Multi-node | reduced as in section 5 (older peer, node-local devices); extended if question 2 is answered differently |
| Also | duplicate-merge does not cross types; package bytes for a tile *without* devices are unchanged (hash equality against the pre-change builder output); entity-type/`PERSISTENT_CAMERA_TYPES` constants match the database labels; rollback refuses with non-fixed rows |

## 8. Section control (`enforcement=average_speed`) — proposal, not built

* **Data model.** A section control is two or more devices plus a monitored stretch (OSM: `device` members, `from`/`to`). The first useful step is **each device as a point**
  with a new `camera_type` label `averageSpeedCheck` (start and end both flagged): a driver gets the warning at each end. Grouping the ends and drawing the stretch would need
  an optional `section_id` and a role (`start`/`end`) — additive columns, later, when a client wants the stretch.
* **The blocker is not the server.** The label is one `ALTER TYPE … ADD VALUE` (metadata-only). But the Rust client decodes `type` into a **closed** enum: the first item with an unknown
  value breaks the whole decode (4.1). So `averageSpeedCheck` must not appear in `HAZARD_TYPES`, in any `type` an old client decodes, or in the payload of a `fixedSpeedCamera`-entity
  event until client-lib tolerates unknown values (`#[serde(other)]`, an `Unknown` variant, unknown-tolerant packages). Sequence: **(1) client-lib decodes unknown types leniently — C's change;
  (2) server appends the label and adds it to the filters; (3) ingestion imports.** Until then, section control is not imported (the source-catalogue prompt already says: don't import what
  cannot be represented).
* **Legal gate.** Section control is speed enforcement: same flag, same default (off).

## 9. Not proposed (so that nobody assumes it)

* A "this is permanent" flag on user reports with a confirmation threshold (a user reporting a mobile control must never create a permanent device; a design needs abuse handling).
* Suppressing an expiring red-light report that lies next to a persistent red-light device (clients can de-duplicate by position; the server has no rule for it).
* Renaming the table to `enforcement_devices`.
* Federation of persistent devices (section 5).

## 10. Open questions for the operator — and the default each one was built with

1. **Branch base.** Stacked on `feature/europe-scale` (recommended: it holds the package builder this touches and migration numbers 0007/0008, so this becomes 0009), which fixes the merge
   order perf-fix → K-A → E-B → this. Based on `main` instead, the migration would collide with K-A's 0007 and the package work (D3) could not be done. — *Default taken: stacked.*
2. **Federation.** Accept that persistent devices are node-local static data like fixed cameras (section 5, recommended), or make federation of the camera table a separate project
   first? The prompt assumed fixed cameras already federate; they do not.
3. **`nearby` default.** All persistent devices without `types` (as specified; the web UI needs its three-line fix, which I would hand to the web chat), or opt-in with `?persistent=true`
   so that *no* existing consumer sees a new item until it asks (strictest, at the price of an extra parameter every new client must know about)?
4. **`enforcementDevices` content.** All persistent devices including the fixed cameras (as specified; simple "one list" contract for new clients; ≈ 45 k duplicated items ≈ 3–4 MB gzip
   over the whole Europe package set), or only the additional types (leaner, but then "all devices" = the union of two arrays)?
5. **`by-tile`.** Include persistent devices of the new types (proposed; fixed cameras stay excluded as today), also the fixed cameras (changes today's answer), or none (persistent devices
   only via `nearby`, snapshot and packages)?
6. **`tn-europe`.** The Europe node needs 0007 + 0008 for E-B anyway (0007 ≈ 5 min under lock, decided: measure on a copy first, then run it). 0009 adds milliseconds, so there is no reason to wait for this
   branch; whichever code is deployed then, the node can take 0009 later without a window. Confirm?
7. **Ingestion.** The `type=enforcement` import (source-catalogue, section 3.1) may start writing `redLightCamera` / `distanceControl` with `cameraType` only once D2 runs on the target
   server — an older server would file them as speed cameras (unknown field ignored). I will state this in `docs/status.md`. Until then: do not import them.
8. **Deferred on purpose:** section control (needs client-lib to decode unknown types first — a request to the client chat) and a "permanent" flag on user reports. OK to leave both out of this task?

**Built with:** 1 stacked; 2 node-local (documented in `federation-protocol.md` §7, multi-node test reduced accordingly); 3 all
persistent devices without `types` (the web UI needs its small fix — see the status file); 4 `enforcementDevices` = every persistent
device; 5 by-tile includes the new kinds, not the speed cameras; 6 no dependency on this branch for `tn-europe`; 7 stated in the
status file; 8 deferred. Changing 3, 4 or 5 is a change of one filter or one query each.

## 11. Milestones (from the prompt) and what each contains

| # | Contents |
|---|---|
| D1 | Migration 0009 + rollback script + Drizzle schema + `PERSISTENT_CAMERA_TYPES`; `persistent-devices-migration` test green; `operating.md` backup/rollback section |
| D2 | `cameraType` in items, `nearby`/`by-tile` filters, snapshot `enforcementDevices`, `/v1/config.persistentCameraTypes`, bulk-import `cameraType`, duplicate-merge fix, `enforcementDevice` entity type + delta filter; `api.md`, `schema.md` |
| D3 | Package builders (both) + fingerprint `v2` + dirty-tile tests; federation §7 wording and the reduced multi-node test |
| D4 | Full docs, full suite, CI; **pull request only with the operator's approval** |

Merge order (each PR needs approval): perf-fix → K-A → E-B → this. The branch is stacked because it builds on the E-B package builder and takes the next migration number (0009).
