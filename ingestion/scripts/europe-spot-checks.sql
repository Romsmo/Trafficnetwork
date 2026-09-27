-- Post-import spot checks for the Europe base data (docs/europe-runbook.md, "After the run").
-- Read-only. Run against the node's database, e.g.:
--   docker exec -i tn-europe-postgres-1 psql -U trafficnetwork -d trafficnetwork < ingestion/scripts/europe-spot-checks.sql
--
-- 1. Row counts and provenance per entity.
-- 2. For well-known places in different countries: how much data lies within ~2 km, and the nearest speed-limit segments
--    with their limits and distance. The expectations are plausibility ranges written by a human (urban roads are
--    typically 30/50 km/h, UK values are mph, motorways 100-140) — a place with NO nearby segment or an absurd value is
--    what this is looking for; it does not replace comparing against the source extract.

\echo === rows per entity, with provenance ===
select 'speed_limit_segments' as entity, source, source_license, count(*) from speed_limit_segments group by 2, 3
union all select 'static_signs', source, source_license, count(*) from static_signs group by 2, 3
union all select 'fixed_speed_cameras', source, source_license, count(*) from fixed_speed_cameras group by 2, 3
order by 1, 2;

\echo === speed-limit units and value distribution (top 12) ===
select speed_limit_unit, speed_limit, count(*) from speed_limit_segments group by 1, 2 order by 3 desc limit 12;

\echo === spot checks: known places ===
with places(name, country, lat, lng) as (values
  ('Berlin, Brandenburger Tor',        'DE', 52.5163, 13.3777),
  ('Munich, Marienplatz',              'DE', 48.1374, 11.5755),
  ('Vienna, Stephansplatz',            'AT', 48.2085, 16.3730),
  ('Bern, Bundesplatz',                'CH', 46.9466,  7.4442),
  ('Paris, Arc de Triomphe',           'FR', 48.8738,  2.2950),
  ('Lyon, Place Bellecour',            'FR', 45.7578,  4.8320),
  ('Rome, Colosseum',                  'IT', 41.8902, 12.4922),
  ('Milan, Duomo',                     'IT', 45.4642,  9.1916),
  ('Madrid, Puerta del Sol',           'ES', 40.4169, -3.7035),
  ('Barcelona, Plaça de Catalunya',    'ES', 41.3870,  2.1701),
  ('Lisbon, Praça do Comércio',        'PT', 38.7076, -9.1364),
  ('Amsterdam, Centraal Station',      'NL', 52.3791,  4.9003),
  ('Brussels, Grand-Place',            'BE', 50.8467,  4.3525),
  ('London, Trafalgar Square',         'GB', 51.5080, -0.1281),
  ('Dublin, O''Connell Bridge',        'IE', 53.3473, -6.2591),
  ('Copenhagen, Rådhuspladsen',        'DK', 55.6761, 12.5683),
  ('Stockholm, Sergels torg',          'SE', 59.3326, 18.0649),
  ('Oslo, Rådhuset',                   'NO', 59.9117, 10.7336),
  ('Helsinki, Senate Square',          'FI', 60.1699, 24.9527),
  ('Warsaw, Palace of Culture',        'PL', 52.2318, 21.0060),
  ('Prague, Wenceslas Square',         'CZ', 50.0813, 14.4280),
  ('Budapest, Chain Bridge',           'HU', 47.4989, 19.0435),
  ('Bucharest, Piața Victoriei',       'RO', 44.4522, 26.0860),
  ('Athens, Syntagma Square',          'GR', 37.9755, 23.7348),
  ('Zagreb, Ban Jelačić Square',       'HR', 45.8131, 15.9772)
)
select p.name, p.country,
       (select count(*) from speed_limit_segments s where ST_DWithin(s.geometry, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326), 0.02)) as segments_within_2km,
       (select count(*) from static_signs s where ST_DWithin(s.position, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326), 0.02)) as signs_within_2km,
       (select string_agg(x.txt, ', ' order by x.d) from (
          select s.speed_limit || case when s.speed_limit_unit = 'mph' then ' mph' else '' end || ' @' || round(ST_Distance(s.geometry::geography, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)::geography))::int || 'm' as txt,
                 ST_Distance(s.geometry::geography, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)::geography) as d
          from speed_limit_segments s
          where ST_DWithin(s.geometry, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326), 0.01)
          order by d limit 4) x) as nearest_limits
from places p
order by p.country, p.name;
