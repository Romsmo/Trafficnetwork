//! Persistent [`Store`] on SQLite (`rusqlite`, bundled), for native targets.
//!
//! What sets it apart from [`super::InMemoryStore`] is scale: the speed-limit
//! segments — millions of them for a large region — live in their own table
//! with the geometry packed as little-endian 32-bit micro-degrees (1e-7°,
//! about 1 cm: the precision OSM itself stores, and exactly what a decimal
//! `13.3456789` maps back to), indexed by an R*Tree over each segment's
//! bounding box. A position lookup ([`Store::speed_limit_segments_near`])
//! is then a handful of tree probes, and a bootstrap adds a partition and
//! records its hash in one transaction, so an interrupted one resumes at the
//! next partition. Everything else (signs, cameras, reports, the write
//! buffer) is small and stored as JSON.
//!
//! Anything SQLite reports as "disk full" is surfaced as a
//! [`StorageFullError`] so the sync engine can hand the host app a clean,
//! catchable error.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::{
    query_box, segment_bbox, LocalCorrectionProposal, PendingWrite, StorageFullError, Store,
    StoreError, StoredEntities,
};
use crate::sync::camera_policy::CameraZone;
use crate::sync::types::{
    FixedSpeedCamera, Geometry, HazardReport, SegmentCorrection, SpeedLimitSegment, StaticSign,
};

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS cursors (
    node_id TEXT PRIMARY KEY,
    since INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS partition_hashes (
    tile TEXT PRIMARY KEY,
    hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS speed_limit_segments (
    rid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    segment_key TEXT,
    speed_limit REAL NOT NULL,
    unit TEXT NOT NULL,
    source TEXT NOT NULL,
    source_license TEXT,
    imported_at TEXT NOT NULL,
    last_confirmed_at TEXT,
    geometry BLOB NOT NULL,
    correction TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS segment_rtree USING rtree(
    rid, min_lng, max_lng, min_lat, max_lat
);
CREATE TABLE IF NOT EXISTS static_signs (
    rid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS sign_rtree USING rtree(
    rid, min_lng, max_lng, min_lat, max_lat
);
CREATE TABLE IF NOT EXISTS fixed_speed_cameras (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS camera_zones (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hazard_reports (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending_writes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_proposals (segment_key TEXT PRIMARY KEY, data TEXT NOT NULL);
";

const SEGMENT_COLUMNS: &str = "id, segment_key, speed_limit, unit, source, source_license, \
     imported_at, last_confirmed_at, geometry, correction";

const SEGMENT_COLUMNS_FROM_S: &str = "s.id, s.segment_key, s.speed_limit, s.unit, s.source, \
     s.source_license, s.imported_at, s.last_confirmed_at, s.geometry, s.correction";

/// The page cache a store starts with, in KiB — see [`SqliteStore::set_cache_size_kib`].
const DEFAULT_CACHE_KIB: u32 = 16 * 1024;

pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    /// Opens (creating it if needed) the database file at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let conn = Connection::open(path).map_err(db_error)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory().map_err(db_error)?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self, StoreError> {
        // WAL: readers (map matching) never block the bootstrap's writes, and
        // a crash mid-transaction leaves the last committed state intact.
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(db_error)?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(db_error)?;
        // SQLite's own default cache is about 2 MB, too small for the indexes
        // of a Europe-sized bootstrap: 16 MB made the 5 M-segment import
        // about 27 % faster in the measurements
        // (client-lib/docs/bootstrap-measurements.md), more bought little.
        conn.pragma_update(None, "cache_size", -i64::from(DEFAULT_CACHE_KIB))
            .map_err(db_error)?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(db_error)?;
        if version > SCHEMA_VERSION {
            return Err(format!(
                "the database has schema version {version}, this build knows up to {SCHEMA_VERSION}"
            )
            .into());
        }
        conn.execute_batch(SCHEMA).map_err(db_error)?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(db_error)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn with_conn<T>(
        &self,
        work: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, StoreError> {
        let mut conn = self.conn.lock().unwrap();
        work(&mut conn).map_err(db_error)
    }

    /// Folds the write-ahead log back into the main file, so the file's size
    /// is the whole database (for reports; SQLite does it on its own too).
    pub fn checkpoint(&self) -> Result<(), StoreError> {
        self.with_conn(|conn| conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())))
    }

    /// Sets the size of SQLite's page cache for this connection, in KiB
    /// (SQLite's own default is about 2 MiB). A bigger cache makes bulk
    /// inserts into large indexes faster, at the price of that much memory.
    pub fn set_cache_size_kib(&self, kib: u32) -> Result<(), StoreError> {
        self.with_conn(|conn| conn.pragma_update(None, "cache_size", -i64::from(kib)))
    }

    /// `(segments, signs, cameras)` currently stored — without loading them.
    pub fn entity_counts(&self) -> Result<(u64, u64, u64), StoreError> {
        self.with_conn(|conn| {
            let count = |table: &str| -> rusqlite::Result<u64> {
                let n: i64 =
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
                Ok(n as u64)
            };
            Ok((
                count("speed_limit_segments")?,
                count("static_signs")?,
                count("fixed_speed_cameras")?,
            ))
        })
    }

    /// `n` positions taken from randomly chosen stored segments (first
    /// vertex), as `(lat, lng)` — for measuring lookups against real data.
    pub fn sample_positions(&self, n: usize) -> Result<Vec<(f64, f64)>, StoreError> {
        self.with_conn(|conn| {
            let max_rid: i64 = conn.query_row(
                "SELECT COALESCE(MAX(rid), 0) FROM speed_limit_segments",
                [],
                |row| row.get(0),
            )?;
            let mut positions = Vec::with_capacity(n);
            if max_rid == 0 {
                return Ok(positions);
            }
            let mut stmt = conn.prepare_cached(
                "SELECT geometry FROM speed_limit_segments WHERE rid >= ?1 LIMIT 1",
            )?;
            for _ in 0..n {
                let target = 1 + (random_u64() % max_rid as u64) as i64;
                let blob: Option<Vec<u8>> = stmt
                    .query_row(params![target], |row| row.get(0))
                    .optional()?;
                let first = blob.and_then(|b| decode_geometry(&b).first().copied());
                if let Some(first) = first {
                    positions.push((first[1], first[0]));
                }
            }
            Ok(positions)
        })
    }
}

fn random_u64() -> u64 {
    let mut bytes = [0u8; 8];
    // Diagnostics only: if the platform has no RNG, sampling degrades to the
    // first rows rather than failing.
    let _ = getrandom::fill(&mut bytes);
    u64::from_le_bytes(bytes)
}

fn is_disk_full(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, _) if failure.code == rusqlite::ErrorCode::DiskFull
    )
}

fn db_error(error: rusqlite::Error) -> StoreError {
    if is_disk_full(&error) {
        Box::new(StorageFullError)
    } else {
        Box::new(error)
    }
}

fn to_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

fn from_sql_error(column: usize, error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(error))
}

fn micro_degrees(value: f64) -> i32 {
    (value * 1e7).round() as i32
}

fn encode_geometry(coordinates: &[[f64; 2]]) -> Vec<u8> {
    let mut blob = Vec::with_capacity(coordinates.len() * 8);
    for [lng, lat] in coordinates {
        blob.extend_from_slice(&micro_degrees(*lng).to_le_bytes());
        blob.extend_from_slice(&micro_degrees(*lat).to_le_bytes());
    }
    blob
}

fn decode_geometry(blob: &[u8]) -> Vec<[f64; 2]> {
    let (pairs, _) = blob.as_chunks::<8>();
    pairs
        .iter()
        .map(|c| {
            let lng = i32::from_le_bytes([c[0], c[1], c[2], c[3]]);
            let lat = i32::from_le_bytes([c[4], c[5], c[6], c[7]]);
            [f64::from(lng) / 1e7, f64::from(lat) / 1e7]
        })
        .collect()
}

/// The correction fields, kept as one JSON cell that is `NULL` for the
/// overwhelming majority of segments (those that aren't corrected).
#[derive(Default, Serialize, Deserialize)]
struct CorrectionCell {
    #[serde(rename = "correctedBy")]
    corrected_by: Option<String>,
    #[serde(rename = "importedSpeedLimit")]
    imported_speed_limit: Option<f64>,
    correction: Option<SegmentCorrection>,
}

fn segment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SpeedLimitSegment> {
    let blob: Vec<u8> = row.get(8)?;
    let cell: Option<String> = row.get(9)?;
    let cell = match cell {
        Some(text) => {
            serde_json::from_str::<CorrectionCell>(&text).map_err(|e| from_sql_error(9, e))?
        }
        None => CorrectionCell::default(),
    };
    Ok(SpeedLimitSegment {
        id: row.get(0)?,
        segment_key: row.get(1)?,
        speed_limit: row.get(2)?,
        speed_limit_unit: row.get(3)?,
        source: row.get(4)?,
        source_license: row.get(5)?,
        imported_at: row.get(6)?,
        last_confirmed_at: row.get(7)?,
        geometry: Geometry::LineString {
            coordinates: decode_geometry(&blob),
        },
        corrected_by: cell.corrected_by,
        imported_speed_limit: cell.imported_speed_limit,
        correction: cell.correction,
    })
}

fn upsert_segment(tx: &Transaction<'_>, segment: &SpeedLimitSegment) -> rusqlite::Result<()> {
    let Geometry::LineString { coordinates } = &segment.geometry else {
        return Err(rusqlite::Error::ToSqlConversionFailure(
            "a speed-limit segment's geometry must be a LineString".into(),
        ));
    };
    let has_correction = segment.corrected_by.is_some()
        || segment.imported_speed_limit.is_some()
        || segment.correction.is_some();
    let correction = if has_correction {
        let cell = CorrectionCell {
            corrected_by: segment.corrected_by.clone(),
            imported_speed_limit: segment.imported_speed_limit,
            correction: segment.correction.clone(),
        };
        Some(serde_json::to_string(&cell).map_err(to_sql_error)?)
    } else {
        None
    };
    let rid: i64 = tx
        .prepare_cached(
            "INSERT INTO speed_limit_segments \
                 (id, segment_key, speed_limit, unit, source, source_license, imported_at, \
                  last_confirmed_at, geometry, correction) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
             ON CONFLICT(id) DO UPDATE SET \
                 segment_key = excluded.segment_key, speed_limit = excluded.speed_limit, \
                 unit = excluded.unit, source = excluded.source, \
                 source_license = excluded.source_license, imported_at = excluded.imported_at, \
                 last_confirmed_at = excluded.last_confirmed_at, geometry = excluded.geometry, \
                 correction = excluded.correction \
             RETURNING rid",
        )?
        .query_row(
            params![
                segment.id,
                segment.segment_key,
                segment.speed_limit,
                segment.speed_limit_unit,
                segment.source,
                segment.source_license,
                segment.imported_at,
                segment.last_confirmed_at,
                encode_geometry(coordinates),
                correction,
            ],
            |row| row.get(0),
        )?;
    if let Some((min_lng, max_lng, min_lat, max_lat)) = segment_bbox(segment) {
        tx.prepare_cached(
            "INSERT OR REPLACE INTO segment_rtree (rid, min_lng, max_lng, min_lat, max_lat) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?
        .execute(params![rid, min_lng, max_lng, min_lat, max_lat])?;
    }
    Ok(())
}

fn upsert_json<T: Serialize>(
    tx: &Transaction<'_>,
    table: &str,
    id: &str,
    value: &T,
) -> rusqlite::Result<()> {
    let data = serde_json::to_string(value).map_err(to_sql_error)?;
    tx.prepare_cached(&format!(
        "INSERT INTO {table} (id, data) VALUES (?1, ?2) \
         ON CONFLICT(id) DO UPDATE SET data = excluded.data"
    ))?
    .execute(params![id, data])?;
    Ok(())
}

/// A sign is a row of JSON plus an entry in the R*Tree (keyed by the row's
/// `rid`), so that "the signs around here" does not read them all.
fn upsert_sign(tx: &Transaction<'_>, sign: &StaticSign) -> rusqlite::Result<()> {
    let data = serde_json::to_string(sign).map_err(to_sql_error)?;
    let rid: i64 = tx
        .prepare_cached(
            "INSERT INTO static_signs (id, data) VALUES (?1, ?2) \
             ON CONFLICT(id) DO UPDATE SET data = excluded.data \
             RETURNING rid",
        )?
        .query_row(params![sign.id, data], |row| row.get(0))?;
    if let Some((lat, lng)) = sign.position.as_lat_lng() {
        tx.prepare_cached(
            "INSERT OR REPLACE INTO sign_rtree (rid, min_lng, max_lng, min_lat, max_lat) \
             VALUES (?1, ?2, ?2, ?3, ?3)",
        )?
        .execute(params![rid, lng, lat])?;
    }
    Ok(())
}

fn read_json<T: DeserializeOwned>(conn: &Connection, table: &str) -> rusqlite::Result<Vec<T>> {
    let mut stmt = conn.prepare(&format!("SELECT data FROM {table} ORDER BY rowid"))?;
    let rows = stmt.query_map([], |row| {
        let text: String = row.get(0)?;
        serde_json::from_str::<T>(&text).map_err(|e| from_sql_error(0, e))
    })?;
    rows.collect()
}

fn upsert_static(tx: &Transaction<'_>, data: &StoredEntities) -> rusqlite::Result<()> {
    for segment in &data.speed_limit_segments {
        upsert_segment(tx, segment)?;
    }
    for sign in &data.static_signs {
        upsert_sign(tx, sign)?;
    }
    for camera in &data.fixed_speed_cameras {
        upsert_json(tx, "fixed_speed_cameras", &camera.id, camera)?;
    }
    for zone in &data.camera_zones {
        upsert_json(tx, "camera_zones", &zone.id, zone)?;
    }
    Ok(())
}

impl Store for SqliteStore {
    fn get_cursor(&self, node_id: &str) -> Result<Option<u64>, StoreError> {
        self.with_conn(|conn| {
            let since: Option<i64> = conn
                .query_row(
                    "SELECT since FROM cursors WHERE node_id = ?1",
                    params![node_id],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(since.map(|s| s as u64))
        })
    }

    fn set_cursor(&self, node_id: &str, since: u64) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO cursors (node_id, since) VALUES (?1, ?2) \
                 ON CONFLICT(node_id) DO UPDATE SET since = excluded.since",
                params![node_id, since as i64],
            )?;
            Ok(())
        })
    }

    fn get_partition_hash(&self, tile: &str) -> Result<Option<String>, StoreError> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT hash FROM partition_hashes WHERE tile = ?1",
                params![tile],
                |row| row.get(0),
            )
            .optional()
        })
    }

    fn set_partition_hash(&self, tile: &str, hash: &str) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO partition_hashes (tile, hash) VALUES (?1, ?2) \
                 ON CONFLICT(tile) DO UPDATE SET hash = excluded.hash",
                params![tile, hash],
            )?;
            Ok(())
        })
    }

    fn clear_cursors(&self) -> Result<(), StoreError> {
        self.with_conn(|conn| conn.execute("DELETE FROM cursors", []).map(|_| ()))
    }

    fn clear_static_data(&self) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            let tx = conn.transaction()?;
            tx.execute_batch(
                "DELETE FROM segment_rtree; DELETE FROM speed_limit_segments; \
                 DELETE FROM sign_rtree; DELETE FROM static_signs; \
                 DELETE FROM fixed_speed_cameras; DELETE FROM camera_zones; \
                 DELETE FROM partition_hashes; \
                 DELETE FROM meta WHERE key = 'static_partition_resolution';",
            )?;
            tx.commit()
        })
    }

    fn static_partition_resolution(&self) -> Result<Option<u8>, StoreError> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT value FROM meta WHERE key = 'static_partition_resolution'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map(|value| value.and_then(|v| v.parse().ok()))
        })
    }

    fn set_static_partition_resolution(&self, resolution: u8) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('static_partition_resolution', ?1) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [resolution.to_string()],
            )
            .map(|_| ())
        })
    }

    fn camera_policy_stamp(&self) -> Result<Option<String>, StoreError> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT value FROM meta WHERE key = 'camera_policy_stamp'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })
    }

    fn set_camera_policy_stamp(&self, stamp: &str) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('camera_policy_stamp', ?1) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [stamp],
            )
            .map(|_| ())
        })
    }

    fn camera_zones(&self) -> Result<Vec<CameraZone>, StoreError> {
        self.with_conn(|conn| read_json::<CameraZone>(conn, "camera_zones"))
    }

    fn upsert_static_data(&self, data: &StoredEntities) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            let tx = conn.transaction()?;
            upsert_static(&tx, data)?;
            tx.commit()
        })
    }

    fn upsert_static_partition(
        &self,
        tile: &str,
        hash: &str,
        data: &StoredEntities,
    ) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            let tx = conn.transaction()?;
            upsert_static(&tx, data)?;
            tx.execute(
                "INSERT INTO partition_hashes (tile, hash) VALUES (?1, ?2) \
                 ON CONFLICT(tile) DO UPDATE SET hash = excluded.hash",
                params![tile, hash],
            )?;
            tx.commit()
        })
    }

    fn remove_static_entity(&self, entity_type: &str, entity_id: &str) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            let tx = conn.transaction()?;
            match entity_type {
                "speedLimitSegment" => {
                    let rid: Option<i64> = tx
                        .query_row(
                            "SELECT rid FROM speed_limit_segments WHERE id = ?1",
                            params![entity_id],
                            |row| row.get(0),
                        )
                        .optional()?;
                    if let Some(rid) = rid {
                        tx.execute("DELETE FROM segment_rtree WHERE rid = ?1", params![rid])?;
                        tx.execute(
                            "DELETE FROM speed_limit_segments WHERE rid = ?1",
                            params![rid],
                        )?;
                    }
                }
                "staticSign" => {
                    let rid: Option<i64> = tx
                        .query_row(
                            "SELECT rid FROM static_signs WHERE id = ?1",
                            params![entity_id],
                            |row| row.get(0),
                        )
                        .optional()?;
                    if let Some(rid) = rid {
                        tx.execute("DELETE FROM sign_rtree WHERE rid = ?1", params![rid])?;
                        tx.execute("DELETE FROM static_signs WHERE rid = ?1", params![rid])?;
                    }
                }
                "fixedSpeedCamera" => {
                    tx.execute(
                        "DELETE FROM fixed_speed_cameras WHERE id = ?1",
                        params![entity_id],
                    )?;
                }
                "cameraZone" => {
                    tx.execute("DELETE FROM camera_zones WHERE id = ?1", params![entity_id])?;
                }
                _ => {}
            }
            tx.commit()
        })
    }

    fn upsert_hazard_reports(&self, reports: &[HazardReport]) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            let tx = conn.transaction()?;
            for report in reports {
                upsert_json(&tx, "hazard_reports", &report.id, report)?;
            }
            tx.commit()
        })
    }

    fn remove_hazard_report(&self, id: &str) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM hazard_reports WHERE id = ?1", params![id])?;
            Ok(())
        })
    }

    fn all_entities(&self) -> Result<StoredEntities, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT {SEGMENT_COLUMNS} FROM speed_limit_segments ORDER BY rid"
            ))?;
            let speed_limit_segments = stmt
                .query_map([], segment_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(StoredEntities {
                speed_limit_segments,
                static_signs: read_json::<StaticSign>(conn, "static_signs")?,
                fixed_speed_cameras: read_json::<FixedSpeedCamera>(conn, "fixed_speed_cameras")?,
                hazard_reports: read_json::<HazardReport>(conn, "hazard_reports")?,
                camera_zones: read_json::<CameraZone>(conn, "camera_zones")?,
            })
        })
    }

    fn speed_limit_segment(&self, id: &str) -> Result<Option<SpeedLimitSegment>, StoreError> {
        self.with_conn(|conn| {
            conn.prepare_cached(&format!(
                "SELECT {SEGMENT_COLUMNS} FROM speed_limit_segments WHERE id = ?1"
            ))?
            .query_row(params![id], segment_from_row)
            .optional()
        })
    }

    fn speed_limit_segments_near(
        &self,
        lat: f64,
        lng: f64,
        radius_meters: f64,
    ) -> Result<Vec<SpeedLimitSegment>, StoreError> {
        let (min_lng, max_lng, min_lat, max_lat) = query_box(lat, lng, radius_meters);
        self.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT {SEGMENT_COLUMNS_FROM_S} FROM segment_rtree r \
                 JOIN speed_limit_segments s ON s.rid = r.rid \
                 WHERE r.max_lng >= ?1 AND r.min_lng <= ?2 \
                   AND r.max_lat >= ?3 AND r.min_lat <= ?4"
            ))?;
            let bounds = params![min_lng, max_lng, min_lat, max_lat];
            let rows = stmt.query_map(bounds, segment_from_row)?;
            rows.collect()
        })
    }

    fn static_signs_near(
        &self,
        lat: f64,
        lng: f64,
        radius_meters: f64,
    ) -> Result<Vec<StaticSign>, StoreError> {
        let (min_lng, max_lng, min_lat, max_lat) = query_box(lat, lng, radius_meters);
        self.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT s.data FROM sign_rtree r JOIN static_signs s ON s.rid = r.rid \
                 WHERE r.max_lng >= ?1 AND r.min_lng <= ?2 \
                   AND r.max_lat >= ?3 AND r.min_lat <= ?4",
            )?;
            let bounds = params![min_lng, max_lng, min_lat, max_lat];
            let rows = stmt.query_map(bounds, |row| {
                let text: String = row.get(0)?;
                serde_json::from_str::<StaticSign>(&text).map_err(|e| from_sql_error(0, e))
            })?;
            rows.collect()
        })
    }

    fn fixed_speed_cameras(&self) -> Result<Vec<FixedSpeedCamera>, StoreError> {
        self.with_conn(|conn| read_json::<FixedSpeedCamera>(conn, "fixed_speed_cameras"))
    }

    fn hazard_reports(&self) -> Result<Vec<HazardReport>, StoreError> {
        self.with_conn(|conn| read_json::<HazardReport>(conn, "hazard_reports"))
    }

    fn storage_bytes(&self) -> Option<u64> {
        let conn = self.conn.lock().unwrap();
        let pages: i64 = conn
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .ok()?;
        let page_size: i64 = conn
            .query_row("PRAGMA page_size", [], |row| row.get(0))
            .ok()?;
        Some((pages * page_size) as u64)
    }

    fn enqueue_write(&self, item: &PendingWrite) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            let data = serde_json::to_string(item).map_err(to_sql_error)?;
            let tx = conn.transaction()?;
            tx.execute("DELETE FROM pending_writes WHERE id = ?1", params![item.id])?;
            tx.execute(
                "INSERT INTO pending_writes (id, data) VALUES (?1, ?2)",
                params![item.id, data],
            )?;
            tx.commit()
        })
    }

    fn pending_writes(&self) -> Result<Vec<PendingWrite>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT data FROM pending_writes ORDER BY seq")?;
            let rows = stmt.query_map([], |row| {
                let text: String = row.get(0)?;
                serde_json::from_str::<PendingWrite>(&text).map_err(|e| from_sql_error(0, e))
            })?;
            rows.collect()
        })
    }

    fn remove_pending_write(&self, id: &str) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM pending_writes WHERE id = ?1", params![id])?;
            Ok(())
        })
    }

    fn upsert_local_proposal(&self, proposal: &LocalCorrectionProposal) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            let data = serde_json::to_string(proposal).map_err(to_sql_error)?;
            conn.execute(
                "INSERT INTO local_proposals (segment_key, data) VALUES (?1, ?2) \
                 ON CONFLICT(segment_key) DO UPDATE SET data = excluded.data",
                params![proposal.segment_key, data],
            )?;
            Ok(())
        })
    }

    fn local_proposals(&self) -> Result<Vec<LocalCorrectionProposal>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT data FROM local_proposals ORDER BY rowid")?;
            let rows = stmt.query_map([], |row| {
                let text: String = row.get(0)?;
                serde_json::from_str::<LocalCorrectionProposal>(&text)
                    .map_err(|e| from_sql_error(0, e))
            })?;
            rows.collect()
        })
    }

    fn remove_local_proposal(&self, segment_key: &str) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM local_proposals WHERE segment_key = ?1",
                params![segment_key],
            )?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::contract;

    #[test]
    fn behaves_like_every_other_store() {
        contract::run(&|| Box::new(SqliteStore::open_in_memory().unwrap()));
    }

    #[test]
    fn geometry_survives_the_packed_encoding() {
        let coordinates = vec![[11.5754321, 48.1372345], [-0.1276, 51.5072], [13.0, 52.0]];
        assert_eq!(decode_geometry(&encode_geometry(&coordinates)), coordinates);
    }

    #[test]
    fn a_file_database_keeps_its_data_and_partition_hashes_across_a_reopen() {
        let path = std::env::temp_dir().join(format!("tn-sqlite-reopen-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let store = SqliteStore::open(&path).unwrap();
            store.set_cursor("node1", 42).unwrap();
            let data = contract::sample_static_data();
            store
                .upsert_static_partition("tileA", "hash-1", &data)
                .unwrap();
        }
        let reopened = SqliteStore::open(&path).unwrap();
        assert_eq!(reopened.get_cursor("node1").unwrap(), Some(42));
        assert_eq!(
            reopened.get_partition_hash("tileA").unwrap().as_deref(),
            Some("hash-1")
        );
        assert_eq!(
            reopened.all_entities().unwrap().speed_limit_segments.len(),
            contract::sample_static_data().speed_limit_segments.len()
        );
        assert!(reopened.storage_bytes().unwrap() > 0);
        drop(reopened);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn a_full_disk_is_reported_as_storage_full() {
        let full = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL),
            None,
        );
        assert!(super::super::is_storage_full(&db_error(full)));
        let other = rusqlite::Error::QueryReturnedNoRows;
        assert!(!super::super::is_storage_full(&db_error(other)));
    }
}
