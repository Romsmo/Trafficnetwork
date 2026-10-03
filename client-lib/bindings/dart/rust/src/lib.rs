//! The client API for Dart and Flutter (add-on B4), through
//! `flutter_rust_bridge`. [`api::client`] is the whole surface — the same
//! `call(method, argsJson) -> resultJson` the C ABI, the Kotlin and Swift
//! bindings and the browser one have, so `client-lib/docs/api.md` and
//! `client-lib/conformance/scenarios.json` apply here unchanged. The Dart
//! half is generated from it; `lib/trafficnetwork.dart` adds only typed
//! convenience on top.

pub mod api;
mod frb_generated;
