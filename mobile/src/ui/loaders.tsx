import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';
import { create } from 'zustand';
import { Icon } from './icon';
import { GlassSurface } from './glass';
import { Text } from './text-lite';
import { radius, space, useColors } from './theme';

/** The native driver does not exist in the test runner (Jest sets JEST_WORKER_ID), where the animations just run on the JS thread. */
const NATIVE = process.env.JEST_WORKER_ID === undefined;

/** Phone setting "reduce motion": loaders then fade gently instead of bouncing. */
function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (live) setReduce(v); }).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => { live = false; sub.remove(); };
  }, []);
  return reduce;
}

/** One looping value from 0 to 1 and back, for the loaders. */
function useLoop(duration: number, delay = 0): Animated.Value {
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!NATIVE) return undefined; // tests: no endless timers
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(delay),
      Animated.timing(v, { toValue: 1, duration, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE }),
      Animated.timing(v, { toValue: 0, duration, easing: Easing.in(Easing.quad), useNativeDriver: NATIVE }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [v, duration, delay]);
  return v;
}

/**
 * The app's own loading animation: an egg that bounces and wobbles over a shadow that squashes as it lands.
 * With "reduce motion" on it simply breathes.
 */
export function EggSpinner({ size = 44, label = 'Loading' }: { size?: number; label?: string }) {
  const c = useColors();
  const reduce = useReduceMotion();
  const hop = useLoop(380);
  const wobble = useLoop(760);
  const lift = size * 0.55;
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label} style={{ alignItems: 'center', justifyContent: 'flex-end', height: size + lift, width: size * 1.6 }}>
      <Animated.View style={{ transform: reduce ? [] : [{ translateY: hop.interpolate({ inputRange: [0, 1], outputRange: [0, -lift] }) }, { rotate: wobble.interpolate({ inputRange: [0, 1], outputRange: ['-12deg', '12deg'] }) }], opacity: reduce ? hop.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) : 1 }}>
        <Icon name="egg" size={size} color={c.accent} />
      </Animated.View>
      <Animated.View style={{ width: size * 0.9, height: size * 0.16, borderRadius: size, backgroundColor: c.text, opacity: hop.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.06] }), transform: [{ scaleX: reduce ? 1 : hop.interpolate({ inputRange: [0, 1], outputRange: [1, 0.55] }) }] }} />
    </View>
  );
}

/** Three pulsing dots: used inside buttons while they work. */
export function DotsLoader({ color, size = 7 }: { color: string; size?: number }) {
  const a = useLoop(280, 0);
  const b = useLoop(280, 120);
  const d = useLoop(280, 240);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', alignItems: 'center', gap: size * 0.7, height: size * 2 }}>
      {[a, b, d].map((v, i) => (
        <Animated.View key={i} style={{ width: size, height: size, borderRadius: size, backgroundColor: color, opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }), transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1.15] }) }] }} />
      ))}
    </View>
  );
}

/** A centred loader with a caption, for screens that have nothing to show yet. */
export function BrandLoading({ label = 'Loading' }: { label?: string }) {
  const c = useColors();
  return (
    <View style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xl }}>
      <EggSpinner label={label} />
      <Text variant="caption" color={c.textSecondary}>{label}…</Text>
    </View>
  );
}

/* ───────── full-screen "working…" overlay (signing out, saving something that must not be interrupted) ───────── */

interface BusyState { message: string | null; show(message: string): void; hide(): void }
export const useBusyOverlay = create<BusyState>((set) => ({ message: null, show: (message) => set({ message }), hide: () => set({ message: null }) }));

/** Shows the overlay while `work` runs, and keeps it up at least `minMs` so it never just flashes. */
export async function withBusyOverlay<T>(message: string, work: () => Promise<T>, minMs = 900): Promise<T> {
  const started = Date.now();
  useBusyOverlay.getState().show(message);
  try {
    return await work();
  } finally {
    const left = minMs - (Date.now() - started);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    useBusyOverlay.getState().hide();
  }
}

/** Mounted once at the root. Blocks touches while visible. */
export function BusyOverlay() {
  const message = useBusyOverlay((s) => s.message);
  if (!message) return null;
  return <BusyCard message={message} />;
}

function BusyCard({ message }: { message: string }) {
  const c = useColors();
  const [fade] = useState(() => new Animated.Value(0));
  useEffect(() => { Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: NATIVE }).start(); }, [fade]);
  return (
    <Animated.View accessibilityViewIsModal accessibilityLiveRegion="polite" style={[StyleSheet.absoluteFill, { opacity: fade, backgroundColor: c.overlay, alignItems: 'center', justifyContent: 'center', zIndex: 1000, elevation: 1000 }]}>
      <GlassSurface solid radius={radius.lg + 4} style={{ paddingVertical: space.xl, paddingHorizontal: space.xxl, alignItems: 'center', gap: space.md, minWidth: 220 }}>
        <EggSpinner size={48} label={message} />
        <Text variant="bodyStrong" style={{ textAlign: 'center' }}>{message}</Text>
      </GlassSurface>
    </Animated.View>
  );
}
