// Minimal React Native example - see client-lib/docs/integration-react-native.md.
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import {
  TrafficNetworkClient,
  libraryVersion,
} from '@trafficnetwork/react-native';

// Replace these with a Trafficnetwork server and a credential of scope `client`.
const NODE = 'https://node.example.org';
const CLIENT_ID = 'REPLACE_WITH_CLIENT_ID';
const CLIENT_SECRET = 'REPLACE_WITH_CLIENT_SECRET';

const BERLIN = { lat: 52.52, lng: 13.405 };

/** Connects, syncs, and describes what is around Berlin. */
async function lookAround(): Promise<string> {
  const options = {
    // The app's private directory: the client keeps its database and secrets here.
    storagePath: `${DocumentDirectoryPath}/trafficnetwork`,
    discovery: false,
    nodes: [NODE],
    credentials: { type: 'client', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
  };
  const client = new TrafficNetworkClient(JSON.stringify(options), undefined);

  // One API call: the `ok` value of the result, or an Error for an `error`.
  // `callAsync` runs on the library's own threads, so a sync that waits for
  // the network never freezes the UI.
  async function ask(method: string, args: object = {}): Promise<any> {
    const envelope = JSON.parse(await client.callAsync(method, JSON.stringify(args)));
    if (envelope.error) {
      throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
    }
    return envelope.ok;
  }

  try {
    await ask('updatePosition', BERLIN); // which map tiles to watch
    const sync = await ask('sync'); //      fetch what is around
    const limit = await ask('getSpeedLimitAt', BERLIN); // local, instant
    const nearby = await ask('getNearby', { ...BERLIN, radiusMeters: 2000 }); // local, instant
    return (
      `library ${libraryVersion()}\n` +
      `sync ok: ${sync.ok}\n` +
      `speed limit here: ${JSON.stringify(limit)}\n` +
      `${nearby.items.length} things within 2 km`
    );
  } finally {
    // Releases the client; its data stays on disk.
    client.uniffiDestroy();
  }
}

export default function App() {
  const [text, setText] = useState('Working...');
  useEffect(() => {
    lookAround().then(setText, (error) => setText(`Failed: ${error.message}`));
  }, []);
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text>{text}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
});
