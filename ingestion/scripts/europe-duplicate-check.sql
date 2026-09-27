-- Duplicate check (and optional clean-up) after an import that was interrupted (docs/europe-runbook.md, "After the run").
--
-- Why this exists: the server's bulk import has no dedup. The tool records a batch as done only after the server
-- confirmed it, so an interruption in the few milliseconds between "server committed" and "progress line written"
-- makes the resumed run post that batch a second time (at most one batch of BATCH_SIZE rows per such interruption;
-- measured in the Bayern rehearsal: exactly one batch of 2000 segments after one SIGKILL and two VM restarts).
--
-- Step 1 - is there an excess at all? Compare the table counts with the tool's confirmed totals (sum of the
-- insertedByKind in <state>/<region>/osm/sections/*.json). Equal = no duplicates from re-posted batches.
-- Step 2 - this file: count rows that are byte-identical repeats of an earlier row (same geometry, value and source).
--
-- IMPORTANT: for speed_limit_segments an exact repeat is a re-posted row (the Bayern rehearsal: 0 repeats after an
-- uninterrupted run). Signs are different: OSM itself contains identical signs at identical positions (the same
-- sign type on two nodes at one spot; 2,684 in Bayern), so a non-zero sign count is NORMAL and not evidence of a
-- duplicate batch - use the excess from step 1 for signs/cameras. That is why only the segment clean-up is offered.
--
-- Run:  docker exec -i tn-europe-postgres-1 psql -U trafficnetwork -d trafficnetwork < ingestion/scripts/europe-duplicate-check.sql

\echo === exact repeats of an earlier row ===
with ranked as (
  select id, row_number() over (partition by md5(ST_AsEWKB(geometry)::text), speed_limit, speed_limit_unit, source order by imported_at, id) as rn
  from speed_limit_segments)
select 'speed_limit_segments' as entity, count(*) filter (where rn > 1) as repeated_rows from ranked
union all
select 'static_signs (repeats are normal in OSM, see above)', count(*) filter (where rn > 1) from (
  select row_number() over (partition by md5(ST_AsEWKB(position)::text), sign_type, source order by imported_at, id) as rn from static_signs) s
union all
select 'fixed_speed_cameras', count(*) filter (where rn > 1) from (
  select row_number() over (partition by md5(ST_AsEWKB(position)::text), source order by imported_at, id) as rn from fixed_speed_cameras) c;

-- Clean-up for speed_limit_segments (commented out on purpose: run by hand, only if step 1 showed an excess in
-- segments that equals the repeated_rows above):
--
-- begin;
-- delete from speed_limit_segments where id in (
--   select id from (select id, row_number() over (partition by md5(ST_AsEWKB(geometry)::text), speed_limit, speed_limit_unit, source order by imported_at, id) as rn from speed_limit_segments) r where rn > 1);
-- commit;
--
-- Two DIFFERENT OSM ways with the exact same geometry, limit and source would also be collapsed; that is harmless
-- (identical information at the identical place) and such twins are mapping errors in OSM anyway.
