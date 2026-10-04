# Integration guide — Android (Kotlin)

The same client every binding exposes (`api.md` describes every method), as a
Kotlin class in an Android library (AAR). UniFFI generates the Kotlin from the
Rust code, so there is no hand-written layer that could drift: a method name,
an argument shape or an error is what `api.md` says, as in every other binding.

**What you need:** a Rust toolchain with the four Android targets
(`rustup target add aarch64-linux-android armv7-linux-androideabi
x86_64-linux-android i686-linux-android`), `cargo-ndk`
(`cargo install --locked cargo-ndk`), the Android SDK with an NDK (set
`ANDROID_NDK_HOME`), JDK 17 and [Gradle](https://gradle.org) 8.10 or newer —
the project does not ship a Gradle wrapper, so either install Gradle or run
`gradle wrapper` once in `bindings/kotlin/android`. Nothing is published to
Maven yet: you build the AAR from this repository (the CI job `android-aar`
does exactly these steps and attaches the AAR to the run).

## Build the AAR and the example app

All paths are relative to `client-lib/`.

```bash
# 1. The native library for every Android ABI → the library module's jniLibs/.
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -t x86 \
  -o bindings/kotlin/android/src/main/jniLibs \
  build --release -p trafficnetwork-uniffi

# 2. The Kotlin wrapper UniFFI generates from it (any one ABI's file will do).
bash bindings/kotlin/generate.sh android \
  bindings/kotlin/android/src/main/jniLibs/arm64-v8a/libtrafficnetwork_uniffi.so

# 3. The AAR, and the example app that uses it.
cd bindings/kotlin/android
gradle assembleRelease :example:assembleDebug
#   → build/outputs/aar/trafficnetwork-android-release.aar
#   → example/build/outputs/apk/debug/example-debug.apk
```

`generate.sh` builds the generator from this workspace, so it is always the
same UniFFI version as the library. Optionally strip the symbols from the
`.so` files before step 3 (`llvm-strip --strip-unneeded`, from the NDK) — the
libraries are about a third of the size without them. Do it *after* step 2:
the generator reads its description of the API out of the library's symbols.

## Use it in your app

Put `trafficnetwork-android-release.aar` in `app/libs/` and, in the app's
`build.gradle.kts`:

```kotlin
dependencies {
    implementation(files("libs/trafficnetwork-android-release.aar"))
    // What the AAR needs, and does not carry along when it is a plain file:
    implementation("net.java.dev.jna:jna:5.14.0@aar")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("androidx.annotation:annotation:1.8.2")
}
```

and `android.useAndroidX=true` in `gradle.properties` (the default in any
recent project). The AAR's manifest asks for the `INTERNET` permission.

## The smallest possible use

```kotlin
import info.trafficnetwork.client.TrafficNetworkClient
import org.json.JSONArray
import org.json.JSONObject

val options = JSONObject()
    .put("storagePath", filesDir.resolve("trafficnetwork").path) // database + secrets live here
    .put("discovery", false)
    .put("nodes", JSONArray().put("https://node.example.org"))
    .put("credentials", JSONObject()
        .put("type", "client").put("clientId", "…").put("clientSecret", "…"))
val client = TrafficNetworkClient(options.toString(), null)

// Every call is  call(method, argsJson) -> resultJson,  {"ok": …} or {"error": …}.
// Calls that reach the network block until done: run them off the UI thread
// (or use `callAsync`, a suspend function).
val here = JSONObject().put("lat", 52.52).put("lng", 13.405)
client.call("updatePosition", here.toString())               // which map tiles to watch
println(client.call("sync", "{}"))                           // fetch what is around
println(client.call("getSpeedLimitAt", here.toString()))     // local, instant
println(client.call("getNearby", here.put("radiusMeters", 2000).toString())) // local, instant

client.close()                                               // data stays on disk
```

`bindings/kotlin/android/example/` is this, as a complete app — one Activity
that does the above on a background thread and shows the results (replace the
three constants at the top of `MainActivity.kt` first). The same code runs
unchanged on a plain JVM: `bindings/kotlin/jvm/` (see below), which is what the
conformance test and the guide's example use.

Things an app usually wants on top of that:

- **Errors:** `call` never throws for an ordinary failure; it returns
  `{"error": {"code", "message"}}` with one of the API's codes (`api.md`,
  "Errors"). Only `TrafficNetworkClient(...)` can throw —
  `ClientException.Failed(errorCode, detail)` for options it cannot use.
- **Keep it fresh:** call `tick` from a timer or a `WorkManager` job; it is
  cheap and syncs only when due. Nothing runs by itself.
- **Live updates:** `client.startRealtime()` keeps a WebSocket open on the
  library's own background task; `client.setEventListener(listener)` (an
  object implementing `EventListener.onEvent(eventJson)`) tells you when data
  changed — it is called from a library thread, so hand over to the UI thread
  yourself.
- **The Android Keystore:** pass an object implementing `SecureStore` —
  `get(key)`, `set(key, value)`, `delete(key)` — as the second constructor
  argument and the device's credential and signing key go there instead of
  into a file in `storagePath`. It may be called from any thread.
- **Finish:** `client.close()` (it is `AutoCloseable`: `client.use { … }`).

## How it behaves

- **Calls run on the library's own threads** (8 MiB stacks), never on yours —
  the calling thread only waits. A call that goes deep (TLS, JSON, SQLite) does
  not depend on how big your thread's stack is.
- **A crash never reaches you as one:** a panic inside the library becomes an
  `internal` error result; a `SecureStore` or listener of yours that throws
  answers "not there"/"refused" (store) or is ignored (listener), like in every
  other binding.
- **TLS** trusts the Mozilla root certificates bundled in the library, not
  Android's own store: that is what lets one AAR work without every app wiring
  in extra setup. A server whose certificate chains to a private authority is
  not trusted — see `api.md`, "Network & privacy".
- **Storage** is SQLite on the device (with a spatial index), written
  synchronously — the same store as the desktop builds, so a whole country's
  static data fits; `planBootstrap` tells you the size first.

## Plain JVM (and what is verified)

`bindings/kotlin/jvm/` is a Gradle project around the same generated Kotlin on
a plain JVM, loading a Linux build of the same library:

```bash
cargo build -p trafficnetwork-uniffi
bash bindings/kotlin/generate.sh jvm target/debug/libtrafficnetwork_uniffi.so
cd bindings/kotlin/jvm && gradle installDist
TN_NODE=http://localhost:3000 TN_CLIENT_ID=… TN_CLIENT_SECRET=… \
  java -Djna.library.path=../../../target/debug \
  -cp 'build/install/trafficnetwork-kotlin-jvm/lib/*' info.trafficnetwork.example.ExampleKt
```

**Verified in CI:**

- `conformance-kotlin` runs `conformance/scenarios.json` — the same scenarios,
  with the same expectations, as the Python, Node.js, browser and Swift runs —
  through this Kotlin binding, twice: once with the secrets in the library's
  file, once with them in a `SecureStore` implemented in Kotlin (the library
  calling back into Kotlin). Then it runs the example above and checks what it
  prints.
- `android-aar` builds the AAR for all four ABIs, checks that it contains each
  ABI's library and the Kotlin classes, and builds the example app against it.

**Not verified in CI, said plainly:** nothing runs on an Android device or
emulator. The Kotlin code and the Rust code that run in the conformance test
are the shipped ones; what differs on a phone is the CPU, Android's Bionic
libc and its network stack, which no CI job here exercises. If something
behaves differently on a device, that is a bug to report.
