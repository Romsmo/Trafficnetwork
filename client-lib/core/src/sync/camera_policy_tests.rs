use serde_json::{json, Value};

use super::*;
use crate::crypto::{
    generate_ed25519_keypair, sign_envelope, verify_signed_envelope, SignedEnvelope,
};
use crate::storage::{InMemoryStore, Store, StoredEntities};
use crate::sync::types::{FixedSpeedCamera, HazardReport};

fn config(speed_camera_namespace: bool, policy: Option<Value>) -> ClientConfig {
    let mut value = json!({
        "regionTileH3Resolution": 7,
        "staticDataPartitionH3Resolution": 4,
        "speedCameraNamespaceEnabled": speed_camera_namespace,
        "cameraNamespaceHazardTypes": ["mobileSpeedCamera"],
        "duplicateMergeRadiusMeters": 100,
        "speedLimitLookupMaxDistanceMeters": 50,
        "hazardExpiryMsByType": {},
        "reportRateLimitMax": 10,
        "reportRateLimitWindowMinutes": 10,
        "cameraRemovalThreshold": 3,
        "staticDataVersion": 7,
        "federationEnabled": false,
        "networkConfig": null
    });
    if let Some(policy) = policy {
        value["cameraPolicy"] = policy;
    }
    serde_json::from_value(value).unwrap()
}

fn policy_json(enabled: bool, default_level: &str, by_country: Value) -> Value {
    json!({
        "version": "v1",
        "namespaceEnabled": enabled,
        "defaultLevel": default_level,
        "byCountry": by_country,
        "zoneResolution": 6,
        "notice": { "version": 2, "text": { "de": "Hinweis", "en": "Notice" } }
    })
}

fn network(blitzer_enabled: bool, levels: Option<Value>) -> NetworkConfigPayload {
    NetworkConfigPayload {
        version: 3,
        blitzer_enabled,
        event_log_retention_days_dynamic: 7,
        event_log_retention_days_static: 30,
        min_version: "0.1.0".to_string(),
        excluded_node_ids: vec![],
        directory_key_id: None,
        import_key_id: None,
        issued_at: "2027-01-01T00:00:00Z".to_string(),
        camera_policy_by_country: levels.map(|v| serde_json::from_value(v).unwrap()),
        raw: None,
    }
}

#[test]
fn levels_are_ordered_and_anything_unknown_is_off() {
    assert!(CameraLevel::Off < CameraLevel::Zones);
    assert!(CameraLevel::Zones < CameraLevel::Full);
    assert_eq!(CameraLevel::from_wire("full"), CameraLevel::Full);
    assert_eq!(CameraLevel::from_wire(" Zones "), CameraLevel::Zones);
    assert_eq!(CameraLevel::from_wire("off"), CameraLevel::Off);
    assert_eq!(CameraLevel::from_wire(""), CameraLevel::Off);
    assert_eq!(CameraLevel::from_wire("everything"), CameraLevel::Off);
}

#[test]
fn a_server_without_the_country_policy_has_one_switch_for_everything() {
    let on = effective_camera_policy(&config(true, None), None);
    assert_eq!(on, EffectiveCameraPolicy::unrestricted());
    assert_eq!(on.max_level(), CameraLevel::Full);
    let off = effective_camera_policy(&config(false, None), None);
    assert_eq!(off, EffectiveCameraPolicy::off());
    assert_eq!(off.max_level(), CameraLevel::Off);
    // …and a verified network configuration can still switch it off.
    let braked = effective_camera_policy(&config(true, None), Some(&network(false, None)));
    assert_eq!(braked.max_level(), CameraLevel::Off);
}

#[test]
fn the_policy_reads_the_node_levels_and_the_brakes_turn_everything_off() {
    let levels = json!({ "DE": "full", "FR": "zones", "CH": "off" });
    let policy = effective_camera_policy(
        &config(true, Some(policy_json(true, "off", levels.clone()))),
        None,
    );
    assert!(policy.enabled);
    assert_eq!(policy.level_of("de"), CameraLevel::Full);
    assert_eq!(policy.level_of("FR"), CameraLevel::Zones);
    assert_eq!(policy.level_of("CH"), CameraLevel::Off);
    assert_eq!(
        policy.level_of("AT"),
        CameraLevel::Off,
        "the default applies"
    );
    assert_eq!(policy.max_level(), CameraLevel::Full);

    // The node's own brake…
    let node_brake = effective_camera_policy(
        &config(true, Some(policy_json(false, "full", levels.clone()))),
        None,
    );
    assert_eq!(node_brake, EffectiveCameraPolicy::off());
    // …the flag the old clients read…
    let flag_off = effective_camera_policy(
        &config(false, Some(policy_json(true, "full", levels.clone()))),
        None,
    );
    assert_eq!(flag_off, EffectiveCameraPolicy::off());
    // …and the network's.
    let network_brake = effective_camera_policy(
        &config(true, Some(policy_json(true, "full", levels))),
        Some(&network(false, None)),
    );
    assert_eq!(network_brake, EffectiveCameraPolicy::off());
}

#[test]
fn a_default_level_other_than_off_covers_every_country_not_listed() {
    let policy = effective_camera_policy(
        &config(
            true,
            Some(policy_json(true, "full", json!({ "CH": "off" }))),
        ),
        None,
    );
    assert_eq!(policy.level_of("DE"), CameraLevel::Full);
    assert_eq!(policy.level_of("CH"), CameraLevel::Off);
    assert_eq!(policy.max_level(), CameraLevel::Full);
}

#[test]
fn a_malformed_or_unknown_policy_never_opens_anything() {
    // An object of the wrong shape is read as absent: the single switch.
    let mut value = serde_json::to_value(config(false, None)).unwrap();
    value["cameraPolicy"] = json!("nonsense");
    let parsed: ClientConfig = serde_json::from_value(value).unwrap();
    assert_eq!(parsed.camera_policy, None);
    assert_eq!(
        effective_camera_policy(&parsed, None).max_level(),
        CameraLevel::Off
    );

    // An empty object keeps every field at its strictest reading.
    let empty = effective_camera_policy(&config(true, Some(json!({}))), None);
    assert_eq!(empty, EffectiveCameraPolicy::off());

    // A level a newer server invented is off.
    let invented = effective_camera_policy(
        &config(
            true,
            Some(policy_json(true, "off", json!({ "DE": "everything" }))),
        ),
        None,
    );
    assert_eq!(invented.level_of("DE"), CameraLevel::Off);
}

#[test]
fn the_signed_network_policy_can_only_tighten_what_the_node_claims() {
    let node = policy_json(true, "full", json!({ "FR": "zones" }));
    let signed = network(
        true,
        Some(json!({ "CH": "off", "FR": "full", "DE": "zones" })),
    );
    let policy = effective_camera_policy(&config(true, Some(node)), Some(&signed));
    assert_eq!(
        policy.level_of("CH"),
        CameraLevel::Off,
        "the network lists it, the node does not"
    );
    assert_eq!(
        policy.level_of("FR"),
        CameraLevel::Zones,
        "the node is stricter than the network"
    );
    assert_eq!(
        policy.level_of("DE"),
        CameraLevel::Zones,
        "the network is stricter than the node"
    );
    assert_eq!(
        policy.level_of("AT"),
        CameraLevel::Full,
        "nobody restricts it"
    );
}

#[test]
fn stricter_means_any_country_or_the_default_lets_less_through() {
    let full = EffectiveCameraPolicy::unrestricted();
    assert!(!full.is_stricter_than(&full));
    assert!(EffectiveCameraPolicy::off().is_stricter_than(&full));
    assert!(!full.is_stricter_than(&EffectiveCameraPolicy::off()));

    let mut one_country_off = full.clone();
    one_country_off
        .by_country
        .insert("CH".to_string(), CameraLevel::Off);
    assert!(one_country_off.is_stricter_than(&full));
    assert!(!full.is_stricter_than(&one_country_off));

    let mut zones_everywhere = full.clone();
    zones_everywhere.default_level = CameraLevel::Zones;
    assert!(zones_everywhere.is_stricter_than(&full));

    // Looser in one place and stricter in another is stricter — both ways.
    let mut only_germany = EffectiveCameraPolicy::unrestricted();
    only_germany.default_level = CameraLevel::Off;
    only_germany
        .by_country
        .insert("DE".to_string(), CameraLevel::Full);
    let mut everywhere_but_germany = EffectiveCameraPolicy::unrestricted();
    everywhere_but_germany
        .by_country
        .insert("DE".to_string(), CameraLevel::Off);
    assert!(only_germany.is_stricter_than(&everywhere_but_germany));
    assert!(everywhere_but_germany.is_stricter_than(&only_germany));
}

#[test]
fn a_payload_keeps_what_was_signed_whatever_this_build_knows() {
    // A signer that left out `directoryKeyId`/`importKeyId`, and a field this
    // build has never heard of: the signature is over this JSON, so verifying
    // it must not depend on what the struct can hold.
    let root = generate_ed25519_keypair().unwrap();
    let signed_json = json!({
        "version": 4,
        "blitzerEnabled": true,
        "cameraPolicyByCountry": { "CH": "off", "FR": "zones" },
        "somethingNew": { "nested": [1, 2, 3] },
        "eventLogRetentionDaysDynamic": 3,
        "eventLogRetentionDaysStatic": 30,
        "minVersion": "0.1.0",
        "excludedNodeIds": [],
        "issuedAt": "2027-01-01T00:00:00Z"
    });
    let envelope = sign_envelope(signed_json, &root).unwrap();
    let wire = serde_json::to_value(&envelope).unwrap();

    let received: SignedEnvelope<NetworkConfigPayload> = serde_json::from_value(wire).unwrap();
    assert!(verify_signed_envelope(&received, &root.public_key_raw));
    let levels = received.payload.camera_policy_by_country.clone().unwrap();
    assert_eq!(levels.get("CH").map(String::as_str), Some("off"));
    assert_eq!(levels.get("FR").map(String::as_str), Some("zones"));

    // Somebody else's key does not verify it.
    let impostor = generate_ed25519_keypair().unwrap();
    assert!(!verify_signed_envelope(&received, &impostor.public_key_raw));

    // A payload built in code still signs and verifies as before.
    let built = sign_envelope(network(true, Some(json!({ "DE": "full" }))), &root).unwrap();
    let round_trip: SignedEnvelope<NetworkConfigPayload> =
        serde_json::from_value(serde_json::to_value(&built).unwrap()).unwrap();
    assert!(verify_signed_envelope(&round_trip, &root.public_key_raw));
    assert_eq!(round_trip.payload, built.payload);
}

fn square_zone(id: &str, lat: f64, lng: f64, half: f64, kinds: &[&str]) -> CameraZone {
    serde_json::from_value(json!({
        "id": id,
        "cell": "861f1d48fffffff",
        "resolution": 6,
        "boundary": { "type": "Polygon", "coordinates": [[
            [lng - half, lat - half], [lng + half, lat - half],
            [lng + half, lat + half], [lng - half, lat + half],
            [lng - half, lat - half]
        ]] },
        "cameraTypes": kinds,
        "status": "active"
    }))
    .unwrap()
}

#[test]
fn a_zone_is_distance_zero_inside_and_measured_to_its_edge_outside() {
    let zone = square_zone("z1", 52.0, 13.0, 0.01, &["fixedSpeedCamera"]);
    assert_eq!(zone.distance_meters(52.0, 13.0), 0.0);
    assert_eq!(zone.distance_meters(52.009, 13.009), 0.0);

    // 0.01 degrees of latitude north of the northern edge (52.01): ~1113 m.
    let north = zone.distance_meters(52.02, 13.0);
    assert!((north - 1113.0).abs() < 25.0, "{north}");
    // A point east of the eastern edge, at the zone's latitude.
    let east = zone.distance_meters(52.0, 13.02);
    let expected_east = 0.01 * 111_320.0 * 52.0_f64.to_radians().cos();
    assert!(
        (east - expected_east).abs() < 25.0,
        "{east} vs {expected_east}"
    );
    // Far away is far away.
    assert!(zone.distance_meters(48.0, 11.0) > 100_000.0);
}

#[test]
fn a_zone_without_an_outline_is_never_near() {
    let mut zone = square_zone("z1", 52.0, 13.0, 0.01, &[]);
    zone.boundary.coordinates.clear();
    assert!(zone.distance_meters(52.0, 13.0).is_infinite());
    zone.boundary.coordinates = vec![vec![[13.0, 52.0], [13.1, 52.0]]];
    assert!(zone.distance_meters(52.0, 13.0).is_infinite());
}

#[test]
fn zones_are_united_by_camera_kind_and_keep_the_newer_outline() {
    let stored = square_zone(
        "z1",
        52.0,
        13.0,
        0.01,
        &["fixedSpeedCamera", "redLightCamera"],
    );
    let incoming = square_zone(
        "z1",
        52.0,
        13.0,
        0.02,
        &["mobileSpeedCamera", "fixedSpeedCamera"],
    );
    let united = stored.united_with(&incoming);
    assert_eq!(
        united.camera_types,
        vec!["fixedSpeedCamera", "mobileSpeedCamera", "redLightCamera"]
    );
    assert_eq!(united.boundary, incoming.boundary);
}

#[test]
fn a_zone_carries_nothing_about_a_single_camera() {
    // The wire item of a zone has no position, id of a camera, count or time —
    // and nothing here invents one.
    let zone = square_zone("z1", 52.0, 13.0, 0.01, &["fixedSpeedCamera"]);
    let value = serde_json::to_value(&zone).unwrap();
    let keys: Vec<&str> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    for forbidden in [
        "position",
        "lat",
        "lng",
        "latitude",
        "longitude",
        "count",
        "reportedAt",
        "importedAt",
    ] {
        assert!(!keys.contains(&forbidden), "{forbidden} in {keys:?}");
    }
}

fn camera_json(id: &str, lat: f64, lng: f64) -> FixedSpeedCamera {
    serde_json::from_value(json!({
        "id": id, "type": "fixedSpeedCamera",
        "position": { "type": "Point", "coordinates": [lng, lat] },
        "status": "active", "removedAt": null, "source": "osm", "sourceLicense": null,
        "importedAt": "2027-01-01T00:00:00Z", "lastConfirmedAt": null, "removalReportCount": 0
    }))
    .unwrap()
}

fn report_json(id: &str, kind: &str) -> HazardReport {
    serde_json::from_value(json!({
        "id": id, "type": kind,
        "position": { "type": "Point", "coordinates": [13.0, 52.0] },
        "regionTile": "871f1d489ffffff",
        "reportedAt": "2027-01-01T00:00:00.000Z", "reporterId": "someone", "speedKmh": null,
        "expiresAt": "2099-01-01T00:00:00.000Z",
        "status": "active", "source": "community", "sourceLicense": null,
        "confirmCount": 0, "denyCount": 0
    }))
    .unwrap()
}

#[test]
fn purging_removes_every_camera_and_has_the_packages_that_held_them_fetched_again() {
    let store = InMemoryStore::new();
    store.set_static_partition_resolution(4).unwrap();
    // A camera near Berlin, a zone near Munich: two different packages.
    let camera_tile = tile_of_position(52.0, 13.0, 4).unwrap();
    let mut zone = square_zone("z1", 48.1, 11.5, 0.01, &["fixedSpeedCamera"]);
    zone.cell = tile_of_position(48.1, 11.5, 6).unwrap();
    let zone_tile = parent_tile_of_cell(&zone.cell, 4).unwrap();
    assert_ne!(camera_tile, zone_tile);
    store
        .upsert_static_data(&StoredEntities {
            fixed_speed_cameras: vec![camera_json("c1", 52.0, 13.0)],
            camera_zones: vec![zone],
            ..Default::default()
        })
        .unwrap();
    store
        .upsert_hazard_reports(&[
            report_json("r-cam", "mobileSpeedCamera"),
            report_json("r-ice", "ice"),
        ])
        .unwrap();
    store.set_partition_hash(&camera_tile, "hash-a").unwrap();
    store.set_partition_hash(&zone_tile, "hash-b").unwrap();
    store
        .set_partition_hash("tile-without-cameras", "hash-c")
        .unwrap();

    let removed = purge_camera_data(&store, &[HazardType::MobileSpeedCamera]).unwrap();

    assert_eq!(removed, 3);
    assert!(store.fixed_speed_cameras().unwrap().is_empty());
    assert!(store.camera_zones().unwrap().is_empty());
    let reports = store.hazard_reports().unwrap();
    assert_eq!(reports.len(), 1, "only the report of a camera type goes");
    assert_eq!(reports[0].id, "r-ice");
    assert_eq!(
        store.get_partition_hash(&camera_tile).unwrap().as_deref(),
        Some("")
    );
    assert_eq!(
        store.get_partition_hash(&zone_tile).unwrap().as_deref(),
        Some("")
    );
    assert_eq!(
        store
            .get_partition_hash("tile-without-cameras")
            .unwrap()
            .as_deref(),
        Some("hash-c"),
        "a package without cameras is not fetched again"
    );
}

#[test]
fn the_built_in_notice_has_both_languages_and_names_the_special_cases() {
    let notice = CameraNotice::built_in();
    let de = notice.text.get("de").unwrap();
    let en = notice.text.get("en").unwrap();
    assert!(de.contains("Beifahrer") && de.contains("Schweiz"));
    assert!(en.contains("passengers") && en.contains("Switzerland"));
}
