import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { describeError } from '../../lib/errors';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useApp } from '../../state/app';
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
  const sync = useAppStore((s) => s.sync);
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { void services.engine.list().then((all) => setItems(all.slice().reverse())); }, [services]);
  useEffect(() => { load(); }, [load, sync]);

  const attention = items.filter((i) => ['conflict', 'rejected', 'blocked'].includes(i.status));
  const waiting = items.filter((i) => ['pending', 'syncing'].includes(i.status));
  const done = items.filter((i) => i.status === 'synced');

  async function syncNow() {
    setBusy(true);
    try { await services.engine.sync(); } catch (e) { Alert.alert('Could not sync', describeError(e)); } finally { setBusy(false); load(); }
  }

  const Item = ({ i }: { i: OutboxItem }) => (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}><Text bold>{TITLE[i.type] ?? i.type}</Text><Badge tone={STATUS[i.status].tone} label={STATUS[i.status].label} /></Row>
      <Text muted>{summarize(i)}</Text>
      <Text size="small" muted>Saved {formatDateTime(i.createdAt)}{i.attempts ? ` · ${i.attempts} attempt${i.attempts === 1 ? '' : 's'}` : ''}</Text>
      {i.lastError?.message ? <InlineError message={i.lastError.message} /> : null}
      {['conflict', 'rejected', 'blocked'].includes(i.status) ? (
        <Row style={{ flexWrap: 'wrap' }}>
          <Button title="Try again" variant="secondary" small onPress={() => void services.engine.resolve(i.clientId, 'retry').then(load).catch((e) => Alert.alert('Could not retry', describeError(e)))} />
          <Button title="Discard" variant="danger" small onPress={() => Alert.alert('Discard this record?', 'It will be removed from this phone and never sent. This cannot be undone.', [
            { text: 'Keep it', style: 'cancel' },
            { text: 'Discard', style: 'destructive', onPress: () => void services.engine.resolve(i.clientId, 'discard').then(load).catch((e) => Alert.alert('Could not discard', describeError(e))) },
          ])} />
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
        <Button title="Sync now" onPress={() => void syncNow()} busy={busy || !!sync?.syncing_now} />
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
