import { View } from 'react-native';
import { Text } from './components';
import { radius, space, useColors } from './theme';

/** Minimal bar chart (no chart library): values are plain numbers, bars scale to the maximum. Accessible summary text is provided by the caller. */
export function BarChart({ data, height = 72, label }: { data: { label: string; value: number }[]; height?: number; label: string }) {
  const c = useColors();
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <View accessible accessibilityLabel={label} style={{ gap: space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height }}>
        {data.map((d, i) => (
          <View key={`${d.label}-${i}`} style={{ flex: 1, height: Math.max(2, Math.round((d.value / max) * height)), backgroundColor: i === data.length - 1 ? c.primary : c.primarySoft, borderRadius: radius.sm / 2 }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text size="small" muted>{data[0]?.label}</Text>
        <Text size="small" muted>{data[data.length - 1]?.label}</Text>
      </View>
    </View>
  );
}
