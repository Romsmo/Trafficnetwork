//! Reference [`super::Store`] implementation — plain in-memory maps behind a
//! `Mutex`, no persistence across process restarts. Used by every test in
//! this crate that needs a `Store`; a host app that hasn't wired up a real
//! embedded database yet can also use it directly (it just won't survive a
//! restart).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::{
    boxes_intersect, query_box, segment_bbox, LocalCorrectionProposal, PendingWrite,
    StorageFullError, Store, StoreError, StoredEntities,
};
use crate::sync::types::{HazardReport, SpeedLimitSegment, StaticSign};

#[derive(Default, Serialize, Deserialize)]
struct Inner {
    cursors: HashMap<String, u64>,
    partition_hashes: HashMap<String, String>,
    entities: StoredEntities,
    pending_writes: Vec<PendingWrite>,
    local_proposals: Vec<LocalCorrectionProposal>,
    #[serde(skip)]
    static_entity_limit: Option<usize>,
    static_partition_resolution: Option<u8>,
}

#[derive(Default)]
pub struct InMemoryStore {
    inner: Mutex<Inner>,
}

impl InMemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// A JSON snapshot of everything this store holds — for a host binding
    /// that persists an `InMemoryStore`'s contents itself rather than
    /// re-implementing entity storage (`storage::IndexedDbStore`, add-on B3):
    /// mirror this after every write, restore it once at startup.
    /// `static_entity_limit` is deliberately not part of the snapshot — it's
    /// a test-only knob (see [`Self::with_static_entity_limit`]), never a
    /// real host app's persisted setting.
    pub fn to_snapshot(&self) -> Result<String, StoreError> {
        serde_json::to_string(&*self.inner.lock().unwrap()).map_err(|e| Box::new(e) as StoreError)
    }

    /// Rebuilds a store from [`Self::to_snapshot`]'s output. An empty or
    /// unparseable string is treated as "nothing saved yet" (a fresh store),
    /// not an error — the caller (a host binding opening its persisted
    /// database for the first time) shouldn't have to special-case that.
    pub fn from_snapshot(json: &str) -> Self {
        let inner = if json.trim().is_empty() {
            Inner::default()
        } else {
            serde_json::from_str(json).unwrap_or_default()
        };
        Self {
            inner: Mutex::new(inner),
        }
    }

    /// A store that refuses static data beyond `limit` entities with a
    /// [`StorageFullError`] — the deterministic stand-in for a full disk, so
    /// the "out of space, then space again" path can be tested.
    pub fn with_static_entity_limit(limit: usize) -> Self {
        let store = Self::default();
        store.set_static_entity_limit(Some(limit));
        store
    }

    /// Raises, lowers or (`None`) removes the limit — "the user freed space".
    pub fn set_static_entity_limit(&self, limit: Option<usize>) {
        self.inner.lock().unwrap().static_entity_limit = limit;
    }
}

fn count_new<T>(existing: &[T], incoming: &[T], id_of: impl Fn(&T) -> &str) -> usize {
    incoming
        .iter()
        .filter(|item| !existing.iter().any(|e| id_of(e) == id_of(item)))
        .count()
}

fn upsert_by_id<T: Clone>(existing: &mut Vec<T>, incoming: &[T], id_of: impl Fn(&T) -> &str) {
    for item in incoming {
        let id = id_of(item);
        match existing.iter_mut().find(|e| id_of(e) == id) {
            Some(slot) => *slot = item.clone(),
            None => existing.push(item.clone()),
        }
    }
}

impl Store for InMemoryStore {
    fn get_cursor(&self, node_id: &str) -> Result<Option<u64>, StoreError> {
        Ok(self.inner.lock().unwrap().cursors.get(node_id).copied())
    }

    fn set_cursor(&self, node_id: &str, since: u64) -> Result<(), StoreError> {
        self.inner
            .lock()
            .unwrap()
            .cursors
            .insert(node_id.to_string(), since);
        Ok(())
    }

    fn get_partition_hash(&self, tile: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .inner
            .lock()
            .unwrap()
            .partition_hashes
            .get(tile)
            .cloned())
    }

    fn static_signs_near(
        &self,
        lat: f64,
        lng: f64,
        radius_meters: f64,
    ) -> Result<Vec<StaticSign>, StoreError> {
        let query = query_box(lat, lng, radius_meters);
        let inner = self.inner.lock().unwrap();
        Ok(inner
            .entities
            .static_signs
            .iter()
            .filter(|sign| {
                sign.position
                    .as_lat_lng()
                    .is_some_and(|(sign_lat, sign_lng)| {
                        boxes_intersect(query, (sign_lng, sign_lng, sign_lat, sign_lat))
                    })
            })
            .cloned()
            .collect())
    }

    fn static_partition_resolution(&self) -> Result<Option<u8>, StoreError> {
        Ok(self.inner.lock().unwrap().static_partition_resolution)
    }

    fn set_static_partition_resolution(&self, resolution: u8) -> Result<(), StoreError> {
        self.inner.lock().unwrap().static_partition_resolution = Some(resolution);
        Ok(())
    }

    fn set_partition_hash(&self, tile: &str, hash: &str) -> Result<(), StoreError> {
        self.inner
            .lock()
            .unwrap()
            .partition_hashes
            .insert(tile.to_string(), hash.to_string());
        Ok(())
    }

    fn clear_static_data(&self) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        inner.entities.speed_limit_segments.clear();
        inner.entities.static_signs.clear();
        inner.entities.fixed_speed_cameras.clear();
        inner.partition_hashes.clear();
        inner.static_partition_resolution = None;
        Ok(())
    }

    fn upsert_static_data(&self, data: &StoredEntities) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        if let Some(limit) = inner.static_entity_limit {
            let entities = &inner.entities;
            let current = entities.speed_limit_segments.len()
                + entities.static_signs.len()
                + entities.fixed_speed_cameras.len();
            let added = count_new(
                &entities.speed_limit_segments,
                &data.speed_limit_segments,
                |s| &s.id,
            ) + count_new(&entities.static_signs, &data.static_signs, |s| &s.id)
                + count_new(
                    &entities.fixed_speed_cameras,
                    &data.fixed_speed_cameras,
                    |c| &c.id,
                );
            if current + added > limit {
                return Err(Box::new(StorageFullError));
            }
        }
        upsert_by_id(
            &mut inner.entities.speed_limit_segments,
            &data.speed_limit_segments,
            |s| &s.id,
        );
        upsert_by_id(&mut inner.entities.static_signs, &data.static_signs, |s| {
            &s.id
        });
        upsert_by_id(
            &mut inner.entities.fixed_speed_cameras,
            &data.fixed_speed_cameras,
            |c| &c.id,
        );
        Ok(())
    }

    fn remove_static_entity(&self, entity_type: &str, entity_id: &str) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        match entity_type {
            "speedLimitSegment" => {
                inner
                    .entities
                    .speed_limit_segments
                    .retain(|s| s.id != entity_id);
            }
            "staticSign" => {
                inner.entities.static_signs.retain(|s| s.id != entity_id);
            }
            "fixedSpeedCamera" => {
                inner
                    .entities
                    .fixed_speed_cameras
                    .retain(|c| c.id != entity_id);
            }
            _ => {}
        }
        Ok(())
    }

    fn upsert_hazard_reports(&self, reports: &[HazardReport]) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        upsert_by_id(&mut inner.entities.hazard_reports, reports, |r| &r.id);
        Ok(())
    }

    fn remove_hazard_report(&self, id: &str) -> Result<(), StoreError> {
        self.inner
            .lock()
            .unwrap()
            .entities
            .hazard_reports
            .retain(|r| r.id != id);
        Ok(())
    }

    fn all_entities(&self) -> Result<StoredEntities, StoreError> {
        Ok(self.inner.lock().unwrap().entities.clone())
    }

    fn speed_limit_segment(&self, id: &str) -> Result<Option<SpeedLimitSegment>, StoreError> {
        let inner = self.inner.lock().unwrap();
        Ok(inner
            .entities
            .speed_limit_segments
            .iter()
            .find(|s| s.id == id)
            .cloned())
    }

    fn speed_limit_segments_near(
        &self,
        lat: f64,
        lng: f64,
        radius_meters: f64,
    ) -> Result<Vec<SpeedLimitSegment>, StoreError> {
        let wanted = query_box(lat, lng, radius_meters);
        let inner = self.inner.lock().unwrap();
        Ok(inner
            .entities
            .speed_limit_segments
            .iter()
            .filter(|s| segment_bbox(s).is_some_and(|bbox| boxes_intersect(bbox, wanted)))
            .cloned()
            .collect())
    }

    fn enqueue_write(&self, item: &PendingWrite) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        inner.pending_writes.retain(|w| w.id != item.id);
        inner.pending_writes.push(item.clone());
        Ok(())
    }

    fn pending_writes(&self) -> Result<Vec<PendingWrite>, StoreError> {
        Ok(self.inner.lock().unwrap().pending_writes.clone())
    }

    fn remove_pending_write(&self, id: &str) -> Result<(), StoreError> {
        self.inner
            .lock()
            .unwrap()
            .pending_writes
            .retain(|w| w.id != id);
        Ok(())
    }

    fn upsert_local_proposal(&self, proposal: &LocalCorrectionProposal) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        inner
            .local_proposals
            .retain(|p| p.segment_key != proposal.segment_key);
        inner.local_proposals.push(proposal.clone());
        Ok(())
    }

    fn local_proposals(&self) -> Result<Vec<LocalCorrectionProposal>, StoreError> {
        Ok(self.inner.lock().unwrap().local_proposals.clone())
    }

    fn remove_local_proposal(&self, segment_key: &str) -> Result<(), StoreError> {
        self.inner
            .lock()
            .unwrap()
            .local_proposals
            .retain(|p| p.segment_key != segment_key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{ProposalState, WriteKind};
    use crate::sync::types::{Geometry, HazardType, SpeedLimitUnit};

    fn sample_report(id: &str) -> HazardReport {
        HazardReport {
            id: id.to_string(),
            hazard_type: HazardType::Ice,
            position: Geometry::Point {
                coordinates: [13.4, 52.5],
            },
            region_tile: "tile1".to_string(),
            reported_at: "2026-01-01T00:00:00Z".to_string(),
            reporter_id: "r1".to_string(),
            speed_kmh: None,
            expires_at: "2026-01-01T00:20:00Z".to_string(),
            status: "active".to_string(),
            source: "community".to_string(),
            source_license: None,
            confirm_count: 0,
            deny_count: 0,
        }
    }

    #[test]
    fn cursor_round_trips_per_node() {
        let store = InMemoryStore::new();
        assert_eq!(store.get_cursor("node1").unwrap(), None);
        store.set_cursor("node1", 42).unwrap();
        store.set_cursor("node2", 7).unwrap();
        assert_eq!(store.get_cursor("node1").unwrap(), Some(42));
        assert_eq!(store.get_cursor("node2").unwrap(), Some(7));
    }

    #[test]
    fn upsert_hazard_reports_replaces_by_id_rather_than_duplicating() {
        let store = InMemoryStore::new();
        store
            .upsert_hazard_reports(&[sample_report("hr1")])
            .unwrap();
        let mut updated = sample_report("hr1");
        updated.confirm_count = 3;
        store.upsert_hazard_reports(&[updated]).unwrap();

        let all = store.all_entities().unwrap();
        assert_eq!(all.hazard_reports.len(), 1);
        assert_eq!(all.hazard_reports[0].confirm_count, 3);
    }

    #[test]
    fn remove_hazard_report_deletes_by_id() {
        let store = InMemoryStore::new();
        store
            .upsert_hazard_reports(&[sample_report("hr1"), sample_report("hr2")])
            .unwrap();
        store.remove_hazard_report("hr1").unwrap();
        let all = store.all_entities().unwrap();
        assert_eq!(all.hazard_reports.len(), 1);
        assert_eq!(all.hazard_reports[0].id, "hr2");
    }

    #[test]
    fn clear_static_data_leaves_hazard_reports_untouched() {
        let store = InMemoryStore::new();
        store
            .upsert_hazard_reports(&[sample_report("hr1")])
            .unwrap();
        store.set_partition_hash("tileA", "hash1").unwrap();
        store.clear_static_data().unwrap();

        assert_eq!(store.all_entities().unwrap().hazard_reports.len(), 1);
        assert_eq!(store.get_partition_hash("tileA").unwrap(), None);
    }

    fn proposal(segment_key: &str, value: u32) -> LocalCorrectionProposal {
        LocalCorrectionProposal {
            segment_key: segment_key.to_string(),
            segment_id: "seg1".to_string(),
            value,
            unit: SpeedLimitUnit::Kmh,
            reason: None,
            state: ProposalState::Queued,
            correction_id: None,
            confirmations: 0,
            proposed_at_unix_ms: 1000,
        }
    }

    #[test]
    fn a_local_proposal_is_replaced_per_segment_key_and_removable() {
        let store = InMemoryStore::new();
        let first = proposal("keyA", 30);
        let other = proposal("keyB", 50);
        let second = proposal("keyA", 70);
        store.upsert_local_proposal(&first).unwrap();
        store.upsert_local_proposal(&other).unwrap();
        store.upsert_local_proposal(&second).unwrap();

        let all = store.local_proposals().unwrap();
        assert_eq!(all.len(), 2);
        let key_a = all.iter().find(|p| p.segment_key == "keyA").unwrap();
        assert_eq!(key_a.value, 70);

        store.remove_local_proposal("keyA").unwrap();
        assert_eq!(store.local_proposals().unwrap().len(), 1);
    }

    #[test]
    fn behaves_like_every_other_store() {
        crate::storage::contract::run(&|| Box::new(InMemoryStore::new()));
    }

    #[test]
    fn a_snapshot_round_trips_everything_a_binding_would_persist() {
        let store = InMemoryStore::new();
        store.set_cursor("node1", 42).unwrap();
        store.set_partition_hash("tileA", "hash1").unwrap();
        store
            .upsert_hazard_reports(&[sample_report("hr1")])
            .unwrap();
        store
            .upsert_static_data(&crate::storage::contract::sample_static_data())
            .unwrap();
        store
            .enqueue_write(&PendingWrite {
                id: "w1".to_string(),
                request_body: serde_json::json!({ "type": "ice" }),
                created_at_unix_ms: 1000,
                attempts: 0,
                kind: WriteKind::HazardReport,
            })
            .unwrap();
        store.upsert_local_proposal(&proposal("keyA", 30)).unwrap();
        store.set_static_partition_resolution(4).unwrap();

        let restored = InMemoryStore::from_snapshot(&store.to_snapshot().unwrap());

        assert_eq!(restored.get_cursor("node1").unwrap(), Some(42));
        assert_eq!(
            restored.get_partition_hash("tileA").unwrap(),
            Some("hash1".to_string())
        );
        assert_eq!(
            restored.all_entities().unwrap(),
            store.all_entities().unwrap()
        );
        assert_eq!(restored.pending_writes().unwrap().len(), 1);
        assert_eq!(restored.local_proposals().unwrap().len(), 1);
        assert_eq!(restored.static_partition_resolution().unwrap(), Some(4));
    }

    #[test]
    fn from_snapshot_treats_empty_or_garbage_as_a_fresh_store_not_an_error() {
        assert_eq!(
            InMemoryStore::from_snapshot("").all_entities().unwrap(),
            StoredEntities::default()
        );
        assert_eq!(
            InMemoryStore::from_snapshot("not json")
                .all_entities()
                .unwrap(),
            StoredEntities::default()
        );
    }

    #[test]
    fn a_store_with_a_limit_refuses_static_data_beyond_it_until_room_is_made() {
        let store = InMemoryStore::with_static_entity_limit(1);
        let data = crate::storage::contract::sample_static_data();

        let refused = store.upsert_static_data(&data).unwrap_err();

        assert!(crate::storage::is_storage_full(&refused));
        assert!(store
            .all_entities()
            .unwrap()
            .speed_limit_segments
            .is_empty());

        store.set_static_entity_limit(None);
        store.upsert_static_data(&data).unwrap();
        assert_eq!(store.all_entities().unwrap().speed_limit_segments.len(), 2);
    }

    #[test]
    fn pending_write_queue_is_idempotent_on_id() {
        let store = InMemoryStore::new();
        let item = PendingWrite {
            id: "w1".to_string(),
            request_body: serde_json::json!({ "type": "ice" }),
            created_at_unix_ms: 1000,
            attempts: 0,
            kind: WriteKind::HazardReport,
        };
        store.enqueue_write(&item).unwrap();
        let mut retried = item.clone();
        retried.attempts = 1;
        store.enqueue_write(&retried).unwrap();

        let pending = store.pending_writes().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].attempts, 1);

        store.remove_pending_write("w1").unwrap();
        assert!(store.pending_writes().unwrap().is_empty());
    }
}
