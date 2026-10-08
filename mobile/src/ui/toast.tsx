import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from './icon';
import { Text } from './text-lite';
import { elevation, radius, space, useColors } from './theme';

type Kind = 'success' | 'error' | 'info';
interface ToastCtx { show(message: string, kind?: Kind): void }
const Ctx = createContext<ToastCtx>({ show: () => undefined });

/** Non-blocking confirmation ("Sale recorded") that fades in at the bottom, is announced to screen readers, and dismisses itself or on tap. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [t, setT] = useState<{ id: number; message: string; kind: Kind } | null>(null);
  const [anim] = useState(() => new Animated.Value(0));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true }).start(({ finished }) => { if (finished) setT(null); });
  }, [anim]);

  const show = useCallback((message: string, kind: Kind = 'success') => {
    if (timer.current) clearTimeout(timer.current);
    setT({ id: Date.now(), message, kind });
    AccessibilityInfo.announceForAccessibility(message);
    timer.current = setTimeout(hide, kind === 'error' ? 5000 : 2800);
  }, [hide]);

  useEffect(() => { if (t) Animated.timing(anim, { toValue: 1, duration: 200, useNativeDriver: true }).start(); }, [t, anim]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const value = useMemo(() => ({ show }), [show]);
  const bg = t?.kind === 'error' ? c.danger : t?.kind === 'info' ? c.text : c.primary;
  const fg = t?.kind === 'info' ? c.bg : t?.kind === 'error' ? c.onDanger : c.onPrimary;
  return (
    <Ctx.Provider value={value}>
      {children}
      {t ? (
        <Animated.View pointerEvents="box-none" style={{ position: 'absolute', left: space.lg, right: space.lg, bottom: insets.bottom + 72, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }}>
          <Pressable accessibilityRole="alert" onPress={hide}>
            <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: bg, borderRadius: radius.md, paddingVertical: space.md, paddingHorizontal: space.lg }, elevation.float]}>
              <Icon name={t.kind === 'error' ? 'alert-circle' : t.kind === 'info' ? 'notifications' : 'checkmark-circle'} size="md" color={fg} />
              <Text variant="bodyStrong" color={fg} style={{ flex: 1 }}>{t.message}</Text>
            </View>
          </Pressable>
        </Animated.View>
      ) : null}
    </Ctx.Provider>
  );
}

export const useToast = (): ToastCtx => useContext(Ctx);
