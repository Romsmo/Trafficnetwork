import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import type { CorrectionReason, CorrectionStatus, CorrectionVoteKind, SpeedLimitUnit } from "../../config/constants.js";
import { pgArray } from "../pg-array.js";
import type { VoteInput } from "../../modules/speed-limit-corrections/tally.js";

/**
 * Persistence for community speed-limit corrections (add-on K-A). The rules
 * (who wins, what an import change means) live in
 * modules/speed-limit-corrections/*; this file is only SQL.
 */

// ---------------------------------------------------------------- votes

export interface NewVote {
  id: string;
  segmentKey: string;
  reporterId: string;
  submittedBy: string | null;
  kind: CorrectionVoteKind;
  value: number;
  unit: SpeedLimitUnit;
  reason: CorrectionReason | null;
  voteTimestamp: Date;
  envelope: unknown;
  originNodeId: string | null;
}

/** Serialises every write that touches one segment's votes/corrections — two concurrent votes on the same segment must not both read the same tally. */
export async function lockSegmentKey(tx: Queryable, segmentKey: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"speedLimitCorrections:" + segmentKey}, 0))`);
}

/** Inserts a vote; returns its local `seq`, or null if a vote with this id already exists (idempotent — no unique-violation race to catch). */
export async function insertVote(tx: Queryable, vote: NewVote): Promise<number | null> {
  const rows = await tx.execute<{ seq: number } & Record<string, unknown>>(sql`
    insert into speed_limit_correction_votes
      (id, segment_key, reporter_id, submitted_by, kind, value, unit, reason, vote_timestamp, envelope, origin_node_id)
    values (
      ${vote.id}, ${vote.segmentKey}, ${vote.reporterId}, ${vote.submittedBy}, ${vote.kind}::correction_vote_kind,
      ${vote.value}, ${vote.unit}::speed_limit_unit, ${vote.reason}::correction_reason,
      ${vote.voteTimestamp.toISOString()}, ${vote.envelope === null ? null : JSON.stringify(vote.envelope)}::jsonb, ${vote.originNodeId}
    )
    on conflict (id) do nothing
    returning seq
  `);
  return rows[0]?.seq ?? null;
}

interface VoteInputRow extends Record<string, unknown> {
  id: string;
  reporter_id: string;
  kind: CorrectionVoteKind;
  value: number;
  unit: SpeedLimitUnit;
  reason: CorrectionReason | null;
  ts_ms: number;
}

function toVoteInput(row: VoteInputRow): VoteInput {
  return { id: row.id, reporterId: row.reporter_id, kind: row.kind, value: row.value, unit: row.unit, reason: row.reason, timestamp: Number(row.ts_ms) };
}

/** The votes that count: everything on the segment except those by banned reporters. */
export async function listStandingVotes(db: Queryable, segmentKey: string): Promise<VoteInput[]> {
  const rows = await db.execute<VoteInputRow>(sql`
    select v.id, v.reporter_id, v.kind, v.value, v.unit, v.reason,
           (extract(epoch from v.vote_timestamp) * 1000)::float8 as ts_ms
    from speed_limit_correction_votes v
    where v.segment_key = ${segmentKey}
      and not exists (select 1 from speed_limit_correction_bans b where b.reporter_id = v.reporter_id)
  `);
  return rows.map(toVoteInput);
}

export interface VoteLogEntry {
  seq: number;
  id: string;
  reporterId: string;
  submittedBy: string | null;
  kind: CorrectionVoteKind;
  value: number;
  unit: SpeedLimitUnit;
  reason: CorrectionReason | null;
  voteTimestamp: string;
  receivedAt: string;
  signed: boolean;
  originNodeId: string | null;
  banned: boolean;
}

/** Everything on a segment including banned reporters' votes (flagged) — for the operator tool. */
export async function listVoteLog(db: Queryable, segmentKey: string): Promise<VoteLogEntry[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    select v.seq, v.id, v.reporter_id, v.submitted_by, v.kind, v.value, v.unit, v.reason,
           v.vote_timestamp, v.received_at,
           (v.envelope is not null) as signed, v.origin_node_id,
           exists (select 1 from speed_limit_correction_bans b where b.reporter_id = v.reporter_id) as banned
    from speed_limit_correction_votes v
    where v.segment_key = ${segmentKey}
    order by v.vote_timestamp, v.id
  `);
  return rows.map((r) => ({
    seq: r.seq as number,
    id: r.id as string,
    reporterId: r.reporter_id as string,
    submittedBy: (r.submitted_by as string | null) ?? null,
    kind: r.kind as CorrectionVoteKind,
    value: r.value as number,
    unit: r.unit as SpeedLimitUnit,
    reason: (r.reason as CorrectionReason | null) ?? null,
    voteTimestamp: r.vote_timestamp as string,
    receivedAt: r.received_at as string,
    signed: r.signed as boolean,
    originNodeId: (r.origin_node_id as string | null) ?? null,
    banned: r.banned as boolean,
  }));
}

/** Votes submitted through this server's own API by one client in the trailing window — the per-client rate-limit counter. */
export async function countRecentVotesBySubmitter(db: Queryable, submittedBy: string, windowMinutes: number): Promise<number> {
  const rows = await db.execute<{ total: number } & Record<string, unknown>>(sql`
    select count(*)::int as total from speed_limit_correction_votes
    where submitted_by = ${submittedBy} and received_at > now() - make_interval(mins => ${windowMinutes})
  `);
  return rows[0]?.total ?? 0;
}

export interface VotePage {
  votes: { sequence: number; voteId: string; envelope: unknown; receivedAt: string }[];
  nextAfter: number | null;
}

/** The federation pull stream (GET /v1/federation/speed-limit-votes): signed votes only, in local insertion order. */
export async function getSignedVotesSince(db: Queryable, after: number, limit: number): Promise<VotePage> {
  const rows = await db.execute<{ seq: number; id: string; envelope: unknown; received_at: string } & Record<string, unknown>>(sql`
    select seq, id, envelope, received_at
    from speed_limit_correction_votes
    where seq > ${after} and envelope is not null
    order by seq asc
    limit ${limit}
  `);
  const votes = rows.map((r) => ({ sequence: r.seq, voteId: r.id, envelope: r.envelope, receivedAt: r.received_at }));
  return { votes, nextAfter: votes.at(-1)?.sequence ?? null };
}

// ---------------------------------------------------------------- bans

export async function findBan(db: Queryable, reporterId: string): Promise<{ reason: string | null } | null> {
  const rows = await db.execute<{ reason: string | null } & Record<string, unknown>>(sql`
    select reason from speed_limit_correction_bans where reporter_id = ${reporterId}
  `);
  return rows[0] ? { reason: rows[0].reason } : null;
}

export async function insertBan(db: Queryable, reporterId: string, reason: string | null): Promise<boolean> {
  const rows = await db.execute<{ reporter_id: string } & Record<string, unknown>>(sql`
    insert into speed_limit_correction_bans (reporter_id, reason) values (${reporterId}, ${reason})
    on conflict (reporter_id) do nothing returning reporter_id
  `);
  return rows.length > 0;
}

export async function deleteBan(db: Queryable, reporterId: string): Promise<boolean> {
  const rows = await db.execute<{ reporter_id: string } & Record<string, unknown>>(sql`
    delete from speed_limit_correction_bans where reporter_id = ${reporterId} returning reporter_id
  `);
  return rows.length > 0;
}

export async function listBans(db: Queryable): Promise<{ reporterId: string; reason: string | null; bannedAt: string }[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    select reporter_id, reason, banned_at from speed_limit_correction_bans order by banned_at
  `);
  return rows.map((r) => ({ reporterId: r.reporter_id as string, reason: (r.reason as string | null) ?? null, bannedAt: r.banned_at as string }));
}

/** Distinct segment keys a reporter has voted on — what to recompute after a ban/unban. */
export async function listSegmentKeysVotedBy(db: Queryable, reporterId: string): Promise<string[]> {
  const rows = await db.execute<{ segment_key: string } & Record<string, unknown>>(sql`
    select distinct segment_key from speed_limit_correction_votes where reporter_id = ${reporterId}
  `);
  return rows.map((r) => r.segment_key);
}

// ---------------------------------------------------------------- corrections (materialised)

export interface CorrectionRow {
  id: string;
  segmentKey: string;
  unit: SpeedLimitUnit;
  value: number;
  reason: CorrectionReason | null;
  status: CorrectionStatus;
  supportCount: number;
  denyCount: number;
  appliedAt: string | null;
  baseValue: number | null;
  blockedAt: string | null;
  blockedReason: string | null;
}

interface CorrectionRowRaw extends Record<string, unknown> {
  id: string;
  segment_key: string;
  unit: SpeedLimitUnit;
  value: number;
  reason: CorrectionReason | null;
  status: CorrectionStatus;
  support_count: number;
  deny_count: number;
  applied_at: string | null;
  base_value: number | null;
  blocked_at: string | null;
  blocked_reason: string | null;
}

function toCorrectionRow(r: CorrectionRowRaw): CorrectionRow {
  return {
    id: r.id,
    segmentKey: r.segment_key,
    unit: r.unit,
    value: r.value,
    reason: r.reason,
    status: r.status,
    supportCount: r.support_count,
    denyCount: r.deny_count,
    appliedAt: r.applied_at,
    baseValue: r.base_value,
    blockedAt: r.blocked_at,
    blockedReason: r.blocked_reason,
  };
}

const CORRECTION_ROW_COLUMNS = sql`
  id, segment_key, unit, value, reason, status, support_count, deny_count,
  applied_at, base_value, blocked_at, blocked_reason
`;

/** Locks and returns every materialised row of one segment (call after lockSegmentKey). */
export async function listCorrectionRowsForKey(tx: Queryable, segmentKey: string): Promise<CorrectionRow[]> {
  const rows = await tx.execute<CorrectionRowRaw>(sql`
    select ${CORRECTION_ROW_COLUMNS} from speed_limit_corrections where segment_key = ${segmentKey} for update
  `);
  return rows.map(toCorrectionRow);
}

export async function findCorrectionRowById(db: Queryable, id: string): Promise<CorrectionRow | null> {
  const rows = await db.execute<CorrectionRowRaw>(sql`select ${CORRECTION_ROW_COLUMNS} from speed_limit_corrections where id = ${id}`);
  return rows[0] ? toCorrectionRow(rows[0]) : null;
}

export interface CorrectionUpsert {
  id: string;
  segmentKey: string;
  unit: SpeedLimitUnit;
  value: number;
  reason: CorrectionReason | null;
  status: CorrectionStatus;
  supportCount: number;
  denyCount: number;
  firstProposedAt: Date;
  lastVoteAt: Date;
  /** Only ever set here on the transition into `applied`; an existing value is kept otherwise. */
  appliedNow: boolean;
  /** Set on the transition out of `applied`. */
  revertedNow: boolean;
  baseValue: number | null;
}

export async function upsertCorrection(tx: Queryable, c: CorrectionUpsert): Promise<void> {
  await tx.execute(sql`
    insert into speed_limit_corrections
      (id, segment_key, unit, value, reason, status, support_count, deny_count, first_proposed_at, last_vote_at,
       applied_at, reverted_at, base_value)
    values (
      ${c.id}, ${c.segmentKey}, ${c.unit}::speed_limit_unit, ${c.value}, ${c.reason}::correction_reason,
      ${c.status}::correction_status, ${c.supportCount}, ${c.denyCount},
      ${c.firstProposedAt.toISOString()}, ${c.lastVoteAt.toISOString()},
      ${c.appliedNow ? sql`now()` : null}, ${c.revertedNow ? sql`now()` : null}, ${c.baseValue}
    )
    on conflict (segment_key, unit, value) do update set
      reason = excluded.reason,
      status = excluded.status,
      support_count = excluded.support_count,
      deny_count = excluded.deny_count,
      first_proposed_at = excluded.first_proposed_at,
      last_vote_at = excluded.last_vote_at,
      applied_at = case when ${c.appliedNow}::boolean then now() else speed_limit_corrections.applied_at end,
      reverted_at = case when ${c.revertedNow}::boolean then now() else speed_limit_corrections.reverted_at end,
      base_value = coalesce(speed_limit_corrections.base_value, excluded.base_value),
      updated_at = now()
  `);
}

export async function deleteCorrectionRow(tx: Queryable, id: string): Promise<void> {
  await tx.execute(sql`delete from speed_limit_corrections where id = ${id}`);
}

/** A blocked candidate none of whose votes count any more: keep the row (and its block), zero what it shows. */
export async function zeroCorrectionCounters(tx: Queryable, id: string): Promise<void> {
  await tx.execute(sql`
    update speed_limit_corrections
    set support_count = 0, deny_count = 0, status = 'reverted', updated_at = now()
    where id = ${id}
  `);
}

/** Operator reset (reason set) / restore (reason null → unblocks). Returns false if no such correction. */
export async function setCorrectionBlocked(tx: Queryable, id: string, blocked: { reason: string | null } | null): Promise<boolean> {
  const rows = await tx.execute<{ id: string } & Record<string, unknown>>(
    blocked
      ? sql`update speed_limit_corrections set blocked_at = now(), blocked_reason = ${blocked.reason}, updated_at = now() where id = ${id} returning id`
      : sql`update speed_limit_corrections set blocked_at = null, blocked_reason = null, updated_at = now() where id = ${id} returning id`,
  );
  return rows.length > 0;
}

/** The imported value of the earliest local segment row for this key and unit — the reference for "the import changed since". */
export async function lookupBaseValue(tx: Queryable, segmentKey: string, unit: SpeedLimitUnit): Promise<number | null> {
  const rows = await tx.execute<{ speed_limit: number } & Record<string, unknown>>(sql`
    select speed_limit from speed_limit_segments
    where geometry_key = ${segmentKey} and speed_limit_unit = ${unit}::speed_limit_unit
    order by imported_at, id limit 1
  `);
  return rows[0]?.speed_limit ?? null;
}

/**
 * A vote can arrive before its segment is imported. When the segment shows up,
 * remember the value it was imported with as the reference for needsReview —
 * called from the bulk-import transaction, so it costs nothing when no
 * correction is waiting for a segment.
 */
export async function fillMissingBaseValues(tx: Queryable): Promise<void> {
  await tx.execute(sql`
    update speed_limit_corrections c set base_value = s.speed_limit
    from (
      select distinct on (geometry_key, speed_limit_unit) geometry_key, speed_limit_unit, speed_limit
      from speed_limit_segments
      where geometry_key in (select segment_key from speed_limit_corrections where base_value is null)
      order by geometry_key, speed_limit_unit, imported_at, id
    ) s
    where c.base_value is null and c.segment_key = s.geometry_key and c.unit = s.speed_limit_unit
  `);
}

/** Keys that currently have an applied correction — what a feature-switch flip has to re-announce. */
export async function listAppliedKeys(db: Queryable): Promise<{ segmentKey: string; unit: SpeedLimitUnit }[]> {
  const rows = await db.execute<{ segment_key: string; unit: SpeedLimitUnit } & Record<string, unknown>>(sql`
    select segment_key, unit from speed_limit_corrections where status = 'applied'
  `);
  return rows.map((r) => ({ segmentKey: r.segment_key, unit: r.unit }));
}

// ---------------------------------------------------------------- public / operator listing

export interface CorrectionApi {
  id: string;
  segmentKey: string;
  /** The first local segment row this correction applies to; null if this server doesn't have that segment (yet). */
  segmentId: string | null;
  value: number;
  unit: SpeedLimitUnit;
  status: CorrectionStatus;
  reason: CorrectionReason | null;
  /** Distinct devices currently supporting this value / objecting to it. */
  confirmations: number;
  denials: number;
  firstProposedAt: string;
  lastVoteAt: string;
  appliedAt: string | null;
  /** The imported value on the local segment — what the correction overrides (or would override). */
  importedSpeedLimit: number | null;
  /** Applied, and the imported value has since changed to something other than the correction or what it was proposed against. */
  needsReview: boolean;
  source: "community";
  geometry?: unknown;
}

interface CorrectionApiRaw extends Record<string, unknown> {
  id: string;
  segment_key: string;
  segment_id: string | null;
  value: number;
  unit: SpeedLimitUnit;
  status: CorrectionStatus;
  reason: CorrectionReason | null;
  support_count: number;
  deny_count: number;
  first_proposed_at: string;
  last_vote_at: string;
  applied_at: string | null;
  imported_speed_limit: number | null;
  needs_review: boolean;
  geometry_geojson: unknown;
}

function toCorrectionApi(r: CorrectionApiRaw, withGeometry: boolean): CorrectionApi {
  const api: CorrectionApi = {
    id: r.id,
    segmentKey: r.segment_key,
    segmentId: r.segment_id,
    value: r.value,
    unit: r.unit,
    status: r.status,
    reason: r.reason,
    confirmations: r.support_count,
    denials: r.deny_count,
    firstProposedAt: r.first_proposed_at,
    lastVoteAt: r.last_vote_at,
    appliedAt: r.applied_at,
    importedSpeedLimit: r.imported_speed_limit,
    needsReview: r.needs_review,
    source: "community",
  };
  if (withGeometry) api.geometry = r.geometry_geojson;
  return api;
}

export interface CorrectionListFilter {
  statuses: CorrectionStatus[];
  segmentKey?: string;
  /** A GeoJSON (Multi)Polygon: only corrections whose local segment intersects it are returned. */
  area?: unknown;
  needsReviewOnly?: boolean;
  /** Include records nobody currently supports (only their objections/history remain) — the operator's view; clients never see these. */
  includeUnsupported?: boolean;
  limit: number;
}

export async function listCorrections(db: Queryable, filter: CorrectionListFilter): Promise<CorrectionApi[]> {
  const conditions = [sql`c.status = any(${pgArray(filter.statuses)}::correction_status[])`];
  if (!filter.includeUnsupported) conditions.push(sql`c.support_count > 0`);
  if (filter.segmentKey) conditions.push(sql`c.segment_key = ${filter.segmentKey}`);
  if (filter.area) {
    conditions.push(sql`seg.id is not null and ST_Intersects(seg.geometry, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(filter.area)}), 4326))`);
  }
  if (filter.needsReviewOnly) conditions.push(sql`needs.review`);
  const where = sql.join(conditions, sql` and `);

  const rows = await db.execute<CorrectionApiRaw>(sql`
    select c.id, c.segment_key, seg.id as segment_id, c.value, c.unit, c.status, c.reason, c.support_count, c.deny_count,
           c.first_proposed_at, c.last_vote_at, c.applied_at,
           seg.speed_limit as imported_speed_limit, needs.review as needs_review,
           ST_AsGeoJSON(seg.geometry)::json as geometry_geojson
    from speed_limit_corrections c
    left join lateral (
      select s.id, s.geometry, s.speed_limit from speed_limit_segments s
      where s.geometry_key = c.segment_key and s.speed_limit_unit = c.unit
      order by s.imported_at, s.id limit 1
    ) seg on true
    cross join lateral (
      select (c.status = 'applied' and c.base_value is not null and exists (
        select 1 from speed_limit_segments s2
        where s2.geometry_key = c.segment_key and s2.speed_limit_unit = c.unit
          and s2.speed_limit <> c.base_value and s2.speed_limit <> c.value
      )) as review
    ) needs
    where ${where}
    order by c.last_vote_at desc, c.id
    limit ${filter.limit}
  `);
  return rows.map((r) => toCorrectionApi(r, filter.area !== undefined));
}

export async function findCorrectionApiById(db: Queryable, id: string): Promise<CorrectionApi | null> {
  const rows = await db.execute<CorrectionApiRaw>(sql`
    select c.id, c.segment_key, seg.id as segment_id, c.value, c.unit, c.status, c.reason, c.support_count, c.deny_count,
           c.first_proposed_at, c.last_vote_at, c.applied_at,
           seg.speed_limit as imported_speed_limit,
           (c.status = 'applied' and c.base_value is not null and exists (
             select 1 from speed_limit_segments s2
             where s2.geometry_key = c.segment_key and s2.speed_limit_unit = c.unit
               and s2.speed_limit <> c.base_value and s2.speed_limit <> c.value
           )) as needs_review,
           null::json as geometry_geojson
    from speed_limit_corrections c
    left join lateral (
      select s.id, s.speed_limit from speed_limit_segments s
      where s.geometry_key = c.segment_key and s.speed_limit_unit = c.unit
      order by s.imported_at, s.id limit 1
    ) seg on true
    where c.id = ${id}
  `);
  return rows[0] ? toCorrectionApi(rows[0], false) : null;
}

/** Corrections whose segment does not exist on this server (never imported here, or its geometry changed since). */
export async function listOrphanCorrections(db: Queryable, limit: number): Promise<CorrectionApi[]> {
  const rows = await db.execute<CorrectionApiRaw>(sql`
    select c.id, c.segment_key, null::uuid as segment_id, c.value, c.unit, c.status, c.reason, c.support_count, c.deny_count,
           c.first_proposed_at, c.last_vote_at, c.applied_at,
           null::int as imported_speed_limit, false as needs_review, null::json as geometry_geojson
    from speed_limit_corrections c
    where not exists (select 1 from speed_limit_segments s where s.geometry_key = c.segment_key)
    order by c.last_vote_at desc, c.id
    limit ${limit}
  `);
  return rows.map((r) => toCorrectionApi(r, false));
}
