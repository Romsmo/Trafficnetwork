// Minimal Flutter example - see client-lib/docs/integration-flutter.md.
//
// In a new Flutter app (`flutter create my_app`), add the package
// (`flutter pub add trafficnetwork_flutter --path <this repository>/client-lib/bindings/flutter`)
// and replace lib/main.dart with this file.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:trafficnetwork_flutter/trafficnetwork_flutter.dart';

// Replace these with a Trafficnetwork server and a credential of scope `client`.
const node = 'https://node.example.org';
const clientId = 'REPLACE_WITH_CLIENT_ID';
const clientSecret = 'REPLACE_WITH_CLIENT_SECRET';

const berlinLat = 52.52;
const berlinLng = 13.405;

/// Connects, syncs, and describes what is around Berlin.
Future<String> lookAround() async {
  // Loads the native library that the plugin bundled with the app.
  await initialize();

  // The app's private directory: the client keeps its database and secrets here.
  final support = await getApplicationSupportDirectory();
  final client = await TrafficNetworkClient.create({
    'storagePath': '${support.path}${Platform.pathSeparator}trafficnetwork',
    'discovery': false,
    'nodes': [node],
    'credentials': {
      'type': 'client',
      'clientId': clientId,
      'clientSecret': clientSecret,
    },
  });
  try {
    await client.updatePosition(berlinLat, berlinLng); // which map tiles to watch
    final sync = await client.sync(); //                  fetch what is around
    final limit = await client.getSpeedLimitAt(berlinLat, berlinLng); // local, instant
    final nearby = await client.getNearby(berlinLat, berlinLng, 2000); // local, instant
    return 'sync ok: ${sync['ok']}\nspeed limit here: $limit\n'
        '${nearby.length} things within 2 km';
  } finally {
    await client.close();
  }
}

void main() => runApp(const ExampleApp());

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('Trafficnetwork example')),
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: FutureBuilder<String>(
            future: lookAround(),
            builder: (context, snapshot) {
              if (snapshot.hasError) return Text('Failed: ${snapshot.error}');
              return Text(snapshot.data ?? 'Working...');
            },
          ),
        ),
      ),
    );
  }
}
