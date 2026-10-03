// A conformance bridge: lets conformance/run_bridge.mjs drive the Dart binding
// with the same scenarios every other binding runs, so "same behavior
// everywhere" is checked here too and not assumed. One request per line on
// stdin, one JSON reply per line on stdout (conformance/bridge-client.mjs
// documents the protocol; the Kotlin and Swift bridges speak the same one):
//
//   {"op":"new","options":"<options json>","hostSecureStore":false}
//        -> {"ok":true}   or   {"error":{"code":"...","message":"..."}}
//   {"op":"call","method":"sync","args":"{}"}  -> {"result":"<result envelope>"}
//   {"op":"events"}                            -> {"count":N}
//   {"op":"free"}                              -> {"ok":true}, then the process ends
//
// Nothing here knows what a scenario is; it only moves strings across the
// boundary the way an app would. TN_DART_LIB names the native library file.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:trafficnetwork/trafficnetwork.dart';

/// A secret store kept in memory - stands in for the Keychain/Keystore.
class MemorySecureStore implements SecureStore {
  final _values = <String, String>{};

  @override
  Future<String?> get(String key) async => _values[key];

  @override
  Future<void> set(String key, String value) async => _values[key] = value;

  @override
  Future<void> delete(String key) async => _values.remove(key);
}

void reply(Map<String, Object?> body) => stdout.writeln(jsonEncode(body));

Future<void> main() async {
  await initialize(libraryPath: Platform.environment['TN_DART_LIB']);
  TrafficNetworkClient? client;
  var events = 0;

  final lines = stdin.transform(utf8.decoder).transform(const LineSplitter());
  await for (final line in lines) {
    final request = jsonDecode(line) as Map<String, Object?>;
    switch (request['op']) {
      case 'new':
        try {
          final hosted = request['hostSecureStore'] == true;
          final created = await TrafficNetworkClient.create(
            jsonDecode(request['options'] as String) as Map<String, Object?>,
            secureStore: hosted ? MemorySecureStore() : null,
          );
          created.events.listen((_) => events += 1);
          client = created;
          reply({'ok': true});
        } on TrafficNetworkException catch (error) {
          reply({
            'error': {'code': error.code, 'message': error.message},
          });
        }
      case 'call':
        reply({
          'result': await client!.callRaw(
            request['method'] as String,
            request['args'] as String,
          ),
        });
      case 'events':
        reply({'count': events});
      case 'free':
        await client?.close();
        client = null;
        reply({'ok': true});
        await stdout.flush();
        exit(0);
      default:
        reply({
          'error': {'code': 'internal', 'message': 'unknown op'},
        });
    }
  }
}
