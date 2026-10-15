import { useRouter, usePathname } from 'expo-router';
import { useEffect } from 'react';
import { isLive } from '../../lib/chat/call-machine';
import { useCallStore } from '../../state/call-store';

/** Shows the call screen whenever a call is ringing or live, and takes it away when the call is over. Mounted once inside the signed-in area. */
export function CallPresenter() {
  const router = useRouter();
  const path = usePathname();
  const phase = useCallStore((s) => s.call.phase);
  useEffect(() => {
    const active = isLive(phase) || phase === 'ended';
    if (active && path !== '/call') router.push('/call' as never);
    else if (!active && path === '/call') { if (router.canGoBack()) router.back(); else router.replace('/' as never); }
  }, [phase, path, router]);
  return null;
}
