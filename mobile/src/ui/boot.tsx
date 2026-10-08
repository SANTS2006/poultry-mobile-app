import { View } from 'react-native';
import { BrandMark } from './brand';
import { Text } from './components';
import { EggSpinner } from './loaders';
import { space, useColors } from './theme';

export function BootSplash() {
  const c = useColors();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Starting" style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg, gap: space.xl }}>
      <BrandMark size={80} />
      <EggSpinner label="Starting" />
    </View>
  );
}

export function BootError({ message }: { message: string }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg, padding: space.xl, gap: space.md }}>
      <BrandMark size={64} />
      <Text variant="title" style={{ textAlign: 'center' }}>The app can’t start</Text>
      <Text muted style={{ textAlign: 'center' }}>{message}</Text>
      <Text variant="caption" muted style={{ textAlign: 'center' }}>This is a configuration problem with this build. Please contact your administrator.</Text>
    </View>
  );
}
