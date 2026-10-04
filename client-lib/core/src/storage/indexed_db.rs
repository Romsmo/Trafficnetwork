//! `IndexedDbStore`: the browser `Store` (add-on B3). Wraps an
//! [`InMemoryStore`] — all the actual entity logic already lives there and
//! is already covered by the shared contract tests — with a `rexie`-backed
//! IndexedDB mirror, so a page reload doesn't lose everything.
//!
//! Chosen over real OPFS (`sqlite-wasm-rs`/`sqlite-wasm-vfs`): both of those
//! were eight days old at the time of this decision (four published
//! versions of the VFS crate), and OPFS's synchronous file access only works
//! inside a dedicated Worker — adopting it would force this binding's whole
//! JS/TS surface into a worker-plus-message-bridge architecture just to get
//! a storage backend. IndexedDB is the user-approved "gleichwertig"
//! alternative (see the retired status log (git history)'s B3 note): real persistence across
//! reloads, no worker requirement, at the cost of `InMemoryStore`'s spatial
//! lookups (a linear scan with a bounding-box pre-filter, same as it already
//! is natively) rather than `SqliteStore`'s R*Tree.
//!
//! `Store`'s methods are synchronous — a deliberate design shared with every
//! other platform (`SqliteStore` blocks on native I/O the same way) — but
//! IndexedDB is only ever reachable asynchronously in a browser. Resolved
//! without touching the trait: every write updates `inner` (the wrapped
//! `InMemoryStore`) immediately and synchronously, exactly like a plain
//! `InMemoryStore` would, and separately spawns a background task
//! ([`wasm_bindgen_futures::spawn_local`]) that mirrors the *entire* current
//! state into one IndexedDB record. Reads always answer from `inner`, never
//! from IndexedDB directly, so they stay synchronous and are never stale
//! within a session.
//!
//! **Documented limits, not hidden** (`client-lib/docs/integration-web.md`):
//!
//! * Persistence is "immediate in memory, soon after in IndexedDB", not
//!   synchronously durable per write: writes within [`MIRROR_DEBOUNCE_MS`] of
//!   each other share one snapshot. A tab crash inside that window (plus the
//!   IndexedDB write itself) can lose those writes' persistence — not the
//!   session's own data, `inner` already has it. The same category of risk
//!   `flush_pending` already accepts for a dropped connection mid-retry,
//!   dated here for the browser specifically.
//! * The whole store lives in memory *and* is written as one record, so cost
//!   grows with the amount of data held. That suits a region's dynamic data
//!   and a modest static dataset; it is not a way to hold a country's or
//!   Europe's static data in a tab (a native `SqliteStore` is).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rexie::{ObjectStore, Rexie, TransactionMode};
use wasm_bindgen::JsValue;

use super::{
    InMemoryStore, LocalCorrectionProposal, PendingWrite, Store, StoreError, StoredEntities,
};
use crate::sync::camera_policy::CameraZone;
use crate::sync::types::{FixedSpeedCamera, HazardReport, SpeedLimitSegment, StaticSign};

const DB_VERSION: u32 = 1;
const OBJECT_STORE: &str = "snapshot";
const SNAPSHOT_KEY: &str = "state";
/// Writes arriving within this window of the first one share one snapshot.
/// Every write re-serializes the *whole* store (there is one record, not one
/// per entity), so a burst — a static-data bootstrap stores a partition per
/// network round trip — must not each pay for that.
const MIRROR_DEBOUNCE_MS: u64 = 250;

pub struct IndexedDbStore {
    inner: Arc<InMemoryStore>,
    db: Arc<Rexie>,
    /// A mirror task is waiting out its debounce window; a write arriving
    /// now needs no task of its own, the pending one snapshots everything
    /// current when it runs.
    mirror_scheduled: Arc<AtomicBool>,
}

impl IndexedDbStore {
    /// Opens (creating on first use) the named IndexedDB database and
    /// hydrates an `InMemoryStore` from whatever was persisted before —
    /// empty for a first run, identical to a fresh `InMemoryStore::new()`.
    pub async fn open(db_name: &str) -> Result<Self, StoreError> {
        let db = Rexie::builder(db_name)
            .version(DB_VERSION)
            .add_object_store(ObjectStore::new(OBJECT_STORE))
            .build()
            .await
            .map_err(to_store_error)?;
        let existing = read_snapshot(&db).await?;
        let inner = Arc::new(match existing {
            Some(json) => InMemoryStore::from_snapshot(&json),
            None => InMemoryStore::new(),
        });
        Ok(Self {
            inner,
            db: Arc::new(db),
            mirror_scheduled: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Schedules the background mirror of the current full state into
    /// IndexedDB — at most one task is ever waiting (see
    /// [`MIRROR_DEBOUNCE_MS`]). Best effort: a failure is logged to the
    /// browser console and otherwise dropped — `inner` (already updated
    /// synchronously by the caller before this runs) stays correct for the
    /// rest of this session either way, see the module doc.
    fn mirror(&self) {
        if self.mirror_scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let inner = self.inner.clone();
        let db = self.db.clone();
        let scheduled = self.mirror_scheduled.clone();
        wasm_bindgen_futures::spawn_local(async move {
            gloo_timers::future::sleep(Duration::from_millis(MIRROR_DEBOUNCE_MS)).await;
            // Cleared *before* snapshotting: a write that lands while this
            // one is still being persisted must start another round.
            scheduled.store(false, Ordering::SeqCst);
            let snapshot = match inner.to_snapshot() {
                Ok(json) => json,
                Err(error) => {
                    log_error(&format!("IndexedDbStore: could not snapshot: {error}"));
                    return;
                }
            };
            if let Err(error) = write_snapshot(&db, &snapshot).await {
                log_error(&format!(
                    "IndexedDbStore: could not persist to IndexedDB: {error}"
                ));
            }
        });
    }
}

fn log_error(message: &str) {
    web_sys::console::error_1(&JsValue::from_str(message));
}

async fn read_snapshot(db: &Rexie) -> Result<Option<String>, StoreError> {
    let tx = db
        .transaction(&[OBJECT_STORE], TransactionMode::ReadOnly)
        .map_err(to_store_error)?;
    let store = tx.store(OBJECT_STORE).map_err(to_store_error)?;
    let value = store
        .get(JsValue::from_str(SNAPSHOT_KEY))
        .await
        .map_err(to_store_error)?;
    tx.done().await.map_err(to_store_error)?;
    Ok(value.and_then(|v| v.as_string()))
}

async fn write_snapshot(db: &Rexie, snapshot: &str) -> Result<(), StoreError> {
    let tx = db
        .transaction(&[OBJECT_STORE], TransactionMode::ReadWrite)
        .map_err(to_store_error)?;
    let store = tx.store(OBJECT_STORE).map_err(to_store_error)?;
    store
        .put(
            &JsValue::from_str(snapshot),
            Some(&JsValue::from_str(SNAPSHOT_KEY)),
        )
        .await
        .map_err(to_store_error)?;
    tx.done().await.map_err(to_store_error)?;
    Ok(())
}

fn to_store_error(error: rexie::Error) -> StoreError {
    Box::new(std::io::Error::other(error.to_string()))
}

// Safety: wasm32 without the `atomics` target feature (which this crate does
// not enable) is single-threaded — there is never a second thread this could
// be sent to or accessed from concurrently. `Store: Send + Sync` is a
// supertrait shared with the native, genuinely multi-threaded implementations
// (`SqliteStore`); `Rexie` wraps a `web_sys`/`JsValue` handle, which is
// conservatively `!Send`/`!Sync` regardless of there being no real thread to
// race with — same justification already used for `bindings/c-abi`'s
// `CallbackSecureStore`.
unsafe impl Send for IndexedDbStore {}
unsafe impl Sync for IndexedDbStore {}

impl Store for IndexedDbStore {
    fn get_cursor(&self, node_id: &str) -> Result<Option<u64>, StoreError> {
        self.inner.get_cursor(node_id)
    }

    fn set_cursor(&self, node_id: &str, since: u64) -> Result<(), StoreError> {
        self.inner.set_cursor(node_id, since)?;
        self.mirror();
        Ok(())
    }

    fn get_partition_hash(&self, tile: &str) -> Result<Option<String>, StoreError> {
        self.inner.get_partition_hash(tile)
    }

    fn set_partition_hash(&self, tile: &str, hash: &str) -> Result<(), StoreError> {
        self.inner.set_partition_hash(tile, hash)?;
        self.mirror();
        Ok(())
    }

    fn clear_static_data(&self) -> Result<(), StoreError> {
        self.inner.clear_static_data()?;
        self.mirror();
        Ok(())
    }

    fn upsert_static_data(&self, data: &StoredEntities) -> Result<(), StoreError> {
        self.inner.upsert_static_data(data)?;
        self.mirror();
        Ok(())
    }

    fn remove_static_entity(&self, entity_type: &str, entity_id: &str) -> Result<(), StoreError> {
        self.inner.remove_static_entity(entity_type, entity_id)?;
        self.mirror();
        Ok(())
    }

    fn upsert_hazard_reports(&self, reports: &[HazardReport]) -> Result<(), StoreError> {
        self.inner.upsert_hazard_reports(reports)?;
        self.mirror();
        Ok(())
    }

    fn remove_hazard_report(&self, id: &str) -> Result<(), StoreError> {
        self.inner.remove_hazard_report(id)?;
        self.mirror();
        Ok(())
    }

    fn all_entities(&self) -> Result<StoredEntities, StoreError> {
        self.inner.all_entities()
    }

    fn enqueue_write(&self, item: &PendingWrite) -> Result<(), StoreError> {
        self.inner.enqueue_write(item)?;
        self.mirror();
        Ok(())
    }

    fn pending_writes(&self) -> Result<Vec<PendingWrite>, StoreError> {
        self.inner.pending_writes()
    }

    fn remove_pending_write(&self, id: &str) -> Result<(), StoreError> {
        self.inner.remove_pending_write(id)?;
        self.mirror();
        Ok(())
    }

    fn upsert_local_proposal(&self, proposal: &LocalCorrectionProposal) -> Result<(), StoreError> {
        self.inner.upsert_local_proposal(proposal)?;
        self.mirror();
        Ok(())
    }

    fn local_proposals(&self) -> Result<Vec<LocalCorrectionProposal>, StoreError> {
        self.inner.local_proposals()
    }

    fn remove_local_proposal(&self, segment_key: &str) -> Result<(), StoreError> {
        self.inner.remove_local_proposal(segment_key)?;
        self.mirror();
        Ok(())
    }

    fn upsert_static_partition(
        &self,
        tile: &str,
        hash: &str,
        data: &StoredEntities,
    ) -> Result<(), StoreError> {
        self.inner.upsert_static_partition(tile, hash, data)?;
        self.mirror();
        Ok(())
    }

    fn speed_limit_segments_near(
        &self,
        lat: f64,
        lng: f64,
        radius_meters: f64,
    ) -> Result<Vec<SpeedLimitSegment>, StoreError> {
        self.inner
            .speed_limit_segments_near(lat, lng, radius_meters)
    }

    fn static_signs_near(
        &self,
        lat: f64,
        lng: f64,
        radius_meters: f64,
    ) -> Result<Vec<StaticSign>, StoreError> {
        self.inner.static_signs_near(lat, lng, radius_meters)
    }

    fn fixed_speed_cameras(&self) -> Result<Vec<FixedSpeedCamera>, StoreError> {
        self.inner.fixed_speed_cameras()
    }

    fn hazard_reports(&self) -> Result<Vec<HazardReport>, StoreError> {
        self.inner.hazard_reports()
    }

    fn speed_limit_segment(&self, id: &str) -> Result<Option<SpeedLimitSegment>, StoreError> {
        self.inner.speed_limit_segment(id)
    }

    fn storage_bytes(&self) -> Option<u64> {
        self.inner.storage_bytes()
    }

    fn static_partition_resolution(&self) -> Result<Option<u8>, StoreError> {
        self.inner.static_partition_resolution()
    }

    fn set_static_partition_resolution(&self, resolution: u8) -> Result<(), StoreError> {
        self.inner.set_static_partition_resolution(resolution)?;
        self.mirror();
        Ok(())
    }

    fn clear_cursors(&self) -> Result<(), StoreError> {
        self.inner.clear_cursors()?;
        self.mirror();
        Ok(())
    }

    fn camera_policy_stamp(&self) -> Result<Option<String>, StoreError> {
        self.inner.camera_policy_stamp()
    }

    fn set_camera_policy_stamp(&self, stamp: &str) -> Result<(), StoreError> {
        self.inner.set_camera_policy_stamp(stamp)?;
        self.mirror();
        Ok(())
    }

    fn camera_zones(&self) -> Result<Vec<CameraZone>, StoreError> {
        self.inner.camera_zones()
    }
}

// `storage::contract::run`'s shared behavioural suite (already exercised
// against `InMemoryStore`/`SqliteStore`) takes a *synchronous* factory
// (`&dyn Fn() -> Box<dyn Store>`), called fresh for each of its ~13
// sub-tests — a shape `IndexedDbStore::open`'s genuinely async database
// connection can't fill without either forcing that shared, natively-tested
// infrastructure to grow an async variant just for this one wasm32-only
// implementation, or silently reusing one instance across sub-tests that
// expect independent state. Neither seemed worth it for a type whose every
// entity method is a direct, untransformed delegation to an already
// contract-tested `InMemoryStore` (see the `impl Store` above — there is no
// entity logic of this type's *own* to prove). What genuinely is this type's
// own logic — hydrating from a snapshot, and mirroring writes back out — is
// what the tests below actually target.
#[cfg(test)]
mod tests {
    use super::*;

    wasm_bindgen_test::wasm_bindgen_test_configure!(run_in_browser);

    /// A fresh database name per test (the process id the native stores use
    /// for the same purpose isn't meaningful in a browser) — real
    /// IndexedDB, in a real headless browser, not a mock.
    fn unique_db_name(test: &str) -> String {
        format!(
            "tn-indexed-db-store-test-{test}-{}",
            js_sys::Date::now() as u64
        )
    }

    /// The mirror is a debounced background task — wait out its window (and
    /// the IndexedDB write itself) before asserting on what landed there.
    async fn let_the_mirror_run() {
        gloo_timers::future::sleep(Duration::from_millis(MIRROR_DEBOUNCE_MS * 3)).await;
    }

    #[wasm_bindgen_test::wasm_bindgen_test]
    async fn opening_a_fresh_database_is_the_same_as_a_fresh_in_memory_store() {
        let store = IndexedDbStore::open(&unique_db_name("fresh"))
            .await
            .unwrap();
        assert_eq!(store.get_cursor("node1").unwrap(), None);
        assert_eq!(store.all_entities().unwrap(), StoredEntities::default());
        assert!(store.pending_writes().unwrap().is_empty());
    }

    #[wasm_bindgen_test::wasm_bindgen_test]
    async fn writes_are_visible_immediately_through_the_same_handle() {
        let store = IndexedDbStore::open(&unique_db_name("immediate"))
            .await
            .unwrap();
        // No wait for the mirror here — a read right after a write, on the
        // same store instance, must never depend on IndexedDB having
        // caught up yet (see the module doc's "immediate in memory, soon
        // after in IndexedDB").
        store.set_cursor("node1", 42).unwrap();
        assert_eq!(store.get_cursor("node1").unwrap(), Some(42));
    }

    #[wasm_bindgen_test::wasm_bindgen_test]
    async fn a_snapshot_persists_across_reopening_the_same_database() {
        let name = unique_db_name("reopen");
        {
            let store = IndexedDbStore::open(&name).await.unwrap();
            store.set_cursor("node1", 42).unwrap();
            store.set_partition_hash("tileA", "hash1").unwrap();
            let_the_mirror_run().await;
        }
        let reopened = IndexedDbStore::open(&name).await.unwrap();
        assert_eq!(reopened.get_cursor("node1").unwrap(), Some(42));
        assert_eq!(
            reopened.get_partition_hash("tileA").unwrap(),
            Some("hash1".to_string())
        );
    }
}
