import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Modal, Pressable, View, useWindowDimensions } from 'react-native';
import { Button, Text } from './components';
import { GlassSurface } from './glass';
import { errorHaptic, successHaptic, warnHaptic } from './haptics';
import { Icon, type IconName } from './icon';
import { radius, space, useColors } from './theme';

export type DialogTone = 'info' | 'success' | 'warn' | 'danger';
export interface DialogAction<V> { label: string; value: V; variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }
export interface DialogOptions<V> { title: string; message?: string; tone?: DialogTone; icon?: IconName; actions: DialogAction<V>[] }

const TONE_ICON: Record<DialogTone, IconName> = { info: 'information-circle', success: 'checkmark-circle', warn: 'warning', danger: 'alert-circle' };

/**
 * The centred card used for confirmations and small forms: an icon in the colour of the message, a title, a short explanation and
 * clearly separated buttons. A floating glass card on iOS. Taps outside it close it (calling `onClose`).
 */
export function DialogShell({ visible, onClose, tone = 'info', icon, title, message, children, dismissable = true }: {
  visible: boolean; onClose: () => void; tone?: DialogTone; icon?: IconName; title: string; message?: string; children?: ReactNode; dismissable?: boolean;
}) {
  const c = useColors();
  const { width } = useWindowDimensions();
  const [enter] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!visible) return;
    if (process.env.JEST_WORKER_ID !== undefined) enter.setValue(1); // tests: no animation timers
    else { enter.setValue(0); Animated.spring(enter, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 6 }).start(); }
    if (tone === 'danger') errorHaptic(); else if (tone === 'warn') warnHaptic(); else if (tone === 'success') successHaptic();
  }, [visible, enter, tone]);
  const fg = { info: c.info, success: c.ok, warn: c.warn, danger: c.danger }[tone];
  const bg = { info: c.infoSoft, success: c.okSoft, warn: c.warnSoft, danger: c.dangerSoft }[tone];
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={dismissable ? onClose : undefined} statusBarTranslucent>
      <Pressable accessibilityLabel="Close dialog" onPress={dismissable ? onClose : undefined} style={{ flex: 1, backgroundColor: c.overlay, alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
        <Animated.View accessibilityViewIsModal style={{ width: Math.min(360, width - space.xl * 2), opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] }}>
          <Pressable onPress={() => undefined}>
            <GlassSurface solid radius={radius.lg + 8} style={{ padding: space.xl, gap: space.lg, alignItems: 'stretch' }}>
              <View style={{ alignItems: 'center', gap: space.md }}>
                <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon ?? TONE_ICON[tone]} size={34} color={fg} /></View>
                <Text variant="title" accessibilityRole="header" style={{ textAlign: 'center' }}>{title}</Text>
                {message ? <Text color={c.textSecondary} style={{ textAlign: 'center' }}>{message}</Text> : null}
              </View>
              {children}
            </GlassSurface>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

interface Ask { <V>(o: DialogOptions<V>): Promise<V | null> }
interface DialogApi {
  /** Any set of buttons; resolves with the chosen value, or null when dismissed. */
  ask: Ask;
  /** Yes/no. Resolves true only for the confirm button. */
  confirm(o: { title: string; message?: string; tone?: DialogTone; confirmLabel?: string; cancelLabel?: string; destructive?: boolean }): Promise<boolean>;
  /** One-button notice (errors, "done" messages). */
  notify(o: { title: string; message?: string; tone?: DialogTone; okLabel?: string }): Promise<void>;
}
const Ctx = createContext<DialogApi | null>(null);

/** Replaces the system alert everywhere: one look, works the same on iOS and Android, and returns promises. */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<{ o: DialogOptions<unknown>; resolve: (v: unknown) => void } | null>(null);
  const queue = useRef<{ o: DialogOptions<unknown>; resolve: (v: unknown) => void }[]>([]);

  const next = useCallback(() => { setCurrent(queue.current.shift() ?? null); }, []);
  const ask = useCallback(<V,>(o: DialogOptions<V>) => new Promise<V | null>((resolve) => {
    const item = { o: o as DialogOptions<unknown>, resolve: resolve as (v: unknown) => void };
    setCurrent((cur) => { if (cur) { queue.current.push(item); return cur; } return item; });
  }), []);
  const close = useCallback((value: unknown) => { current?.resolve(value); next(); }, [current, next]);

  const api = useMemo<DialogApi>(() => ({
    ask,
    confirm: async (o) => (await ask<boolean>({
      title: o.title, message: o.message, tone: o.tone ?? (o.destructive ? 'danger' : 'info'),
      actions: [{ label: o.confirmLabel ?? 'Confirm', value: true, variant: o.destructive ? 'danger' : 'primary' }, { label: o.cancelLabel ?? 'Cancel', value: false, variant: 'ghost' }],
    })) === true,
    notify: async (o) => { await ask<true>({ title: o.title, message: o.message, tone: o.tone ?? 'info', actions: [{ label: o.okLabel ?? 'OK', value: true }] }); },
  }), [ask]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <DialogShell visible={!!current} onClose={() => close(null)} tone={current?.o.tone} icon={current?.o.icon} title={current?.o.title ?? ''} message={current?.o.message}>
        <View style={{ gap: space.sm }}>
          {current?.o.actions.map((a) => <Button key={a.label} pill title={a.label} variant={a.variant ?? 'primary'} onPress={() => close(a.value)} />)}
        </View>
      </DialogShell>
    </Ctx.Provider>
  );
}

export function useDialog(): DialogApi {
  const d = useContext(Ctx);
  if (!d) throw new Error('useDialog must be used inside <DialogProvider>');
  return d;
}
