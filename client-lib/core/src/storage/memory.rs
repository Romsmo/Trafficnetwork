//! Reference [`super::Store`] implementation — plain in-memory maps behind a
//! `Mutex`, no persistence across process restarts. Used by every test in
//! this crate that needs a `Store`; a host app that hasn't wired up a real
//! embedded database yet can also use it directly (it just won't survive a
//! restart).

use std::collections::HashMap;
use std::sync::Mutex;

use super::{PendingWrite, Store, StoreError, StoredEntities};
use crate::sync::types::HazardReport;

#[derive(Default)]
struct Inner {
    cursors: HashMap<String, u64>,
    partition_hashes: HashMap<String, String>,
    entities: StoredEntities,
    pending_writes: Vec<PendingWrite>,
}

#[derive(Default)]
pub struct InMemoryStore {
    inner: Mutex<Inner>,
}

impl InMemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
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
        Ok(())
    }

    fn upsert_static_data(&self, data: &StoredEntities) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::types::{Geometry, HazardType};

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
        store.upsert_hazard_reports(&[sample_report("hr1")]).unwrap();
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
        store.upsert_hazard_reports(&[sample_report("hr1"), sample_report("hr2")]).unwrap();
        store.remove_hazard_report("hr1").unwrap();
        let all = store.all_entities().unwrap();
        assert_eq!(all.hazard_reports.len(), 1);
        assert_eq!(all.hazard_reports[0].id, "hr2");
    }

    #[test]
    fn clear_static_data_leaves_hazard_reports_untouched() {
        let store = InMemoryStore::new();
        store.upsert_hazard_reports(&[sample_report("hr1")]).unwrap();
        store.set_partition_hash("tileA", "hash1").unwrap();
        store.clear_static_data().unwrap();

        assert_eq!(store.all_entities().unwrap().hazard_reports.len(), 1);
        assert_eq!(store.get_partition_hash("tileA").unwrap(), None);
    }

    #[test]
    fn pending_write_queue_is_idempotent_on_id() {
        let store = InMemoryStore::new();
        let item = PendingWrite {
            id: "w1".to_string(),
            request_body: serde_json::json!({ "type": "ice" }),
            created_at_unix_ms: 1000,
            attempts: 0,
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
