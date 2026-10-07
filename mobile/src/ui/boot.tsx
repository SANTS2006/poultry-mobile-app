import { ActivityIndicator, View } from 'react-native';
import { Text } from './components';
import { space, useColors } from './theme';

export function BootSplash() {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg, gap: space.md }}>
      <ActivityIndicator color={c.primary} size="large" />
      <Text muted>Starting…</Text>
    </View>
  );
}

export function BootError({ message }: { message: string }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg, padding: space.xl, gap: space.md }}>
      <Text size="title" bold>The app cannot start</Text>
      <Text muted style={{ textAlign: 'center' }}>{message}</Text>
      <Text size="small" muted style={{ textAlign: 'center' }}>This is a configuration problem with this build. Please contact your administrator.</Text>
    </View>
  );
}
