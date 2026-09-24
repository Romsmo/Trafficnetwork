//! One behavioural contract every [`Store`] implementation has to meet —
//! `InMemoryStore` and `SqliteStore` both run it, so the persistent store the
//! measurements rely on is held to exactly what the engine tests assume.

use super::{
    LocalCorrectionProposal, PendingWrite, ProposalState, Store, StoredEntities, WriteKind,
};
use crate::sync::types::{
    CorrectionReason, Geometry, HazardReport, HazardType, SegmentCorrection, SpeedLimitSegment,
    SpeedLimitUnit, StaticSign,
};

/// The double nearest to the 7-decimal number closest to `x` — what any
/// store that keeps coordinates as 1e-7° integers hands back, and what
/// parsing such a decimal from JSON yields. Test vertices are built from it,
/// so "the store returned what was put in" is exact for every store.
fn round7(x: f64) -> f64 {
    (x * 1e7).round() / 1e7
}

pub(crate) fn segment(id: &str, key: &str, lng: f64, lat: f64) -> SpeedLimitSegment {
    SpeedLimitSegment {
        id: id.to_string(),
        geometry: Geometry::LineString {
            coordinates: vec![
                [round7(lng), round7(lat)],
                [round7(lng + 0.01), round7(lat + 0.0025)],
            ],
        },
        speed_limit: 50.0,
        speed_limit_unit: "kmh".to_string(),
        source: "osm".to_string(),
        source_license: Some("ODbL".to_string()),
        imported_at: "2026-01-01T00:00:00Z".to_string(),
        last_confirmed_at: None,
        segment_key: Some(key.to_string()),
        corrected_by: None,
        imported_speed_limit: None,
        correction: None,
    }
}

fn sign(id: &str) -> StaticSign {
    StaticSign {
        id: id.to_string(),
        position: Geometry::Point {
            coordinates: [13.4, 52.5],
        },
        sign_type: "DE:274".to_string(),
        source: "osm".to_string(),
        source_license: None,
        imported_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

fn report(id: &str) -> HazardReport {
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

pub(crate) fn sample_static_data() -> StoredEntities {
    StoredEntities {
        speed_limit_segments: vec![
            segment("s1", "k1", 13.0, 52.0),
            segment("s2", "k2", 11.5, 48.1),
        ],
        static_signs: vec![sign("sg1")],
        ..Default::default()
    }
}

fn write(id: &str) -> PendingWrite {
    PendingWrite {
        id: id.to_string(),
        request_body: serde_json::json!({ "n": id }),
        created_at_unix_ms: 1000,
        attempts: 0,
        kind: WriteKind::HazardReport,
    }
}

fn proposal(key: &str, value: u32) -> LocalCorrectionProposal {
    LocalCorrectionProposal {
        segment_key: key.to_string(),
        segment_id: "s1".to_string(),
        value,
        unit: SpeedLimitUnit::Kmh,
        reason: Some(CorrectionReason::WrongValue),
        state: ProposalState::Queued,
        correction_id: None,
        confirmations: 0,
        proposed_at_unix_ms: 1000,
    }
}

fn ids(segments: &[SpeedLimitSegment]) -> Vec<String> {
    let mut ids: Vec<String> = segments.iter().map(|s| s.id.clone()).collect();
    ids.sort();
    ids
}

pub(crate) fn run(make: &dyn Fn() -> Box<dyn Store>) {
    cursors_are_kept_per_node(make().as_ref());
    a_partition_and_its_hash_arrive_together(make().as_ref());
    static_data_is_replaced_by_id_never_duplicated(make().as_ref());
    static_entities_can_be_removed_individually(make().as_ref());
    clearing_static_data_leaves_reports_alone(make().as_ref());
    hazard_reports_are_stored_and_removed(make().as_ref());
    the_write_queue_is_idempotent_on_id_and_keeps_order(make().as_ref());
    a_local_proposal_is_kept_per_segment_key(make().as_ref());
    correction_fields_and_geometry_survive_storage(make().as_ref());
    a_position_lookup_finds_the_nearby_segments_only(make().as_ref());
    a_segment_can_be_fetched_by_id(make().as_ref());
}

fn cursors_are_kept_per_node(store: &dyn Store) {
    assert_eq!(store.get_cursor("node1").unwrap(), None);
    store.set_cursor("node1", 42).unwrap();
    store.set_cursor("node2", 7).unwrap();
    store.set_cursor("node1", 43).unwrap();
    assert_eq!(store.get_cursor("node1").unwrap(), Some(43));
    assert_eq!(store.get_cursor("node2").unwrap(), Some(7));
}

fn a_partition_and_its_hash_arrive_together(store: &dyn Store) {
    assert_eq!(store.get_partition_hash("tileA").unwrap(), None);
    store
        .upsert_static_partition("tileA", "hash-1", &sample_static_data())
        .unwrap();
    assert_eq!(
        store.get_partition_hash("tileA").unwrap().as_deref(),
        Some("hash-1")
    );
    let all = store.all_entities().unwrap();
    assert_eq!(all.speed_limit_segments.len(), 2);
    assert_eq!(all.static_signs.len(), 1);
}

fn static_data_is_replaced_by_id_never_duplicated(store: &dyn Store) {
    store.upsert_static_data(&sample_static_data()).unwrap();
    let mut changed = sample_static_data();
    changed.speed_limit_segments[0].speed_limit = 30.0;
    store.upsert_static_data(&changed).unwrap();

    let all = store.all_entities().unwrap();
    assert_eq!(all.speed_limit_segments.len(), 2);
    let s1 = all
        .speed_limit_segments
        .iter()
        .find(|s| s.id == "s1")
        .unwrap();
    assert_eq!(s1.speed_limit, 30.0);
    assert_eq!(all.static_signs.len(), 1);
}

fn static_entities_can_be_removed_individually(store: &dyn Store) {
    store.upsert_static_data(&sample_static_data()).unwrap();
    store.remove_static_entity("speedLimitSegment", "s1").unwrap();
    store.remove_static_entity("staticSign", "sg1").unwrap();
    store.remove_static_entity("fixedSpeedCamera", "none").unwrap();
    store.remove_static_entity("somethingElse", "x").unwrap();

    let all = store.all_entities().unwrap();
    assert_eq!(ids(&all.speed_limit_segments), vec!["s2".to_string()]);
    assert!(all.static_signs.is_empty());
    // A removed segment is gone from the spatial index too.
    let near = store.speed_limit_segments_near(52.0, 13.005, 100.0).unwrap();
    assert!(near.is_empty());
}

fn clearing_static_data_leaves_reports_alone(store: &dyn Store) {
    store
        .upsert_static_partition("tileA", "hash-1", &sample_static_data())
        .unwrap();
    store.upsert_hazard_reports(&[report("hr1")]).unwrap();
    store.clear_static_data().unwrap();

    let all = store.all_entities().unwrap();
    assert!(all.speed_limit_segments.is_empty());
    assert!(all.static_signs.is_empty());
    assert_eq!(all.hazard_reports.len(), 1);
    assert_eq!(store.get_partition_hash("tileA").unwrap(), None);
}

fn hazard_reports_are_stored_and_removed(store: &dyn Store) {
    store
        .upsert_hazard_reports(&[report("hr1"), report("hr2")])
        .unwrap();
    let mut updated = report("hr1");
    updated.confirm_count = 3;
    store.upsert_hazard_reports(&[updated]).unwrap();
    store.remove_hazard_report("hr2").unwrap();

    let all = store.all_entities().unwrap();
    assert_eq!(all.hazard_reports.len(), 1);
    assert_eq!(all.hazard_reports[0].confirm_count, 3);
}

fn the_write_queue_is_idempotent_on_id_and_keeps_order(store: &dyn Store) {
    store.enqueue_write(&write("a")).unwrap();
    store.enqueue_write(&write("b")).unwrap();
    let mut again = write("a");
    again.attempts = 1;
    store.enqueue_write(&again).unwrap();

    let pending = store.pending_writes().unwrap();
    let order: Vec<&str> = pending.iter().map(|w| w.id.as_str()).collect();
    assert_eq!(order, vec!["b", "a"]);
    assert_eq!(pending[1].attempts, 1);

    store.remove_pending_write("b").unwrap();
    assert_eq!(store.pending_writes().unwrap().len(), 1);
}

fn a_local_proposal_is_kept_per_segment_key(store: &dyn Store) {
    store.upsert_local_proposal(&proposal("k1", 30)).unwrap();
    store.upsert_local_proposal(&proposal("k2", 50)).unwrap();
    store.upsert_local_proposal(&proposal("k1", 70)).unwrap();

    let all = store.local_proposals().unwrap();
    assert_eq!(all.len(), 2);
    let k1 = all.iter().find(|p| p.segment_key == "k1").unwrap();
    assert_eq!(k1.value, 70);
    assert_eq!(k1.reason, Some(CorrectionReason::WrongValue));

    store.remove_local_proposal("k1").unwrap();
    assert_eq!(store.local_proposals().unwrap().len(), 1);
}

fn correction_fields_and_geometry_survive_storage(store: &dyn Store) {
    let mut corrected = segment("s9", "k9", 11.5754321, 48.1372345);
    corrected.speed_limit = 30.0;
    corrected.corrected_by = Some("community".to_string());
    corrected.imported_speed_limit = Some(50.0);
    corrected.correction = Some(SegmentCorrection {
        id: "c1".to_string(),
        confirmations: 3,
        denials: 1,
        applied_at: Some("2026-09-24T12:00:00.000Z".to_string()),
        needs_review: true,
    });
    let data = StoredEntities {
        speed_limit_segments: vec![corrected.clone()],
        ..Default::default()
    };
    store.upsert_static_data(&data).unwrap();

    let all = store.all_entities().unwrap();
    assert_eq!(all.speed_limit_segments, vec![corrected]);
}

fn a_position_lookup_finds_the_nearby_segments_only(store: &dyn Store) {
    store.upsert_static_data(&sample_static_data()).unwrap();
    store
        .upsert_static_data(&StoredEntities {
            speed_limit_segments: vec![segment("s3", "k3", 0.0, 0.0)],
            ..Default::default()
        })
        .unwrap();

    let munich = store.speed_limit_segments_near(48.1, 11.505, 100.0).unwrap();
    assert!(ids(&munich).contains(&"s2".to_string()));
    assert!(!ids(&munich).contains(&"s1".to_string()));
    assert!(!ids(&munich).contains(&"s3".to_string()));

    let nowhere = store.speed_limit_segments_near(60.0, 30.0, 100.0).unwrap();
    assert!(nowhere.is_empty());
}

fn a_segment_can_be_fetched_by_id(store: &dyn Store) {
    store.upsert_static_data(&sample_static_data()).unwrap();

    let found = store.speed_limit_segment("s2").unwrap();
    assert_eq!(found, Some(segment("s2", "k2", 11.5, 48.1)));
    assert_eq!(store.speed_limit_segment("nope").unwrap(), None);
}
