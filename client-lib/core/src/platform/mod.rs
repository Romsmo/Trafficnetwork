//! Host-app-supplied seams (F-C0 plan §2 architecture): the core never talks
//! to the network or the system clock directly on its own initiative — it
//! calls through these traits, which a host app can override (a custom
//! network stack/proxy, a platform-specific secure keystore, injected time
//! for tests) or leave at the provided defaults. No background scheduling
//! lives here either — `sync()`/`tick()` (added in F-C3) are always called
//! *by* the host app, never self-scheduled.

pub mod clock;
pub mod http;
pub mod ws;

pub use clock::Clock;
#[cfg(not(target_arch = "wasm32"))]
pub use clock::SystemClock;
pub use http::{
    HttpError, HttpMethod, HttpRequest, HttpResponse, HttpTransport, ReqwestHttpTransport,
};
pub use ws::{WsConnection, WsError, WsTransport};
