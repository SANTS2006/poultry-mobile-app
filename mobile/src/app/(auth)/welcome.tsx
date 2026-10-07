import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Dimensions, ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../../state/app';
import { BrandMark } from '../../ui/brand';
import { Button, Text } from '../../ui/components';
import { Icon, type IconName } from '../../ui/icon';
import { radius, space, useColors } from '../../ui/theme';
import { WELCOME_KEY } from './login';

const SLIDES: { icon: IconName; title: string; body: string }[] = [
  { icon: 'egg-outline', title: 'Record in seconds', body: 'Log each collection by coop and shift. Totals, trays and stock update for you.' },
  { icon: 'cloud-offline-outline', title: 'Works without signal', body: 'No network on the farm? Keep recording. Everything is saved on your phone and sent when you’re back online.' },
  { icon: 'shield-checkmark-outline', title: 'Safe and accountable', body: 'Every change is tracked. Each person only sees what their role allows.' },
];

/** Shown once, before the first sign-in. Skippable at any time. */
export default function Welcome() {
  const c = useColors();
  const router = useRouter();
  const { services } = useApp();
  const ref = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  const width = Dimensions.get('window').width;
  const last = page === SLIDES.length - 1;

  const finish = async () => { await services.secure.set(WELCOME_KEY, '1'); router.replace('/login'); };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => setPage(Math.round(e.nativeEvent.contentOffset.x / width));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ alignItems: 'flex-end', paddingHorizontal: space.lg, paddingTop: space.sm, minHeight: 52 }}>
        {!last ? <Button title="Skip" variant="ghost" small onPress={() => void finish()} /> : null}
      </View>
      <ScrollView ref={ref} horizontal pagingEnabled showsHorizontalScrollIndicator={false} onMomentumScrollEnd={onScroll} style={{ flex: 1 }}>
        {SLIDES.map((s) => (
          <View key={s.title} style={{ width, paddingHorizontal: space.xxl, alignItems: 'center', justifyContent: 'center', gap: space.xl }}>
            <BrandMark size={56} />
            <View style={{ width: 168, height: 168, borderRadius: radius.lg + 24, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={s.icon} size={84} color={c.primary} />
            </View>
            <View style={{ gap: space.sm, alignItems: 'center' }}>
              <Text variant="title" accessibilityRole="header" style={{ textAlign: 'center' }}>{s.title}</Text>
              <Text muted style={{ textAlign: 'center' }}>{s.body}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
      <View style={{ padding: space.xl, gap: space.lg }}>
        <View accessibilityLabel={`Page ${page + 1} of ${SLIDES.length}`} style={{ flexDirection: 'row', justifyContent: 'center', gap: space.sm }}>
          {SLIDES.map((s, i) => <View key={s.title} style={{ width: i === page ? 22 : 8, height: 8, borderRadius: 4, backgroundColor: i === page ? c.primary : c.borderStrong }} />)}
        </View>
        <Button title={last ? 'Get started' : 'Next'} icon={last ? 'checkmark' : 'arrow-forward'} onPress={() => (last ? void finish() : ref.current?.scrollTo({ x: width * (page + 1), animated: true }))} />
      </View>
    </SafeAreaView>
  );
}
