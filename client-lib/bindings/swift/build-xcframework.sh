#!/usr/bin/env bash
# Builds the Swift package's two generated parts, on a Mac with Xcode and
# a Rust toolchain:
#
#   bindings/swift/build-xcframework.sh
#
#   1. the native library for iOS devices, the iOS simulator (Apple silicon
#      and Intel) and macOS (both), packaged as TrafficNetworkFFI.xcframework;
#   2. the Swift wrapper UniFFI generates from it (Sources/TrafficNetwork/).
#
# Needs the Rust targets: rustup target add aarch64-apple-ios
# aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-darwin x86_64-apple-darwin
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace="$(cd "$here/../.." && pwd)"
lib=libtrafficnetwork_uniffi.a
out="$here/build"

# The oldest systems the package declares (Package.swift), and what the C
# parts of the dependencies (SQLite, the crypto library) are compiled for.
export IPHONEOS_DEPLOYMENT_TARGET=13.0
export MACOSX_DEPLOYMENT_TARGET=11.0

cd "$workspace"
for target in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios \
              aarch64-apple-darwin x86_64-apple-darwin; do
  echo "== building for $target"
  cargo build --release -p trafficnetwork-uniffi --target "$target"
done

rm -rf "$out" "$here/TrafficNetworkFFI.xcframework"
mkdir -p "$out/ios" "$out/ios-simulator" "$out/macos" "$out/headers"
cp "target/aarch64-apple-ios/release/$lib" "$out/ios/$lib"
lipo -create \
  "target/aarch64-apple-ios-sim/release/$lib" \
  "target/x86_64-apple-ios/release/$lib" \
  -output "$out/ios-simulator/$lib"
lipo -create \
  "target/aarch64-apple-darwin/release/$lib" \
  "target/x86_64-apple-darwin/release/$lib" \
  -output "$out/macos/$lib"

# The generator reads the UniFFI description out of any one of the libraries.
# (Not its `--xcframework` flag: that writes the module map of a *framework*
# XCFramework, and this one holds static libraries.)
bindgen=(cargo run --quiet --release -p trafficnetwork-uniffi-bindgen --bin uniffi-bindgen-swift --)
source_lib="target/aarch64-apple-darwin/release/$lib"
"${bindgen[@]}" "$source_lib" "$out/headers" \
  --headers --modulemap \
  --module-name TrafficNetworkFFI --modulemap-filename module.modulemap \
  --link-frameworks Security --link-frameworks SystemConfiguration \
  --link-frameworks CoreFoundation
rm -f "$here"/Sources/TrafficNetwork/*.swift
"${bindgen[@]}" "$source_lib" "$here/Sources/TrafficNetwork" \
  --swift-sources

xcodebuild -create-xcframework \
  -library "$out/ios/$lib" -headers "$out/headers" \
  -library "$out/ios-simulator/$lib" -headers "$out/headers" \
  -library "$out/macos/$lib" -headers "$out/headers" \
  -output "$here/TrafficNetworkFFI.xcframework"

echo "built $here/TrafficNetworkFFI.xcframework and $(ls "$here"/Sources/TrafficNetwork/*.swift | wc -l | tr -d ' ') Swift file(s)"
