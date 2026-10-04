// Runs the bundled native library inside a real Android app on an emulator,
// against the scripted server (conformance/mock-server.mjs) — the one thing
// building the app cannot show. CI creates the app the way
// docs/integration-flutter.md says and adds this test to it.
//
//     flutter test integration_test --dart-define=TN_NODE=http://10.0.2.2:18997/…
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:trafficnetwork_flutter/trafficnetwork_flutter.dart';

const node = String.fromEnvironment('TN_NODE');

/// A secret store kept in memory - stands in for the Keystore.
class MemorySecureStore implements SecureStore {
  final values = <String, String>{};

  @override
  Future<String?> get(String key) async => values[key];

  @override
  Future<void> set(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the bundled library loads and a client syncs', (tester) async {
    expect(node, isNotEmpty, reason: 'pass --dart-define=TN_NODE=<mock instance url>');
    await initialize();
    expect(libraryVersion(), isNotEmpty);

    final support = await getApplicationSupportDirectory();
    final client = await TrafficNetworkClient.create({
      'storagePath': '${support.path}/tn-${DateTime.now().microsecondsSinceEpoch}',
      'discovery': false,
      'nodes': [node],
      'credentials': {
        'type': 'client',
        'clientId': 'example',
        'clientSecret': 'example',
      },
    });
    try {
      await client.updatePosition(52.52, 13.405);
      final report = await client.sync();
      expect(report['ok'], isTrue, reason: '$report');
      expect(await client.getNearby(52.52, 13.405, 2000), isA<List<Object?>>());
      final id = await client.submitReport('accident', 52.52, 13.405);
      expect(id, isNotNull);
      expect((await client.sync())['ok'], isTrue);
      expect((await client.version())['libraryVersion'], libraryVersion());
    } finally {
      await client.close();
    }
  });

  testWidgets('a secret store implemented in Dart is called by the library', (tester) async {
    await initialize();
    final support = await getApplicationSupportDirectory();
    final store = MemorySecureStore();
    final client = await TrafficNetworkClient.create({
      'storagePath': '${support.path}/tn-hosted-${DateTime.now().microsecondsSinceEpoch}',
      'discovery': false,
      'nodes': [node],
      'credentials': {
        'type': 'app',
        'appClientId': 'example-app',
        'appClientSecret': 'example-secret',
      },
    }, secureStore: store);
    try {
      await client.updatePosition(52.52, 13.405);
      final report = await client.sync();
      expect(report['ok'], isTrue, reason: '$report');
      // The device registered itself and the library put its credential and
      // signing key into the store the app gave it.
      expect(store.values.keys, containsAll(['device.clientId', 'device.clientSecret']));
    } finally {
      await client.close();
    }
  });
}
