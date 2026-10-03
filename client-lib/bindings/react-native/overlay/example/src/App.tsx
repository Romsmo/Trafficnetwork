import { Text, View, StyleSheet } from 'react-native';
import { libraryVersion } from '@trafficnetwork/react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text>Trafficnetwork library {libraryVersion()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
