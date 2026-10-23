#!/usr/bin/env bash
# Builds the native library into this plugin, from the Rust glue crate in
# ../dart/rust:
#
#   bindings/flutter/build-native.sh android   # android/src/main/jniLibs/<abi>/libtrafficnetwork_dart.so
#   bindings/flutter/build-native.sh ios       # ios/trafficnetwork_flutter/Frameworks/TrafficNetworkDart.xcframework  (on a Mac)
#
# Neither result is checked in — both come out of the Rust code. Android needs
# cargo-ndk and an NDK (ANDROID_NDK_HOME) and the Rust Android targets; iOS
# needs Xcode and the Rust targets aarch64-apple-ios, aarch64-apple-ios-sim
# and x86_64-apple-ios.
#
# iOS: a *dynamic* framework (one XCFramework with a device and a simulator slice),
# not a static library. Dart finds the library's functions by name at run time
# (dlsym); a static library linked into the app is at the mercy of the linker -
# dead-code stripping and `strip` drop what nothing refers to (measured:
# docs/integration-flutter.md, "Why a dynamic framework") - while a dynamic
# framework keeps its exported functions whatever the app's build settings say. The
# same XCFramework serves the Swift Package (ios/trafficnetwork_flutter/Package.swift)
# and the CocoaPods podspec.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
glue="$here/../dart/rust"
dylib=libtrafficnetwork_dart.dylib
name=TrafficNetworkDart

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
    version="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' "$glue/Cargo.toml" | head -1)"
    cd "$glue"
    for target in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
      echo "== building for $target"
      cargo rustc --release --lib --crate-type cdylib --target "$target"
    done

    out="$here/ios/build"
    frameworks="$here/ios/trafficnetwork_flutter/Frameworks"
    rm -rf "$out" "$frameworks"
    mkdir -p "$out/ios" "$out/ios-simulator" "$frameworks"

    # One .framework per slice: the binary (installed under @rpath, where an app's
    # Frameworks folder is) and an Info.plist.
    make_framework() { # make_framework <dir> <platform name> <binary>
      local fw="$1/$name.framework"
      mkdir -p "$fw"
      cp "$3" "$fw/$name"
      install_name_tool -id "@rpath/$name.framework/$name" "$fw/$name"
      cat > "$fw/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$name</string>
  <key>CFBundleIdentifier</key><string>io.github.romsmo.trafficnetwork.dart</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>CFBundleSupportedPlatforms</key><array><string>$2</string></array>
  <key>MinimumOSVersion</key><string>13.0</string>
</dict>
</plist>
PLIST
    }
    make_framework "$out/ios" iPhoneOS "target/aarch64-apple-ios/release/$dylib"
    lipo -create \
      "target/aarch64-apple-ios-sim/release/$dylib" \
      "target/x86_64-apple-ios/release/$dylib" \
      -output "$out/simulator-universal.dylib"
    make_framework "$out/ios-simulator" iPhoneSimulator "$out/simulator-universal.dylib"

    xcodebuild -create-xcframework \
      -framework "$out/ios/$name.framework" \
      -framework "$out/ios-simulator/$name.framework" \
      -output "$frameworks/$name.xcframework"
    rm -rf "$out"
    ls "$frameworks/$name.xcframework"
    ;;
  *)
    echo "usage: build-native.sh <android|ios>" >&2
    exit 2
    ;;
esac
