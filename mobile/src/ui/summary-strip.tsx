import { View } from 'react-native';
import { Text } from './components';
import { radius, space, useColors } from './theme';

/** A row of two to four headline figures above a list ("Today · 7 days · This month"). */
export function SummaryStrip({ items }: { items: { label: string; value: string }[] }) {
  const c = useColors();
  return (
    <View accessibilityRole="summary" style={{ flexDirection: 'row', backgroundColor: c.primarySoft, borderRadius: radius.lg, padding: space.md, gap: space.sm }}>
      {items.map((x) => (
        <View key={x.label} style={{ flex: 1, alignItems: 'center', gap: space.xxs }}>
          <Text variant="heading" color={c.onPrimarySoft} numberOfLines={1} adjustsFontSizeToFit>{x.value}</Text>
          <Text variant="caption" color={c.onPrimarySoft} numberOfLines={1}>{x.label}</Text>
        </View>
      ))}
    </View>
  );
}
