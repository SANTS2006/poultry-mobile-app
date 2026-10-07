import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { businessToday } from '../lib/format';
import { refreshReference } from '../services/container';
import { useApp, useEndpoints } from '../state/app';
import { useAppStore } from '../state/store';
import type { CachedReference } from '../sync';

/**
 * Reference data (coops, units, prices, customers, stock…) for forms. Served from the on-device cache instantly and refreshed in the
 * background, so recording screens work with no signal.
 */
export function useReference() {
  const { services } = useApp();
  const [data, setData] = useState<CachedReference | null>(services.refData.current);
  const [loading, setLoading] = useState(!services.refData.current);
  const refresh = async () => {
    const r = await refreshReference(services);
    setData(r);
    setLoading(false);
  };
  useEffect(() => {
    let live = true;
    void refreshReference(services).then((r) => { if (live) { setData(r); setLoading(false); } });
    return () => { live = false; };
  }, [services]);
  const tz = data?.settings?.['business.timezone'] as string | undefined;
  return { data, loading, refresh, today: businessToday(tz), currency: (data?.settings?.['business.currency'] as string | undefined) ?? '' };
}

export function useDashboard() {
  const api = useEndpoints();
  return useQuery({ queryKey: ['dashboard'], queryFn: () => api.dashboard() });
}

export function useUnreadCount() {
  const api = useEndpoints();
  const online = useAppStore((s) => (s.sync ? s.sync.online : true));
  return useQuery({ queryKey: ['notifications', 'unread'], queryFn: () => api.notifications.unread(), enabled: online, refetchInterval: 120_000 });
}

export function useRefreshAll() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries(), [qc]);
}
