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
yet; you use the packages from this repository: `client-lib/bindings/dart` (pure Dart) and `client-lib/bindings/flutter` (the Flutter plugin).

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
#    (in server/: npm run create-client -- --name dart-example --scope client;
#    in the Docker stack: server/docs/installation.md, "Create the first client").
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

- **Initialize once:** `initialize()` may be called again (a second screen, a
  test) — it returns the first call's result instead of loading the library twice.
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

## In a Flutter app (Android and iOS)

`bindings/flutter` is a Flutter plugin, `trafficnetwork_flutter`, that bundles
the native library — Android (one `.so` per ABI) and iOS (a static
XCFramework) — so that adding the package is all an app does. It re-exports
everything in `package:trafficnetwork` and adds an `initialize()` that loads the
bundled library.

All paths are relative to `client-lib/`; a Rust toolchain is needed once, to
build the library into the plugin (the results are not checked in):

```bash
# Android (needs cargo-ndk, an NDK via ANDROID_NDK_HOME, the four Rust Android
# targets — see integration-android.md, step 1):
bash bindings/flutter/build-native.sh android
# iOS (on a Mac, with the three Rust iOS targets: aarch64-apple-ios,
# aarch64-apple-ios-sim, x86_64-apple-ios):
bash bindings/flutter/build-native.sh ios
```

Then, in a Flutter app (`flutter create my_app && cd my_app`):

```bash
flutter pub add path_provider
flutter pub add trafficnetwork_flutter --path <this repository>/client-lib/bindings/flutter
```

and replace `lib/main.dart` with `bindings/flutter/example/lib/main.dart` (set
the three constants at its top first). Its core is:

```dart
import 'package:path_provider/path_provider.dart';
import 'package:trafficnetwork_flutter/trafficnetwork_flutter.dart';

await initialize(); // loads the library the plugin bundled

final support = await getApplicationSupportDirectory();
final client = await TrafficNetworkClient.create({
  'storagePath': '${support.path}/trafficnetwork', // the app's private directory
  'discovery': false,
  'nodes': ['https://node.example.org'],
  'credentials': {'type': 'client', 'clientId': '…', 'clientSecret': '…'},
});
await client.updatePosition(52.52, 13.405);
await client.sync();
print(await client.getSpeedLimitAt(52.52, 13.405));
```

Then `flutter run` as for any app. The Android plugin packages the library into
the APK (`lib/<abi>/libtrafficnetwork_dart.so`); on iOS the static library is
linked into the app's executable (`-force_load`, with the app's symbols left
unstripped — Dart finds the library's functions by name at run time, so nothing
refers to them and a linker would otherwise drop them; the podspec sets both).

On desktop the plugin bundles nothing: build the library for the platform and
pass `initialize(libraryPath: '…')`.

## Verified in CI

`flutter-android` and `flutter-ios` (Android on Linux, iOS on a macOS runner):
the library is built into the plugin, a **brand-new Flutter app** is created the
way this guide says (`flutter create`, add the package, paste the example),
analyzed, and built — an APK that is checked to contain
`libtrafficnetwork_dart.so`, an unsigned release build for an iOS device, and a
debug build for the iOS simulator. The plugin and the APK are kept as artifacts.

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

**Not verified in CI, said plainly:** the Flutter apps are *built*, not *run* —
nothing executes on a phone, an emulator or an iOS simulator. The Dart code and
the Rust code that run in the conformance test are the shipped ones; what
differs on a device is the CPU, the operating system's libc and network stack,
Flutter's own engine, and — on iOS — whether the linker really keeps the
library's functions (the build links; whether `dlsym` finds them at run time is
only known by running it).
