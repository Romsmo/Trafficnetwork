#!/usr/bin/env bash
# Turns what the client library's CI jobs built — their artifacts, downloaded
# into ./artifacts — into the files of a release, in ./release, with a
# checksums.txt:
#
#   C ABI (Linux, macOS, Windows) · Android AAR · Swift package + XCFramework ·
#   npm packages (Node.js, browser) · Python wheel + sdist · Dart package ·
#   Flutter plugin (Android + iOS libraries bundled) · React Native package
#
# CI runs this on every build (job `release-files`) so the assembly is tested
# long before a release; the release workflow (.github/workflows/release.yml)
# attaches the result to a GitHub Release. Nothing is published anywhere.
#
# Run from the repository root:  bash client-lib/release/assemble.sh
set -euo pipefail

root="$(pwd)"
VERSION="$(grep -m1 '^version' client-lib/Cargo.toml | cut -d'"' -f2)"
echo "assembling client-lib $VERSION"

rm -rf release stage
mkdir -p release stage

# ---- C ABI: the library, the header, the licence — per platform
header="$(find artifacts/trafficnetwork-c-header -name trafficnetwork.h)"
pack_c() { # <artifact directory> <platform label> <tar|zip>
  local dir="stage/trafficnetwork-c-abi-$VERSION-$2"
  mkdir -p "$dir"
  cp artifacts/"$1"/* "$dir"/
  cp "$header" LICENSE "$dir"/
  if [ "$3" = zip ]; then
    (cd stage && zip -qr "$root/release/trafficnetwork-c-abi-$VERSION-$2.zip" "trafficnetwork-c-abi-$VERSION-$2")
  else
    tar czf "release/trafficnetwork-c-abi-$VERSION-$2.tar.gz" -C stage "trafficnetwork-c-abi-$VERSION-$2"
  fi
}
pack_c trafficnetwork-c-abi-ubuntu-22.04 linux-x86_64 tar
pack_c trafficnetwork-c-abi-macos-latest macos-universal tar
pack_c trafficnetwork-c-abi-windows-latest windows-x86_64 zip

# ---- Android: the AAR
cp artifacts/trafficnetwork-android-aar/*.aar "release/trafficnetwork-android-$VERSION.aar"

# ---- Swift / iOS / macOS: the package, and the XCFramework on its own
swift="artifacts/trafficnetwork-swift-package"
(cd "$swift" && zip -qr "$root/release/trafficnetwork-swift-$VERSION.zip" .)
(cd "$swift" && zip -qry "$root/release/TrafficNetworkFFI-$VERSION.xcframework.zip" TrafficNetworkFFI.xcframework)

# ---- npm: the Node.js and browser packages
cp artifacts/trafficnetwork-npm-packages/*.tgz release/

# ---- Python: wheel and sdist of the pure-Python wrapper
python3 -m pip install --quiet build
python3 -m build client-lib/bindings/python --outdir release

# ---- Dart: the package (the Rust glue is part of the Flutter plugin's libraries)
dart="stage/trafficnetwork-dart-$VERSION"
mkdir -p "$dart"
cp -r client-lib/bindings/dart/lib client-lib/bindings/dart/pubspec.yaml \
      client-lib/bindings/dart/analysis_options.yaml LICENSE "$dart"/
tar czf "release/trafficnetwork-dart-$VERSION.tar.gz" -C stage "trafficnetwork-dart-$VERSION"

# ---- Flutter plugin: the Dart side, the Android libraries, the iOS XCFramework
plugin="stage/trafficnetwork-flutter-$VERSION"
mkdir -p "$plugin"
cp -r client-lib/bindings/flutter/lib client-lib/bindings/flutter/android client-lib/bindings/flutter/ios \
      client-lib/bindings/flutter/pubspec.yaml client-lib/bindings/flutter/analysis_options.yaml \
      client-lib/bindings/flutter/example LICENSE "$plugin"/
cp -r artifacts/trafficnetwork-flutter-plugin-android/android/src/main/jniLibs "$plugin/android/src/main/"
cp -r artifacts/trafficnetwork-flutter-plugin-ios/ios/Frameworks "$plugin/ios/"
tar czf "release/trafficnetwork-flutter-$VERSION.tar.gz" -C stage "trafficnetwork-flutter-$VERSION"

# ---- React Native: the two halves of the library, merged into one package
rn="stage/react-native"
mkdir -p "$rn"
tar xzf artifacts/trafficnetwork-react-native-android/trafficnetwork-react-native-android.tgz -C "$rn"
tar xzf artifacts/trafficnetwork-react-native-ios/trafficnetwork-react-native-ios.tgz -C "$rn" --skip-old-files
# Both halves must really be in it: the Rust for four Android ABIs and the XCFramework.
test -f "$rn/package/android/src/main/jniLibs/arm64-v8a/libtrafficnetwork_uniffi.a"
test -d "$rn/package/TrafficnetworkReactNativeFramework.xcframework"
(cd "$rn/package" && npm pack --ignore-scripts --pack-destination "$root/release")

# ---- Checksums
(cd release && sha256sum * > checksums.txt)
ls -l release
cat release/checksums.txt
