#!/usr/bin/env bash
# Builds the native library into this plugin, from the Rust glue crate in
# ../dart/rust:
#
#   bindings/flutter/build-native.sh android   # android/src/main/jniLibs/<abi>/libtrafficnetwork_dart.so
#   bindings/flutter/build-native.sh ios       # ios/Frameworks/TrafficNetworkDart.xcframework  (on a Mac)
#
# Neither result is checked in — both come out of the Rust code. Android needs
# cargo-ndk and an NDK (ANDROID_NDK_HOME) and the Rust Android targets; iOS
# needs Xcode and the Rust targets aarch64-apple-ios, aarch64-apple-ios-sim
# and x86_64-apple-ios.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
glue="$here/../dart/rust"
lib=libtrafficnetwork_dart.a

case "${1:?usage: build-native.sh <android|ios>}" in
  android)
    cd "$glue"
    rm -rf "$here/android/src/main/jniLibs"
    cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -t x86 \
      -o "$here/android/src/main/jniLibs" build --release
    ls -l "$here"/android/src/main/jniLibs/*/
    ;;
  ios)
    export IPHONEOS_DEPLOYMENT_TARGET=13.0
    cd "$glue"
    for target in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
      echo "== building for $target"
      cargo build --release --target "$target"
    done
    out="$here/ios/build"
    rm -rf "$out" "$here/ios/Frameworks"
    mkdir -p "$out/ios" "$out/ios-simulator" "$here/ios/Frameworks"
    cp "target/aarch64-apple-ios/release/$lib" "$out/ios/$lib"
    lipo -create \
      "target/aarch64-apple-ios-sim/release/$lib" \
      "target/x86_64-apple-ios/release/$lib" \
      -output "$out/ios-simulator/$lib"
    xcodebuild -create-xcframework \
      -library "$out/ios/$lib" \
      -library "$out/ios-simulator/$lib" \
      -output "$here/ios/Frameworks/TrafficNetworkDart.xcframework"
    rm -rf "$out"
    ls "$here/ios/Frameworks/TrafficNetworkDart.xcframework"
    ;;
  *)
    echo "usage: build-native.sh <android|ios>" >&2
    exit 2
    ;;
esac
