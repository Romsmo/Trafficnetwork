# Integration guide — iOS and macOS (Swift)

The same client every binding exposes (`api.md` describes every method), as a
Swift package: the Swift that UniFFI generates from the Rust code, on top of the
native library packaged as an XCFramework (iOS devices, the iOS simulator on
Apple silicon and Intel, macOS on both). There is no hand-written layer that
could drift: a method name, an argument shape or an error is what `api.md`
says, as in every other binding.

**What you need:** a Mac with Xcode (Swift 5.9 or newer) and a Rust toolchain
with the Apple targets (`rustup target add aarch64-apple-ios
aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-darwin
x86_64-apple-darwin`). Nothing is published yet — you build the package from
this repository. The CI job `swift-package` does exactly these steps on a
macOS runner and attaches the result to the run.

## Build the package

All paths are relative to `client-lib/`.

```bash
bash bindings/swift/build-xcframework.sh
```

That builds the native library for the five Apple targets, joins them into
`bindings/swift/TrafficNetworkFFI.xcframework`, and generates the Swift wrapper
into `bindings/swift/Sources/TrafficNetwork/`. Neither is checked in — both come
out of the Rust code. `bindings/swift/` is now a complete Swift package
(`Package.swift`, one library product `TrafficNetwork`).

## Use it in your app

In Xcode: *File → Add Package Dependencies… → Add Local…* and choose
`client-lib/bindings/swift`; add the `TrafficNetwork` library to your app
target. Or, in another package's `Package.swift`:

```swift
dependencies: [.package(path: "../Trafficnetwork/client-lib/bindings/swift")],
targets: [.target(name: "MyApp", dependencies: [.product(name: "TrafficNetwork", package: "swift")])]
```

The XCFramework's module map links `Security`, `SystemConfiguration` and
`CoreFoundation` for you.

## The smallest possible use

```swift
import Foundation
import TrafficNetwork

let storage = FileManager.default
    .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("trafficnetwork").path        // database + secrets live here

let options: [String: Any] = [
    "storagePath": storage,
    "discovery": false,
    "nodes": ["https://node.example.org"],
    "credentials": ["type": "client", "clientId": "…", "clientSecret": "…"],
]
let json = String(data: try JSONSerialization.data(withJSONObject: options), encoding: .utf8)!
let client = try TrafficNetworkClient(optionsJson: json, secureStore: nil)

// Every call is  call(method:argsJson:) -> resultJson,  {"ok": …} or {"error": …}.
// Calls that reach the network block until done: run them off the main thread
// (or use `await client.callAsync(...)`).
let here = #"{"lat": 52.52, "lng": 13.405}"#
_ = client.call(method: "updatePosition", argsJson: here)   // which map tiles to watch
print(client.call(method: "sync", argsJson: "{}"))          // fetch what is around
print(client.call(method: "getSpeedLimitAt", argsJson: here)) // local, instant
print(client.call(method: "getNearby",
                  argsJson: #"{"lat": 52.52, "lng": 13.405, "radiusMeters": 2000}"#)) // local, instant
```

In a SwiftUI app the same calls go inside `Task { … }`, using `callAsync` so
nothing blocks:

```swift
let result = await client.callAsync(method: "sync", argsJson: "{}")
```

`bindings/swift/example/` is this as a complete command-line program (what the
guide's example and the CI run use); build and run it with
`TN_NODE=… TN_CLIENT_ID=… TN_CLIENT_SECRET=… swift run` in that directory.

Things an app usually wants on top of that:

- **Errors:** `call` never throws for an ordinary failure; it returns
  `{"error": {"code", "message"}}` with one of the API's codes (`api.md`,
  "Errors"). Only `TrafficNetworkClient(...)` can throw —
  `ClientError.Failed(errorCode:detail:)` for options it cannot use.
- **Keep it fresh:** call `tick` from a timer or a background task; it is
  cheap and syncs only when due. Nothing runs by itself.
- **Live updates:** `client.startRealtime()` keeps a WebSocket open on the
  library's own background task; `client.setEventListener(listener:)` (an
  object conforming to `EventListener`, `onEvent(eventJson:)`) tells you when
  data changed — it is called from a library thread, so hand over to the main
  actor yourself. The protocol is `Sendable`, so your class must be too.
- **The Keychain:** pass an object conforming to `SecureStore` —
  `get(key:)`, `set(key:value:)`, `delete(key:)` — as `secureStore:` and the
  device's credential and signing key go there instead of into a file in
  `storagePath`. It may be called from any thread.
- **Finish:** let the last reference go (or set your variable to `nil`); the
  data stays on disk.

## How it behaves

- **Calls run on the library's own threads** (8 MiB stacks), never on yours —
  the calling thread only waits.
- **A crash never reaches you as one:** a panic inside the library becomes an
  `internal` error result; a `SecureStore` or listener of yours that throws
  answers "not there"/"refused" (store) or is ignored (listener).
- **TLS** trusts the Mozilla root certificates bundled in the library, not the
  system keychain's: every platform behaves the same. A server whose
  certificate chains to a private authority is not trusted — see `api.md`,
  "Network & privacy".
- **Storage** is SQLite in your app's container (with a spatial index),
  written synchronously — the same store as every desktop build.
- **App Transport Security:** use `https://` servers; plain `http://` needs
  an ATS exception in your app, as for any other networking code.

## Verified in CI

On a macOS runner (`swift-package`):

- the five Rust targets build and the XCFramework is assembled;
- the package builds with `swift build` (macOS) and with `xcodebuild` for
  **iOS (device)** and **iOS Simulator**;
- `conformance/scenarios.json` — the same scenarios, with the same
  expectations, as the Python, Node.js, browser and Kotlin runs — runs through
  the generated Swift on macOS, twice: once with the secrets in the library's
  file, once with them in a `SecureStore` implemented in Swift (the library
  calling back into Swift, which is what a Keychain binding rests on);
- the example above runs against the scripted server and its output is checked.

**Not verified in CI, said plainly:** nothing runs *inside an iOS simulator or
on a device*. The iOS slices are built and linked, and it is the same Rust
library and the same generated Swift that run on macOS in the conformance
test; what differs on an iPhone is the CPU slice, iOS's own system libraries,
and App Sandbox and background-execution rules, which no CI job here
exercises. If something behaves differently on a device, that is a bug to
report. The XCFramework is also not code-signed or notarized; sign it as part
of your own app's build.
