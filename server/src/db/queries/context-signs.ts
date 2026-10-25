import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import type { ContextSignDescriptor } from "../../modules/context-signs/descriptor.js";
import type { VoteInput } from "../../modules/context-signs/tally.js";
import { overlapShare, SIMILAR_TOLERANCE_M } from "../../modules/context-signs/descriptor.js";

/** Queries behind the context signs (docs/context-signs.md). Raw SQL, like every geometry-carrying module of this server. */

export interface EntryRow {
  entryKey: string;
  descriptor: ContextSignDescriptor;
  signType: string;
  signClass: "prohibition" | "hazard";
  lengthM: number;
  tiles: string[];
  tileResolution: number;
  status: "proposed" | "confirmed" | "disputed" | "expired" | "removed";
  supportCount: number;
  denyCount: number;
  firstProposedAt: string;
  lastVoteAt: string;
  confirmedAt: string | null;
  lastConfirmedAt: string | null;
  expiresAt: string | null;
  blockedAt: string | null;
  blockedReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row extends Record<string, unknown> {
  entry_key: string;
  descriptor: ContextSignDescriptor;
  sign_type: string;
  sign_class: "prohibition" | "hazard";
  length_m: number;
  tiles: string[];
  tile_resolution: number;
  status: EntryRow["status"];
  support_count: number;
  deny_count: number;
  first_proposed_at: string;
  last_vote_at: string;
  confirmed_at: string | null;
  last_confirmed_at: string | null;
  expires_at: string | null;
  blocked_at: string | null;
  blocked_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = sql`entry_key, descriptor, sign_type, sign_class, length_m, tiles, tile_resolution, status, support_count, deny_count,
  first_proposed_at, last_vote_at, confirmed_at, last_confirmed_at, expires_at, blocked_at, blocked_reason, created_by, created_at, updated_at`;

const toEntry = (r: Row): EntryRow => ({
  entryKey: r.entry_key,
  descriptor: r.descriptor,
  signType: r.sign_type,
  signClass: r.sign_class,
  lengthM: r.length_m,
  tiles: r.tiles,
  tileResolution: r.tile_resolution,
  status: r.status,
  supportCount: r.support_count,
  denyCount: r.deny_count,
  firstProposedAt: r.first_proposed_at,
  lastVoteAt: r.last_vote_at,
  confirmedAt: r.confirmed_at,
  lastConfirmedAt: r.last_confirmed_at,
  expiresAt: r.expires_at,
  blockedAt: r.blocked_at,
  blockedReason: r.blocked_reason,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Only entries the node delivers: not removed, not disputed, not past their end. */
const DELIVERED = sql`status in ('proposed', 'confirmed') and (expires_at is null or expires_at > now())`;

// ---------------------------------------------------------------- locks, version

export async function lockEntryKey(tx: Queryable, entryKey: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"contextSign:" + entryKey}, 0))`);
}

export async function getVersion(db: Queryable): Promise<number> {
  const rows = await db.execute<{ version: number } & Record<string, unknown>>(sql`select version from context_sign_state where id = 1`);
  return rows[0]?.version ?? 1;
}

/** The delivered set changed: clients compare this number to know they have to fetch again. */
export async function bumpVersion(tx: Queryable): Promise<number> {
  const rows = await tx.execute<{ version: number } & Record<string, unknown>>(sql`
    insert into context_sign_state (id, version) values (1, 2)
    on conflict (id) do update set version = context_sign_state.version + 1, updated_at = now()
    returning version
  `);
  return rows[0]!.version;
}

// ---------------------------------------------------------------- votes

export interface NewVote {
  id: string;
  entryKey: string;
  reporterId: string;
  submittedBy: string | null;
  kind: "support" | "deny";
  voteTimestamp: Date;
  envelope: unknown;
  originNodeId: string | null;
}

/** False when a vote with this id is already there (the same signed vote seen twice). */
export async function insertVote(tx: Queryable, v: NewVote): Promise<boolean> {
  const rows = await tx.execute<{ seq: number } & Record<string, unknown>>(sql`
    insert into context_sign_votes (id, entry_key, reporter_id, submitted_by, kind, vote_timestamp, envelope, origin_node_id)
    values (${v.id}, ${v.entryKey}, ${v.reporterId}, ${v.submittedBy}, ${v.kind}, ${v.voteTimestamp.toISOString()},
            ${v.envelope === null ? null : JSON.stringify(v.envelope)}::jsonb, ${v.originNodeId})
    on conflict (id) do nothing
    returning seq
  `);
  return rows.length > 0;
}

/** The votes of an entry that count: those of banned reporters are left out. */
export async function listStandingVotes(tx: Queryable, entryKey: string): Promise<VoteInput[]> {
  const rows = await tx.execute<{ id: string; reporter_id: string; kind: "support" | "deny"; ts: string } & Record<string, unknown>>(sql`
    select v.id, v.reporter_id, v.kind, v.vote_timestamp as ts
    from context_sign_votes v
    where v.entry_key = ${entryKey}
      and not exists (select 1 from context_sign_bans b where b.reporter_id = v.reporter_id)
  `);
  return rows.map((r) => ({ id: r.id, reporterId: r.reporter_id, kind: r.kind, timestamp: Date.parse(r.ts) }));
}

export async function countVotesBySubmitterSince(db: Queryable, submittedBy: string, since: Date): Promise<number> {
  const rows = await db.execute<{ total: number } & Record<string, unknown>>(sql`
    select count(*)::int as total from context_sign_votes where submitted_by = ${submittedBy} and received_at > ${since.toISOString()}
  `);
  return rows[0]?.total ?? 0;
}

export async function countProposalsBySubmitterSince(db: Queryable, submittedBy: string, since: Date): Promise<number> {
  const rows = await db.execute<{ total: number } & Record<string, unknown>>(sql`
    select count(*)::int as total from context_sign_entries where created_by = ${submittedBy} and created_at > ${since.toISOString()}
  `);
  return rows[0]?.total ?? 0;
}

/** The votes with a signature, in the order this node stored them: the federation pull stream (docs D9). */
export async function getSignedVotesSince(db: Queryable, after: number, limit: number) {
  const rows = await db.execute<{ seq: number; id: string; envelope: unknown; received_at: string } & Record<string, unknown>>(sql`
    select seq, id, envelope, received_at from context_sign_votes where seq > ${after} and envelope is not null order by seq asc limit ${limit}
  `);
  const votes = rows.map((r) => ({ sequence: r.seq, voteId: r.id, envelope: r.envelope, receivedAt: r.received_at }));
  return { votes, nextAfter: votes.at(-1)?.sequence ?? null };
}

// ---------------------------------------------------------------- entries

export async function findEntry(db: Queryable, entryKey: string): Promise<EntryRow | null> {
  const rows = await db.execute<Row>(sql`select ${COLUMNS} from context_sign_entries where entry_key = ${entryKey}`);
  return rows[0] ? toEntry(rows[0]) : null;
}

export async function insertEntryIfMissing(
  tx: Queryable,
  e: {
    entryKey: string;
    descriptor: ContextSignDescriptor;
    signClass: string;
    lengthM: number;
    tiles: string[];
    tileResolution: number;
    firstProposedAt: Date;
    createdBy: string | null;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ entry_key: string } & Record<string, unknown>>(sql`
    insert into context_sign_entries (entry_key, descriptor, sign_type, sign_class, geometry, length_m, tiles, tile_resolution,
                                      first_proposed_at, last_vote_at, created_by)
    values (${e.entryKey}, ${JSON.stringify(e.descriptor)}::jsonb, ${e.descriptor.signType}, ${e.signClass},
            ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify({ type: "LineString", coordinates: e.descriptor.geometry })}), 4326),
            ${e.lengthM}, ${sql.raw(pgTextArray(e.tiles))}::text[], ${e.tileResolution},
            ${e.firstProposedAt.toISOString()}, ${e.firstProposedAt.toISOString()}, ${e.createdBy})
    on conflict (entry_key) do nothing
    returning entry_key
  `);
  return rows.length > 0;
}

/** A Postgres array literal for tile ids (hex digits only - checked, then inlined, as the pg-array helper does not cover text[]). */
function pgTextArray(values: readonly string[]): string {
  for (const v of values) if (!/^[0-9a-f]{1,16}$/.test(v)) throw new Error("not a tile id");
  return `'{${values.join(",")}}'`;
}

export interface DerivedColumns {
  status: EntryRow["status"];
  supportCount: number;
  denyCount: number;
  lastVoteAt: Date;
  confirmedAt: Date | null;
  lastConfirmedAt: Date | null;
  expiresAt: Date | null;
}

export async function writeDerived(tx: Queryable, entryKey: string, d: DerivedColumns): Promise<void> {
  await tx.execute(sql`
    update context_sign_entries set
      status = ${d.status}, support_count = ${d.supportCount}, deny_count = ${d.denyCount},
      last_vote_at = ${d.lastVoteAt.toISOString()},
      confirmed_at = ${d.confirmedAt?.toISOString() ?? null}, last_confirmed_at = ${d.lastConfirmedAt?.toISOString() ?? null},
      expires_at = ${d.expiresAt?.toISOString() ?? null}, updated_at = now()
    where entry_key = ${entryKey}
  `);
}

export async function setBlocked(tx: Queryable, entryKey: string, reason: string | null): Promise<boolean> {
  const rows = await tx.execute<{ entry_key: string } & Record<string, unknown>>(sql`
    update context_sign_entries set blocked_at = now(), blocked_reason = ${reason}, updated_at = now()
    where entry_key = ${entryKey} and blocked_at is null returning entry_key
  `);
  return rows.length > 0;
}

export async function clearBlocked(tx: Queryable, entryKey: string): Promise<boolean> {
  const rows = await tx.execute<{ entry_key: string } & Record<string, unknown>>(sql`
    update context_sign_entries set blocked_at = null, blocked_reason = null, updated_at = now()
    where entry_key = ${entryKey} and blocked_at is not null returning entry_key
  `);
  return rows.length > 0;
}

/** Entries delivered at all (unexpired proposed/confirmed) whose shape touches the tile. */
export async function listEntriesOfTile(db: Queryable, tile: string, includeUnconfirmed: boolean): Promise<EntryRow[]> {
  const rows = await db.execute<Row>(sql`
    select ${COLUMNS} from context_sign_entries
    where tiles @> array[${tile}]::text[] and ${DELIVERED} ${includeUnconfirmed ? sql`` : sql`and status = 'confirmed'`}
    order by entry_key
  `);
  return rows.map(toEntry);
}

export interface Box {
  west: number;
  south: number;
  east: number;
  north: number;
}

export async function listEntriesInBox(db: Queryable, box: Box, limit: number): Promise<EntryRow[]> {
  const rows = await db.execute<Row>(sql`
    select ${COLUMNS} from context_sign_entries
    where geometry && ST_MakeEnvelope(${box.west}, ${box.south}, ${box.east}, ${box.north}, 4326) and ${DELIVERED}
    order by entry_key limit ${limit}
  `);
  return rows.map(toEntry);
}

export async function listEntriesNear(db: Queryable, lat: number, lng: number, radiusM: number, limit: number): Promise<EntryRow[]> {
  const rows = await db.execute<Row>(sql`
    select ${COLUMNS} from context_sign_entries
    where geometry && ST_Expand(ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326), ${radiusM / 60000})
      and ST_DWithin(geometry::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusM})
      and ${DELIVERED}
    order by ST_Distance(geometry::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography), entry_key
    limit ${limit}
  `);
  return rows.map(toEntry);
}

/** Operator view: any status. */
export async function listEntriesByStatus(db: Queryable, statuses: readonly string[], limit: number): Promise<EntryRow[]> {
  const rows = await db.execute<Row>(sql`
    select ${COLUMNS} from context_sign_entries
    where status = any(${sql.raw(`'{${statuses.map((s) => s.replace(/[^a-z]/g, "")).join(",")}}'`)}::text[])
    order by last_vote_at desc limit ${limit}
  `);
  return rows.map(toEntry);
}

export interface SimilarEntry {
  entry: EntryRow;
  /** Share of the new stretch that lies within about 15 m of the entry, and the other way round. */
  overlapOfNew: number;
  overlapOfEntry: number;
}

/**
 * Delivered entries of the same sign that run along the same road: a proposal that is (nearly) one of them should be a vote for
 * it, not a second entry (docs D5). The database narrows down by bounding box; the overlap is measured here, on the shapes.
 */
export async function findSimilarEntries(db: Queryable, signType: string, geometry: readonly [number, number][]): Promise<SimilarEntry[]> {
  const geojson = JSON.stringify({ type: "LineString", coordinates: geometry });
  const rows = await db.execute<Row>(sql`
    with n as (select ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326) as g)
    select ${COLUMNS}
    from context_sign_entries e, n
    where e.sign_type = ${signType} and e.geometry && ST_Expand(n.g, 0.0004) and e.status in ('proposed', 'confirmed')
      and (e.expires_at is null or e.expires_at > now())
    limit 50
  `);
  return rows
    .map(toEntry)
    .map((entry) => ({
      entry,
      overlapOfNew: overlapShare(geometry, entry.descriptor.geometry, SIMILAR_TOLERANCE_M),
      overlapOfEntry: overlapShare(entry.descriptor.geometry, geometry, SIMILAR_TOLERANCE_M),
    }))
    .filter((s) => s.overlapOfNew >= 0.3 || s.overlapOfEntry >= 0.3);
}

/** Unconfirmed entries near a place (about 3.7 km): the cap against a flood of invented signs in one spot. */
export async function countUnconfirmedNear(db: Queryable, lng: number, lat: number, radiusM = 3700): Promise<number> {
  const rows = await db.execute<{ total: number } & Record<string, unknown>>(sql`
    select count(*)::int as total from context_sign_entries
    where status = 'proposed' and (expires_at is null or expires_at > now())
      and geometry && ST_Expand(ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326), ${radiusM / 60000})
      and ST_DWithin(geometry::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusM})
  `);
  return rows[0]?.total ?? 0;
}

/** Marks entries past their end as expired; returns how many - the delivered set changed if any. */
export async function expireDueEntries(tx: Queryable): Promise<number> {
  const rows = await tx.execute<{ entry_key: string } & Record<string, unknown>>(sql`
    update context_sign_entries set status = 'expired', updated_at = now()
    where status in ('proposed', 'confirmed', 'disputed') and expires_at is not null and expires_at <= now()
    returning entry_key
  `);
  return rows.length;
}

export async function entryCounts(db: Queryable): Promise<Record<string, number>> {
  const rows = await db.execute<{ status: string; total: number } & Record<string, unknown>>(sql`
    select status, count(*)::int as total from context_sign_entries group by status
  `);
  return Object.fromEntries(rows.map((r) => [r.status, r.total]));
}

/** Entries stored at another tile resolution than the node uses now (the operator changed STATIC_DATA_PARTITION_H3_RESOLUTION). */
export async function listEntriesWithOtherResolution(db: Queryable, resolution: number): Promise<{ entryKey: string; descriptor: ContextSignDescriptor }[]> {
  const rows = await db.execute<{ entry_key: string; descriptor: ContextSignDescriptor } & Record<string, unknown>>(sql`
    select entry_key, descriptor from context_sign_entries where tile_resolution <> ${resolution}
  `);
  return rows.map((r) => ({ entryKey: r.entry_key, descriptor: r.descriptor }));
}

export async function setTiles(tx: Queryable, entryKey: string, tiles: string[], resolution: number): Promise<void> {
  await tx.execute(sql`update context_sign_entries set tiles = ${sql.raw(pgTextArray(tiles))}::text[], tile_resolution = ${resolution} where entry_key = ${entryKey}`);
}

// ---------------------------------------------------------------- bans

export async function findBan(db: Queryable, reporterId: string): Promise<{ reason: string | null } | null> {
  const rows = await db.execute<{ reason: string | null } & Record<string, unknown>>(sql`select reason from context_sign_bans where reporter_id = ${reporterId}`);
  return rows[0] ? { reason: rows[0].reason } : null;
}

export async function insertBan(tx: Queryable, reporterId: string, reason: string | null): Promise<boolean> {
  const rows = await tx.execute<{ reporter_id: string } & Record<string, unknown>>(sql`
    insert into context_sign_bans (reporter_id, reason) values (${reporterId}, ${reason}) on conflict (reporter_id) do nothing returning reporter_id
  `);
  return rows.length > 0;
}

export async function deleteBan(tx: Queryable, reporterId: string): Promise<boolean> {
  const rows = await tx.execute<{ reporter_id: string } & Record<string, unknown>>(sql`delete from context_sign_bans where reporter_id = ${reporterId} returning reporter_id`);
  return rows.length > 0;
}

/** The entries a reporter voted on: what has to be recomputed when they are banned or unbanned. */
export async function entryKeysVotedBy(tx: Queryable, reporterId: string): Promise<string[]> {
  const rows = await tx.execute<{ entry_key: string } & Record<string, unknown>>(sql`select distinct entry_key from context_sign_votes where reporter_id = ${reporterId}`);
  return rows.map((r) => r.entry_key);
}

// ---------------------------------------------------------------- country (for the time zone)

/** The ISO country whose boundary is nearest to the point (within about 60 km), or null when no boundary data is loaded. */
export async function countryNear(db: Queryable, lng: number, lat: number): Promise<string | null> {
  const rows = await db.execute<{ iso2: string | null } & Record<string, unknown>>(sql`
    select iso2 from (
      select p.iso2, p.geom <-> ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326) as d
      from country_boundary_parts p order by d limit 1
    ) c where c.d < 0.55
  `);
  return rows[0]?.iso2 ?? null;
}

/** The votes of one entry, oldest first - what the operator looks at before removing an entry or blocking a device. */
export async function listVotesOfEntry(db: Queryable, entryKey: string) {
  const rows = await db.execute<{ id: string; reporter_id: string; kind: string; vote_timestamp: string; origin_node_id: string | null; signed: boolean } & Record<string, unknown>>(sql`
    select id, reporter_id, kind, vote_timestamp, origin_node_id, envelope is not null as signed
    from context_sign_votes where entry_key = ${entryKey} order by vote_timestamp, id
  `);
  return rows.map((r) => ({ id: r.id, reporterId: r.reporter_id, kind: r.kind, at: r.vote_timestamp, origin: r.origin_node_id, signed: r.signed }));
}
