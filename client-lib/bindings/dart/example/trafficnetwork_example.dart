// Minimal Dart example - see client-lib/docs/integration-flutter.md. The same
// calls as inside a Flutter app, in a plain Dart program so it can be run
// (and is, in CI) against a server:
//
//     TN_DART_LIB=/path/to/libtrafficnetwork_dart.so \
//     TN_NODE=http://localhost:3000 TN_CLIENT_ID=... TN_CLIENT_SECRET=... \
//         dart run example/trafficnetwork_example.dart

import 'dart:io';

import 'package:trafficnetwork/trafficnetwork.dart';

const berlinLat = 52.52;
const berlinLng = 13.405;

Future<void> main() async {
  // Loads the native library; in a Flutter app the build puts it where the
  // loader looks, so no path is needed there.
  await initialize(libraryPath: Platform.environment['TN_DART_LIB']);
  print('native library ${libraryVersion()}');

  // A directory this client keeps its database and secrets in; reuse the same
  // one next time and it carries on where it left off.
  final directory = Directory.systemTemp.createTempSync('trafficnetwork-example');

  final client = await TrafficNetworkClient.create({
    'storagePath': directory.path,
    'discovery': false,
    'nodes': [Platform.environment['TN_NODE'] ?? 'http://localhost:3000'],
    'credentials': {
      'type': 'client',
      'clientId': Platform.environment['TN_CLIENT_ID'],
      'clientSecret': Platform.environment['TN_CLIENT_SECRET'],
    },
  });

  try {
    await client.updatePosition(berlinLat, berlinLng); // which map tiles to watch
    final report = await client.sync(); //                  fetch what is around
    print('sync ok: ${report['ok']}, pending writes: ${report['pendingWrites']}');

    // Reads never touch the network - they answer from the local copy.
    print('speed limit here: ${await client.getSpeedLimitAt(berlinLat, berlinLng)}');
    final nearby = await client.getNearby(berlinLat, berlinLng, 2000);
    print('${nearby.length} things within 2 km');

    // Queued locally first (getNearby shows it at once), sent by the next sync.
    final id = await client.submitReport('accident', berlinLat, berlinLng);
    final sent = await client.sync();
    print('queued report $id; sync ok: ${sent['ok']}');
  } finally {
    await client.close();
    directory.deleteSync(recursive: true);
  }
}
