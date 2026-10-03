# The release files

Every CI run of `client-lib-ci` assembles what its jobs built into the files
below (job `release-files`, `client-lib/release/assemble.sh`) and attaches them
as the artifact `trafficnetwork-release-files`, with a `checksums.txt`. A tag
`client-lib-v<version>` runs the same CI and attaches the same files to a
GitHub Release. `<version>` is the one in `client-lib/Cargo.toml`; a check in CI
(`release/check-versions.mjs`) makes every package carry it.

**Nothing is published to a registry** (npm, Maven Central, pub.dev,
CocoaPods, PyPI): the packages are marked `private` / `publish_to: none`, and
publishing them is a decision of its own. You use the files directly, as below.

| File | For | What to do with it | Guide |
|---|---|---|---|
| `trafficnetwork-c-abi-<v>-linux-x86_64.tar.gz`, `…-macos-universal.tar.gz`, `…-windows-x86_64.zip` | C, C++, anything with an FFI | link the library, include `trafficnetwork.h` (both are in the archive, with the licence) | [integration-c.md](integration-c.md) |
| `trafficnetwork-android-<v>.aar` | Android (Kotlin/Java) | put it in `app/libs/`, add the JNA dependency | [integration-android.md](integration-android.md) |
| `trafficnetwork-swift-<v>.zip` | iOS / macOS (Swift Package) | unzip, add as a local package | [integration-ios.md](integration-ios.md) |
| `TrafficNetworkFFI-<v>.xcframework.zip` | iOS / macOS | the XCFramework on its own | [integration-ios.md](integration-ios.md) |
| `trafficnetwork-dart-<v>.tar.gz` | Dart (command line, server) | `dependencies: trafficnetwork: {path: …}`; the native library comes from the C-ABI/Dart build | [integration-flutter.md](integration-flutter.md) |
| `trafficnetwork-flutter-<v>.tar.gz` | Flutter (Android + iOS) | unpack, `dependencies: trafficnetwork_flutter: {path: …}`; the native libraries are inside | [integration-flutter.md](integration-flutter.md) |
| `trafficnetwork-react-native-<v>.tgz` (`@trafficnetwork/react-native`) | React Native (Android + iOS) | `npm install ./trafficnetwork-react-native-<v>.tgz` | [integration-react-native.md](integration-react-native.md) |
| `trafficnetwork-client-web-<v>.tgz` | browser | `npm install ./…tgz`, serve `node_modules/@trafficnetwork/client-web/` | [integration-web.md](integration-web.md) |
| `trafficnetwork-client-node-<v>.tgz` | Node.js | `npm install ./…tgz`, plus the C-ABI library for your platform | [integration-node.md](integration-node.md) |
| `trafficnetwork-<v>-py3-none-any.whl`, `trafficnetwork-<v>.tar.gz` | Python | `pip install ./…whl`, plus the C-ABI library for your platform | [integration-python.md](integration-python.md) |

## Which platforms were built where

What each file is built from, and on which runner, is written down in the
workflow (`.github/workflows/client-lib-ci.yml`); the honest summary of what is
only *built* and what is also *run* is in [README.md](../README.md), "Plattformen
und was davon geprüft ist".

## Checking a download

```bash
sha256sum -c checksums.txt      # every file, against the list next to them
```
