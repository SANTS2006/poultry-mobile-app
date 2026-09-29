import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { io } from 'socket.io-client';
import { createEndpoints, type Endpoints } from '../api/endpoints';
import { API_URL, CONFIG_ERROR } from '../config';
import { shouldLock } from '../lib/app-lock';
import { biometricsAvailable } from '../services/biometrics';
import { getServices, refreshReference, type Services } from '../services/container';
import { configureForegroundNotifications, registerForPush, routeForNotification } from '../services/push';
import { RealtimeClient, type SocketFactory } from '../services/realtime';
import { AuthRequiredError, HttpError } from '../sync/types';
import { BootError, BootSplash } from '../ui/boot';
import { useAppStore } from './store';

interface AppContextValue { services: Services; api: Endpoints; queryClient: QueryClient }
const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('useApp must be used inside <AppProvider>');
  return v;
}
export const useEndpoints = (): Endpoints => useApp().api;

const BIOMETRIC_PREF = 'pref.biometricLock';

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Show what we already have while offline instead of a spinner; realtime and refetch-on-reconnect bring it up to date.
        networkMode: 'offlineFirst',
        retry: (count, e) => !(e instanceof AuthRequiredError) && !(e instanceof HttpError && e.status >= 400 && e.status < 500) && count < 2,
      },
      mutations: { networkMode: 'online' },
    },
  });
}

/** Boots the encrypted database, restores the session, and keeps realtime, push and offline sync running while signed in. */
export function AppProvider({ children }: { children: ReactNode }) {
  const [ctx, setCtx] = useState<AppContextValue | null>(null);
  const [bootError, setBootError] = useState<string | null>(CONFIG_ERROR);
  const router = useRouter();
  const store = useAppStore;

  useEffect(() => {
    if (CONFIG_ERROR) return;
    let cancelled = false;
    const unsubs: (() => void)[] = [];
    (async () => {
      try {
        configureForegroundNotifications();
        const services = await getServices();
        const queryClient = makeQueryClient();
        const api = createEndpoints(services.api);
        if (cancelled) return;

        let realtime: RealtimeClient | null = null;
        let stopAuto: (() => void) | null = null;

        const stopLive = () => { realtime?.stop(); realtime = null; stopAuto?.(); stopAuto = null; };
        const startLive = async () => {
          stopLive();
          const user = services.session.user;
          if (!user) return;
          realtime = new RealtimeClient({
            url: API_URL, factory: io as unknown as SocketFactory, getToken: () => services.tokens.getAccessToken(), permissions: () => services.session.user?.permissions ?? [],
            onInvalidate: (keys) => keys.forEach((k) => void queryClient.invalidateQueries({ queryKey: k })),
            onSessionEnded: () => { void services.session.sessionEnded(); },
            onStatus: (s) => store.getState().setRealtime(s),
          });
          realtime.start();
          stopAuto = services.engine.startAutoSync();
          void refreshReference(services);
          void registerForPush(api, false); // never prompts at start-up; the Settings screen asks explicitly
          void services.engine.resumeAfterLogin().catch(() => undefined);
        };

        unsubs.push(services.session.subscribe(({ status, user }) => {
          store.getState().setSession(status, user);
          if (status === 'signed_in') void startLive();
          else { stopLive(); if (status === 'signed_out') queryClient.clear(); }
        }));
        unsubs.push(services.engine.subscribe((e) => {
          if (e.type === 'summary') store.getState().setSync(e.summary);
          if (e.type === 'auth_required') void services.session.sessionEnded();
          if (e.type === 'synced') for (const k of ['production', 'sales', 'customers', 'expenses', 'inventory', 'dashboard', 'payments']) void queryClient.invalidateQueries({ queryKey: [k] });
        }));
        void services.engine.summary().then((s) => store.getState().setSync(s));

        const pref = await services.secure.get(BIOMETRIC_PREF);
        const canBio = pref === '1' && (await biometricsAvailable());
        store.getState().setBiometricLock(canBio);

        await services.session.restore();
        if (canBio && services.session.status === 'signed_in') store.getState().setLocked(shouldLock({ enabled: true, backgroundedAt: null, now: Date.now(), coldStart: true }));
        if (cancelled) return;
        setCtx({ services, api, queryClient });
        unsubs.push(() => stopLive());
      } catch (e) {
        if (!cancelled) setBootError(e instanceof Error ? e.message : 'The app could not start.');
      }
    })();
    return () => { cancelled = true; unsubs.forEach((u) => u()); };
  }, [store]);

  // biometric lock when returning from the background
  const backgroundedAt = useRef<number | null>(null);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      const st = store.getState();
      if (s === 'background' || s === 'inactive') { backgroundedAt.current ??= Date.now(); return; }
      if (s === 'active') {
        if (st.status === 'signed_in' && shouldLock({ enabled: st.biometricLock, backgroundedAt: backgroundedAt.current, now: Date.now() })) st.setLocked(true);
        backgroundedAt.current = null;
      }
    });
    return () => sub.remove();
  }, [store]);

  // opening a notification: go to the screen it refers to (details are loaded through the authenticated API)
  useEffect(() => {
    const open = (r: Notifications.NotificationResponse | null) => {
      if (!r || store.getState().status !== 'signed_in') return;
      const data = r.notification.request.content.data as { notificationId?: string; entityType?: string | null; entityId?: string | null } | undefined;
      if (data?.notificationId && ctx) void ctx.api.notifications.opened(data.notificationId).catch(() => undefined);
      router.push(routeForNotification(data) as never);
    };
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [ctx, router, store]);

  const value = useMemo(() => ctx, [ctx]);
  if (bootError) return <BootError message={bootError} />;
  if (!value) return <BootSplash />;
  return <AppContext.Provider value={value}><QueryClientProvider client={value.queryClient}>{children}</QueryClientProvider></AppContext.Provider>;
}
