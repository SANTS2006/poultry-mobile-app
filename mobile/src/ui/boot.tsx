import { View } from 'react-native';
import { BrandMark } from './brand';
import { Text } from './components';
import { Icon } from './icon';
import { EggSpinner } from './loaders';
import { space, useColors } from './theme';

export function BootSplash() {
  // Fixed brand colours (same as the native splash) so the loading screen is visible in light and dark mode alike.
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Starting" style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0F5132', gap: space.xl }}>
      <View style={{ width: 88, height: 88, borderRadius: 26, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="egg" size={50} color="#E0A100" />
      </View>
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
