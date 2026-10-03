# Integration guide — Dart and Flutter

The same client every binding exposes (`api.md` describes every method), as a
Dart package with a typed API over the native library, bridged with
[`flutter_rust_bridge`](https://cjycode.com/flutter_rust_bridge/). Everything
that matters happens in the Rust core; the Dart code adds only typed
convenience over its one `call(method, argsJson)` — JSON in and out, errors as
`TrafficNetworkException`s — so a method name, an argument shape or an error is
what `api.md` says, as in every other binding.

**What you need:** the [Dart SDK](https://dart.dev) 3.4 or newer (or Flutter),
and a Rust toolchain to build the native library. Nothing is published to pub.dev
yet; you use the package from this repository, `client-lib/bindings/dart`.

## Build and run the example

All paths are relative to `client-lib/`.

```bash
# 1. The native library.
cd bindings/dart/rust
cargo build --release
#    → target/release/libtrafficnetwork_dart.so    (Linux)
#      target/release/libtrafficnetwork_dart.dylib (macOS)
#      target/release/trafficnetwork_dart.dll      (Windows)

# 2. The package's one dependency (flutter_rust_bridge's runtime).
cd ..
dart pub get

# 3. Run the example against a server, with a credential of scope `client`
#    (in server/: npm run create-client -- --name dart-example --scope client).
TN_DART_LIB=rust/target/release/libtrafficnetwork_dart.so \
TN_NODE=http://localhost:3000 TN_CLIENT_ID=… TN_CLIENT_SECRET=… \
  dart run example/trafficnetwork_example.dart
```

## The smallest possible use

```dart
import 'package:trafficnetwork/trafficnetwork.dart';

Future<void> main() async {
  await initialize(libraryPath: 'path/to/libtrafficnetwork_dart.so');

  final client = await TrafficNetworkClient.create({
    'storagePath': '/var/lib/myapp/trafficnetwork', // database + secrets live here
    'discovery': false,
    'nodes': ['https://node.example.org'],
    'credentials': {'type': 'client', 'clientId': '…', 'clientSecret': '…'},
  });

  await client.updatePosition(52.52, 13.405);               // which map tiles to watch
  await client.sync();                                      // fetch what is around
  print(await client.getSpeedLimitAt(52.52, 13.405));       // local, instant
  print(await client.getNearby(52.52, 13.405, 2000));       // local, instant

  await client.submitReport('accident', 52.52, 13.405);     // queued, shown at once
  await client.sync();                                      // …and sent
  await client.close();
}
```

Every method returns a `Future` and throws a `TrafficNetworkException` whose
`code` is one of the API's error codes (`api.md`, "Errors"). Nothing blocks
the isolate it is called from: calls run on the library's own threads.
`client.call('anyMethod', {…})` runs any API method by name; `callRaw` gives
the raw `{"ok"|"error"}` text.

Things an app usually wants on top of that:

- **Keep it fresh:** call `client.tick()` from a timer; it is cheap and syncs
  only when due. Nothing runs by itself.
- **Live updates:** `client.startRealtime()` keeps a WebSocket open on the
  library's own background task, and `client.events` is a broadcast `Stream`
  of what changed.
- **The Keychain / Keystore:** pass an object implementing `SecureStore`
  (`get`, `set`, `delete` — asynchronous, so `flutter_secure_storage` fits) as
  `secureStore:` and the device's credential and signing key go there instead
  of into a file in `storagePath`.
- **Finish:** `await client.close()`. The data stays on disk; a new client on
  the same `storagePath` picks up where this one left off.

## How it behaves

- **The Dart API is asynchronous throughout.** The native side runs every call
  on its own threads, so a sync that waits for the network never stalls your
  UI isolate.
- **A crash never reaches you as one:** a panic inside the library becomes an
  `internal` error result; a `SecureStore` of yours that throws answers "not
  there"/"refused", like in every other binding.
- **TLS** trusts the Mozilla root certificates bundled in the library, not the
  system's store: every platform behaves the same. A server whose certificate
  chains to a private authority is not trusted — see `api.md`, "Network &
  privacy".
- **Storage** is SQLite on the device (with a spatial index), written
  synchronously — the same store as every desktop build.

## Where the native library has to be

`initialize()` loads it. In a plain Dart program, pass `libraryPath:`. In a
Flutter app, the library has to be bundled for each platform the app targets
(the file names are the ones above; Android also needs one build per ABI,
made with `cargo ndk` as in `integration-android.md`, step 1, with
`-p trafficnetwork-dart` run from `bindings/dart/rust`). This guide covers the
Dart side; bundling it into a Flutter app is described, with its own build in
CI, in the packaging section once it exists — see `docs/status.md`.

## Verified in CI

`dart-package` (Dart VM on Linux):

- regenerates the Dart half and the Rust glue with `flutter_rust_bridge_codegen`
  and fails if they differ from what is checked in, so the checked-in code
  cannot drift from the Rust it was generated from;
- `dart analyze --fatal-infos` is clean, the glue crate is `rustfmt`-clean and
  builds;
- `conformance/scenarios.json` — the same scenarios, with the same
  expectations, as the Python, Node.js, browser, Kotlin and Swift runs — runs
  through the Dart package, twice: once with the secrets in the library's file,
  once with them in a `SecureStore` implemented in Dart (the library calling
  back into Dart);
- the example above runs against the scripted server and its output is checked.

**Not verified in CI, said plainly:** nothing runs in a Flutter app on a phone
or an emulator. The Dart code and the Rust code that run in the conformance test
are the shipped ones; what differs on a device is the CPU, the operating
system's libc and network stack, and Flutter's own engine.
