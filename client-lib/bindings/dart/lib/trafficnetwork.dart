/// The Trafficnetwork client for Dart and Flutter.
///
/// The same client every binding exposes (`client-lib/docs/api.md` describes
/// every method), reached through `flutter_rust_bridge`. All the logic lives
/// in the Rust core; this file adds only typed convenience over its one
/// `call(method, argsJson)`: JSON in and out, and errors as
/// [TrafficNetworkException]s. Every method returns a [Future] - nothing here
/// blocks the isolate it is called from.
///
/// ```dart
/// await initialize();
/// final client = await TrafficNetworkClient.create({
///   'storagePath': appDirectory,
///   'discovery': false,
///   'nodes': ['https://node.example.org'],
///   'credentials': {'type': 'client', 'clientId': '…', 'clientSecret': '…'},
/// });
/// await client.updatePosition(52.52, 13.405);
/// await client.sync();
/// print(await client.getSpeedLimitAt(52.52, 13.405)); // local, instant
/// ```
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter_rust_bridge/flutter_rust_bridge_for_generated.dart'
    show ExternalLibrary;

import 'src/rust/api/client.dart' as native;
import 'src/rust/frb_generated.dart' show RustLib;

/// Why a call failed: [code] is one of the API's error codes
/// (`api.md`, "Errors"), [message] a text for the log.
class TrafficNetworkException implements Exception {
  TrafficNetworkException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'TrafficNetworkException($code): $message';
}

/// Where the device's secrets (its credential and signing key) are kept,
/// instead of in a file in the client's directory: the Keychain on iOS, the
/// Keystore on Android - for example through `flutter_secure_storage`. May be
/// asynchronous, as those plugins are.
abstract interface class SecureStore {
  /// The value stored under [key], or `null` if there is none.
  Future<String?> get(String key);

  Future<void> set(String key, String value);

  Future<void> delete(String key);
}

/// Loads the native library. Call before the first client is created; calling
/// it again (a second screen, a second test) returns the first call's result
/// instead of loading twice, so the arguments of the first call are the ones
/// that count. A failed attempt may be retried.
///
/// [libraryPath] names the library file (`libtrafficnetwork_dart.so`,
/// `.dylib`, `.dll`; a bare name is looked up the way the platform looks up
/// libraries). With [processLibrary] the library is expected to be linked into
/// the running program already (a static library on iOS) and [libraryPath] is
/// not used. With neither, the loader looks where a Flutter app's build puts
/// it. The `trafficnetwork_flutter` package calls this with what its
/// platforms need.
Future<void> initialize({String? libraryPath, bool processLibrary = false}) {
  final running = _initialization;
  if (running != null) return running;
  final started = RustLib.init(
    externalLibrary: processLibrary
        ? ExternalLibrary.process(iKnowHowToUseIt: true)
        : libraryPath == null
            ? null
            : ExternalLibrary.open(libraryPath),
  );
  _initialization = started;
  started.onError<Object>((error, stackTrace) {
    _initialization = null;
  });
  return started;
}

Future<void>? _initialization;

/// The native library's version.
String libraryVersion() => native.libraryVersion();

/// A client. Create one with [create]; [close] releases it. A client may be
/// used from several places at once.
class TrafficNetworkClient {
  TrafficNetworkClient._(this._native);

  final native.NativeClient _native;
  Stream<Map<String, Object?>>? _events;

  /// Creates a client. [options] is the client's options (`api.md`,
  /// "Options") plus `storagePath`, the directory its database and secrets
  /// go in. With a [secureStore] the device's secrets go there instead of
  /// into a file in that directory.
  ///
  /// Throws a [TrafficNetworkException] if the options are not acceptable.
  static Future<TrafficNetworkClient> create(
    Map<String, Object?> options, {
    SecureStore? secureStore,
  }) async {
    final json = jsonEncode(options);
    try {
      final created = secureStore == null
          ? await native.NativeClient.create(optionsJson: json)
          : await native.NativeClient.createWithSecureStore(
              optionsJson: json,
              get_: (key) async {
                try {
                  return await secureStore.get(key);
                } catch (_) {
                  return null;
                }
              },
              set_: (key, value) async {
                try {
                  await secureStore.set(key, value);
                  return true;
                } catch (_) {
                  return false;
                }
              },
              delete: (key) async {
                try {
                  await secureStore.delete(key);
                  return true;
                } catch (_) {
                  return false;
                }
              },
            );
      return TrafficNetworkClient._(created);
    } on native.ClientError catch (error) {
      throw TrafficNetworkException(error.errorCode, error.detail);
    }
  }

  /// Runs any API method by its camelCase name and returns the raw result
  /// envelope, `{"ok": …}` or `{"error": {"code", "message"}}`, as text.
  /// Never throws for an ordinary API failure.
  Future<String> callRaw(String method, [String argsJson = '']) =>
      _native.call(method: method, argsJson: argsJson);

  /// Runs any API method by its camelCase name: the result, or a
  /// [TrafficNetworkException].
  Future<Object?> call(String method, [Map<String, Object?>? args]) async {
    final text = await callRaw(method, jsonEncode(args ?? const {}));
    final envelope = jsonDecode(text) as Map<String, Object?>;
    final error = envelope['error'];
    if (error is Map<String, Object?>) {
      throw TrafficNetworkException(
        (error['code'] as String?) ?? 'internal',
        (error['message'] as String?) ?? '',
      );
    }
    return envelope['ok'];
  }

  Future<Map<String, Object?>> _object(
    String method, [
    Map<String, Object?>? args,
  ]) async =>
      (await call(method, args)) as Map<String, Object?>;

  // ----------------------------------------------------------- the API

  Future<Map<String, Object?>> version() => _object('version');

  /// The speed limit at a position, answered from the local copy; `null` when
  /// nothing is known there.
  Future<Map<String, Object?>?> getSpeedLimitAt(
    double lat,
    double lng, {
    double? heading,
  }) async =>
      (await call('getSpeedLimitAt', {
        'lat': lat,
        'lng': lng,
        if (heading != null) 'heading': heading,
      })) as Map<String, Object?>?;

  Future<List<Object?>> getNearby(
    double lat,
    double lng,
    double radiusMeters, {
    List<String>? categories,
  }) async =>
      (await _object('getNearby', {
        'lat': lat,
        'lng': lng,
        'radiusMeters': radiusMeters,
        if (categories != null && categories.isNotEmpty)
          'categories': categories,
      }))['items'] as List<Object?>;

  /// Queues a report; returns its local id. Sent by the next [sync].
  Future<Object?> submitReport(
    String type,
    double lat,
    double lng, {
    double? speedKmh,
  }) async =>
      (await _object('submitReport', {
        'type': type,
        'lat': lat,
        'lng': lng,
        if (speedKmh != null) 'speedKmh': speedKmh,
      }))['localId'];

  Future<Object?> confirmReport(String reportId, bool stillThere) async =>
      (await _object('confirmReport', {
        'reportId': reportId,
        'stillThere': stillThere,
      }))['localId'];

  Future<Object?> reportCameraRemoved(String cameraId) async =>
      (await _object('reportCameraRemoved', {'cameraId': cameraId}))['localId'];

  Future<Map<String, Object?>> reportWrongSpeedLimit({
    required num proposedValue,
    required String unit,
    String? segmentId,
    double? lat,
    double? lng,
    String? reason,
  }) =>
      _object('reportWrongSpeedLimit', {
        'proposedValue': proposedValue,
        'unit': unit,
        if (segmentId != null) 'segmentId': segmentId,
        if (lat != null && lng != null) ...{'lat': lat, 'lng': lng},
        if (reason != null) 'reason': reason,
      });

  Future<Object?> confirmSpeedLimitCorrection({
    required bool agrees,
    String? segmentId,
    Map<String, Object?>? correction,
  }) async =>
      (await _object('confirmSpeedLimitCorrection', {
        'agrees': agrees,
        if (segmentId != null) 'segmentId': segmentId,
        if (correction != null) 'correction': correction,
      }))['localId'];

  Future<List<Object?>> fetchCorrections() async =>
      (await _object('fetchCorrections'))['corrections'] as List<Object?>;

  /// Tells the client where the device is, so it knows which map tiles to
  /// keep fresh.
  Future<Map<String, Object?>> updatePosition(
    double lat,
    double lng, {
    double? speedKmh,
  }) =>
      _object('updatePosition', {
        'lat': lat,
        'lng': lng,
        if (speedKmh != null) 'speedKmh': speedKmh,
      });

  /// Fetches what is around and sends what was queued.
  Future<Map<String, Object?>> sync() => _object('sync');

  /// Cheap; syncs only when due. Call it from a timer.
  Future<Map<String, Object?>> tick() => _object('tick');

  Future<Map<String, Object?>> planBootstrap() => _object('planBootstrap');

  Future<Map<String, Object?>> getSyncStatus() => _object('getSyncStatus');

  Future<Map<String, Object?>> getNetworkStatus() => _object('getNetworkStatus');

  Future<List<Object?>> pollEvents() async =>
      (await _object('pollEvents'))['events'] as List<Object?>;

  // ------------------------------------------------- events and realtime

  /// Every event as it happens (`api.md`, "Events"; they are also queued for
  /// [pollEvents]). One stream per client, started on first use.
  Stream<Map<String, Object?>> get events => _events ??= _native
      .events()
      .map((text) => jsonDecode(text) as Map<String, Object?>)
      .asBroadcastStream();

  /// Keeps a WebSocket open and applies pushed events, on the library's own
  /// background task. A no-op if already running.
  Future<void> startRealtime() => _native.startRealtime();

  Future<void> stopRealtime() => _native.stopRealtime();

  /// Closes the client and releases its native memory. The data stays on
  /// disk; a new client on the same `storagePath` picks up where this one
  /// left off. Do not use the client afterwards.
  Future<void> close() async {
    await _native.stopRealtime();
    await _native.stopEvents();
    await callRaw('close');
    _native.dispose();
  }
}
