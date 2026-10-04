/// The Trafficnetwork client for Flutter apps: everything in
/// `package:trafficnetwork`, plus [initialize], which loads the native library
/// this package bundles for Android and iOS.
///
/// ```dart
/// import 'package:trafficnetwork_flutter/trafficnetwork_flutter.dart';
///
/// await initialize();
/// final client = await TrafficNetworkClient.create({…});
/// ```
library;

import 'dart:io' show Platform;

import 'package:trafficnetwork/trafficnetwork.dart' as core;

export 'package:trafficnetwork/trafficnetwork.dart'
    hide initialize;

/// Loads the native library. Call once, before the first client is created.
///
/// On Android and iOS the library is bundled with this package. Elsewhere
/// (desktop), pass [libraryPath] to a build of `libtrafficnetwork_dart`.
Future<void> initialize({String? libraryPath}) {
  if (libraryPath != null) {
    return core.initialize(libraryPath: libraryPath);
  }
  if (Platform.isAndroid) {
    // The Android build packages it as lib/<abi>/libtrafficnetwork_dart.so.
    return core.initialize(libraryPath: 'libtrafficnetwork_dart.so');
  }
  if (Platform.isIOS) {
    // A static library, linked into the app's own executable.
    return core.initialize(processLibrary: true);
  }
  throw UnsupportedError(
    'trafficnetwork_flutter bundles the native library for Android and iOS '
    'only; on this platform pass libraryPath: to a build of '
    'libtrafficnetwork_dart.',
  );
}
