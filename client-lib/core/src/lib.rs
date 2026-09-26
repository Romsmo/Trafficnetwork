//! `trafficnetwork-core` — the platform-independent core of the
//! Trafficnetwork client-sync library. See `client-lib/README.md` and the
//! F-C0 plan for the module layout. `crypto` (F-C1), `platform` and
//! `discovery` (F-C2), `storage`/`sync` (F-C3), `status` (add-on O) exist so far.

pub mod crypto;
pub mod discovery;
pub mod platform;
pub mod status;
pub mod storage;
pub mod sync;
