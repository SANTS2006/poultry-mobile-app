import { useAppStore } from '../state/store';
import { Banner } from './banner';

/** Always-visible honesty about the connection and unsent records, at the top of every screen. */
export function StatusBanners() {
  const sync = useAppStore((s) => s.sync);
  const online = sync ? sync.online : true;
  const attention = sync ? sync.conflict + sync.rejected + sync.blocked : 0;
  const waiting = sync ? sync.pending + sync.syncing : 0;
  return (
    <>
      {!online ? <Banner tone="warn">Offline — you can keep recording. Records are saved on this phone and sent when you are back online.</Banner> : null}
      {attention > 0 ? <Banner tone="danger">{attention} record{attention === 1 ? '' : 's'} need your attention (open More → Sync).</Banner> : null}
      {online && waiting > 0 ? <Banner tone="info">Sending {waiting} saved record{waiting === 1 ? '' : 's'}…</Banner> : null}
    </>
  );
}
