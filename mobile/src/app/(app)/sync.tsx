import { useCallback, useEffect, useState } from 'react';
import { describeError } from '../../lib/errors';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useApp } from '../../state/app';
import { useDialog } from '../../ui/dialog';
import { useToast } from '../../ui/toast';
import { useAppStore } from '../../state/store';
import type { OutboxItem } from '../../sync';
import { Badge, Button, Card, InlineError, Row, Screen, SectionTitle, Text } from '../../ui/components';

const TITLE: Record<string, string> = {
  'production.create': 'Production record', 'sale.create': 'Sale', 'expense.create': 'Expense', 'customer.create': 'New customer', 'payment.create': 'Payment',
};

function summarize(i: OutboxItem): string {
  const p = i.payload as Record<string, unknown>;
  switch (i.type) {
    case 'production.create': return `${(p.entries as { unit: string; quantity: number }[] | undefined)?.map((e) => `${e.quantity} ${e.unit.toLowerCase()}`).join(', ') ?? ''} · ${String(p.shift ?? '').toLowerCase()}`;
    case 'sale.create': return (p.items as { unit: string; quantity: number }[] | undefined)?.map((e) => `${e.quantity} ${e.unit.toLowerCase()}`).join(', ') ?? '';
    case 'expense.create': return `${String(p.description ?? '')}`;
    case 'customer.create': return String(p.name ?? '');
    case 'payment.create': return `${String(p.amount ?? '')}`;
    default: return '';
  }
}

const STATUS: Record<string, { label: string; tone: 'info' | 'warn' | 'danger' | 'ok' | 'muted' }> = {
  pending: { label: 'Waiting to send', tone: 'info' }, syncing: { label: 'Sending…', tone: 'info' }, synced: { label: 'Sent', tone: 'ok' },
  conflict: { label: 'Needs a decision', tone: 'warn' }, rejected: { label: 'Refused by server', tone: 'danger' }, blocked: { label: 'Waiting for another record', tone: 'muted' },
};

/**
 * Honest view of what is on this phone and not yet (or not successfully) on the server. Nothing here disappears by itself:
 * records leave only when the server accepted them, or when you explicitly discard them (the discard is logged on the phone).
 */
export default function SyncScreen() {
  const { services } = useApp();
  const dialog = useDialog();
  const toast = useToast();
  const sync = useAppStore((s) => s.sync);
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { void services.engine.list().then((all) => setItems(all.slice().reverse())); }, [services]);
  useEffect(() => { load(); }, [load, sync]);

  const attention = items.filter((i) => ['conflict', 'rejected', 'blocked'].includes(i.status));
  const waiting = items.filter((i) => ['pending', 'syncing'].includes(i.status));
  const done = items.filter((i) => i.status === 'synced');

  /** The Retry buttons: skip the wait between automatic attempts, then say plainly what happened. */
  async function retry(clientId?: string) {
    setBusy(true);
    try {
      const r = await services.engine.retry(clientId);
      load();
      const left = (await services.engine.list({ statuses: ['pending', 'syncing', 'conflict', 'rejected', 'blocked'] })).filter((i) => !clientId || i.clientId === clientId);
      if (r.skipped === 'offline') void dialog.notify({ title: 'You are offline', message: 'The records stay safe on this phone and will be sent when you are back online.', tone: 'warn' });
      else if (r.skipped === 'auth_required') void dialog.notify({ title: 'Sign in again', message: 'Your session ended. Sign in, and the records will be sent.', tone: 'warn' });
      else if (left.length === 0) toast.show(r.synced === 1 ? 'Sent' : `${r.synced} records sent`, 'success');
      else void dialog.notify({ title: r.synced ? `${r.synced} sent, ${left.length} still waiting` : 'Still could not send', message: left[0]?.lastError?.message ?? 'The server did not answer in time. You can retry again in a moment.', tone: 'warn', okLabel: 'OK' });
    } catch (e) { void dialog.notify({ title: 'Could not retry', message: describeError(e), tone: 'danger' }); } finally { setBusy(false); load(); }
  }

  async function syncNow() {
    setBusy(true);
    try { await services.engine.sync(); } catch (e) { void dialog.notify({ title: 'Could not sync', message: describeError(e), tone: 'danger' }); } finally { setBusy(false); load(); }
  }

  const Item = ({ i }: { i: OutboxItem }) => (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}><Text bold>{TITLE[i.type] ?? i.type}</Text><Badge tone={STATUS[i.status].tone} label={STATUS[i.status].label} /></Row>
      <Text muted>{summarize(i)}</Text>
      <Text size="small" muted>Saved {formatDateTime(i.createdAt)}{i.attempts ? ` · ${i.attempts} attempt${i.attempts === 1 ? '' : 's'}` : ''}</Text>
      {i.lastError?.message ? <InlineError message={i.lastError.message} /> : null}
      {['pending', 'syncing'].includes(i.status) ? (
        <Row style={{ flexWrap: 'wrap' }}><Button title="Retry now" icon="refresh" variant="secondary" small onPress={() => void retry(i.clientId)} busy={busy} /></Row>
      ) : null}
      {['conflict', 'rejected', 'blocked'].includes(i.status) ? (
        <Row style={{ flexWrap: 'wrap' }}>
          <Button title="Retry" icon="refresh" variant="secondary" small onPress={() => void retry(i.clientId)} busy={busy} />
          <Button title="Discard" variant="danger" small onPress={() => { void dialog.confirm({ title: 'Discard this record?', message: 'It will be removed from this phone and never sent. This cannot be undone.', confirmLabel: 'Discard', cancelLabel: 'Keep it', destructive: true }).then((ok) => { if (ok) void services.engine.resolve(i.clientId, 'discard').then(load).catch((e) => dialog.notify({ title: 'Could not discard', message: describeError(e), tone: 'danger' })); }); }} />
        </Row>
      ) : null}
    </Card>
  );

  return (
    <Screen refreshing={busy} onRefresh={() => void syncNow()}>
      <Card tone={sync && !sync.online ? 'warn' : undefined}>
        <Text bold>{sync?.online === false ? 'Offline' : 'Online'}</Text>
        <Text muted>Last successful sync: {sync?.lastSyncedAt ? `${timeAgo(sync.lastSyncedAt)} (${formatDateTime(sync.lastSyncedAt)})` : 'never'}</Text>
        <Text muted>{sync ? `${sync.pending + sync.syncing} waiting · ${sync.conflict + sync.rejected + sync.blocked} need attention` : ''}</Text>
        <Button title="Sync now" icon="sync" onPress={() => void syncNow()} busy={busy || !!sync?.syncing_now} />
        {attention.length + waiting.length > 0 ? <Button title={`Retry all (${attention.length + waiting.length})`} icon="refresh" variant="secondary" onPress={() => void retry()} busy={busy} /> : null}
      </Card>
      {attention.length ? <SectionTitle>Needs your attention</SectionTitle> : null}
      {attention.map((i) => <Item key={i.clientId} i={i} />)}
      {waiting.length ? <SectionTitle>Waiting to send</SectionTitle> : null}
      {waiting.map((i) => <Item key={i.clientId} i={i} />)}
      {done.length ? <SectionTitle>Recently sent</SectionTitle> : null}
      {done.slice(0, 20).map((i) => <Item key={i.clientId} i={i} />)}
      {!items.length ? <Text muted>Nothing waiting. Everything recorded on this phone is on the server.</Text> : null}
    </Screen>
  );
}
