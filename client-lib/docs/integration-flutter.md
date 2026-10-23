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

## Offline area and report duration (1.2.0)

From 1.2.0 the device chooses what it keeps of the static data (`offline-storage.md`): by default the surroundings of the
position you give with `updatePosition`, a home, and places driven through lately — **a client that never gives a position
stores nothing**. Pick regions or everything explicitly if that is what the app wants:

```dart
await client.setOfflineRegions(mode: 'all');
// or: final regions = await client.listOfflineRegions(); … setOfflineRegions(regions: [id])
await client.setStorageLimits(maxBytes: 300 * 1024 * 1024, wifiOnly: true);
await client.setConnectionMetered(false);
```

Also new: `getReportLimits(type)` and an optional duration on `submitReport` (`api.md`, "Writes"),
`reportSpeedLimitInterval` for a stretch of road named by two points (with `resolveRoadInterval` to preview it and `dataDefectsNear`/`reportDataDefect` for wrong entries), and `lookupSpeedLimit`, which says *outside the offline area*
instead of "no limit" where nothing could be looked at.

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
the native library — Android (one `.so` per ABI) and iOS (a dynamic
XCFramework, for **Swift Package Manager and CocoaPods**) — so that adding the package is all an app does. It re-exports
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
the APK (`lib/<abi>/libtrafficnetwork_dart.so`); on iOS the app embeds
`TrafficNetworkDart.framework` (a dynamic framework, in the app's `Frameworks` folder) and
`initialize()` opens it by name.

### iOS: Swift Package Manager or CocoaPods (1.2.1)

The plugin ships both, next to each other under `bindings/flutter/ios/`, over the same XCFramework
(`ios/trafficnetwork_flutter/Frameworks/TrafficNetworkDart.xcframework`, built by `build-native.sh ios`, a device slice and a
simulator slice):

- **Swift Package Manager** — `ios/trafficnetwork_flutter/Package.swift` (Flutter's plugin layout; the library product is
  `trafficnetwork-flutter`, a binary target for the XCFramework and an empty Swift target to link it from). With
  `flutter config --enable-swift-package-manager` (the default in current Flutter) an app builds with **no `pod install`
  and no Podfile entry** for this plugin; tools that build Flutter iOS apps without CocoaPods work with it.
- **CocoaPods** — `ios/trafficnetwork_flutter.podspec` as before (`vendored_frameworks`), for apps that still use pods.

Either way Xcode links the framework and embeds it (and signs it with the app's identity) like any other dynamic framework.
Nothing else is needed: no linker flags, no build settings in the app.

#### Why a dynamic framework (and not the static library of 1.2.0)

Dart finds the library's functions **by name at run time** (`dlsym`); nothing in the app refers to them, so a static library
linked into the app is at the mercy of the linker. Measured on a macOS runner with the real library and Apple's linker
(17 of the functions Dart looks up, `dlsym` in the linked program afterwards):

| link | found |
|---|---|
| static library, no flags | 0 of 17 |
| `-force_load` | 17 of 17 |
| `-force_load` **with `-dead_strip`** (Xcode's *Dead Code Stripping*) | **0 of 17** |
| symbol list (`-u`) with `-dead_strip` | 17 of 17 |
| ... and then `strip -u -r` (Xcode's default *Strip Style* when an app is archived) | **0 of 17** |

So `-force_load` and `STRIP_STYLE = non-global` (what the 1.2.0 podspec did) held only while the app's own settings did not
strip, and a Swift Package cannot set an app's build settings at all. A dynamic framework needs none of it: its exported
functions are in the framework, which is loaded by the app (`dlopen` by the name `TrafficNetworkDart.framework/TrafficNetworkDart`)
and is not touched by the app's dead-code stripping or `strip`. If you build the library yourself: it is the Rust glue crate as a
`cdylib` per iOS target, wrapped in a `.framework` (install name `@rpath/TrafficNetworkDart.framework/TrafficNetworkDart`,
an `Info.plist`) and put together with `xcodebuild -create-xcframework` — see `build-native.sh`.

On desktop the plugin bundles nothing: build the library for the platform and
pass `initialize(libraryPath: '…')`.

## Verified in CI

`flutter-android` and `flutter-ios` (Android on Linux, iOS on a macOS runner):
the library is built into the plugin, a **brand-new Flutter app** is created the
way this guide says (`flutter create`, add the package, paste the example),
analyzed, and built — an APK that is checked to contain
`libtrafficnetwork_dart.so`. On iOS this is done **twice**, with Swift Package Manager only (no Pods directory;
the generated package lists `trafficnetwork-flutter`) and with CocoaPods: an unsigned release build for an iOS device, in
which the framework is checked to be embedded, linked by the executable and to export the functions Dart looks up, and a
debug build for the simulator. The plugin and the APK are kept as artifacts.

**Run, on an iOS simulator** (the Swift Package app): the example's integration test loads the library by name, a client
syncs against the scripted server, and a secret store implemented in Dart is called by the library — the same two tests that
run on an Android emulator (`flutter-android-emulator`).

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

**Not verified in CI, said plainly:** nothing executes on a **physical** phone. The apps run on an Android emulator and
an iOS simulator (a debug build of the app: Flutter has no release mode on a simulator); the iOS *release* app for a device is
built, and the framework in it is checked (embedded, linked, exporting the functions Dart looks up) but not run. What
differs on a device is the CPU, the operating system's libc and network stack and Flutter's own engine — and code
signing: the framework is signed by Xcode with the app's identity, which CI (unsigned builds) does not exercise.
