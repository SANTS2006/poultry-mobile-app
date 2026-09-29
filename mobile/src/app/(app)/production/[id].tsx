import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { describeError, isHttp } from '../../../lib/errors';
import { eggBreakdown, formatDate, formatDateTime, formatInt } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { useCan } from '../../../state/store';
import { ReasonModal } from '../../../ui/reason-modal';
import { Badge, Button, Card, ErrorView, Field, Loading, Row, Screen, SectionTitle, Stepper, Text } from '../../../ui/components';
import type { Unit } from '../../../api/types';

const UNIT_LABEL: Record<Unit, string> = { CARTON: 'Cartons', CRATE: 'Crates', EGG: 'Single eggs' };

export default function ProductionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useEndpoints();
  const router = useRouter();
  const qc = useQueryClient();
  const canCorrect = useCan('production.update');
  const canVoid = useCan('production.delete');
  const q = useQuery({ queryKey: ['production', 'detail', id], queryFn: () => api.production.get(id) });
  const [editing, setEditing] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [qty, setQty] = useState<Record<Unit, number>>({ CARTON: 0, CRATE: 0, EGG: 0 });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = q.data;

  function startEdit() {
    if (!r) return;
    setQty({ CARTON: 0, CRATE: 0, EGG: 0, ...Object.fromEntries(r.entries.map((e) => [e.unit, e.quantity])) });
    setReason(''); setError(null); setEditing(true);
  }

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['production'] });
      await qc.invalidateQueries({ queryKey: ['inventory'] });
      await qc.invalidateQueries({ queryKey: ['dashboard'] });
      setEditing(false);
      Alert.alert(done);
    } catch (e) {
      setError(isHttp(e, 409) ? `${describeError(e)} Pull down to reload the latest version.` : describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (!r) return <Screen><ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /></Screen>;

  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}><Text size="title" bold>{formatInt(r.totalEggs)} eggs</Text>{r.status === 'VOIDED' ? <Badge tone="danger" label="Voided" /> : r.needsReview ? <Badge tone="warn" label="Needs review" /> : null}</Row>
        <Text muted>{eggBreakdown(r.totalEggs)}</Text>
        <Text>{r.coop.name} · {r.shift.toLowerCase()} · {formatDate(r.productionDate)}</Text>
        {r.entries.map((e) => <Text key={e.unit} muted>{UNIT_LABEL[e.unit]}: {formatInt(e.quantity)}</Text>)}
        {r.notes ? <Text>“{r.notes}”</Text> : null}
        <Text size="small" muted>Recorded {formatDateTime(r.createdAt)} · version {r.version}</Text>
      </Card>

      {r.status === 'ACTIVE' && !editing ? (
        <Row style={{ flexWrap: 'wrap' }}>
          {canCorrect ? <Button title="Correct quantities" variant="secondary" onPress={startEdit} /> : null}
          {canVoid ? <Button title="Void record" variant="danger" onPress={() => setVoiding(true)} /> : null}
        </Row>
      ) : null}

      {editing ? (
        <>
          <SectionTitle>Correct this record</SectionTitle>
          <Text muted>The difference is posted to the stock ledger and the change is written to the audit log with your reason.</Text>
          {(['CARTON', 'CRATE', 'EGG'] as Unit[]).map((u) => <Stepper key={u} label={UNIT_LABEL[u]} value={qty[u]} onChange={(n) => setQty({ ...qty, [u]: n })} />)}
          <Field label="Reason for the correction" value={reason} onChangeText={setReason} maxLength={300} error={error} />
          <Button title="Save correction" busy={busy} onPress={() => {
            const entries = (Object.keys(qty) as Unit[]).filter((u) => qty[u] > 0).map((u) => ({ unit: u, quantity: qty[u] }));
            if (reason.trim().length < 5) return setError('Please give a reason (at least 5 characters).');
            void run(() => api.production.correct(r.id, { entries: entries.length ? entries : [{ unit: 'EGG', quantity: 0 }], version: r.version, reason: reason.trim() }), 'Correction saved');
          }} />
          <Button title="Cancel" variant="ghost" onPress={() => setEditing(false)} />
        </>
      ) : error ? <Text color="#B42318">{error}</Text> : null}
      <ReasonModal
        visible={voiding} title="Void this record?" message="The eggs are taken back out of stock. The record stays in the history and the reason goes to the audit log." confirmLabel="Void" danger
        onCancel={() => setVoiding(false)}
        onConfirm={async (text) => { setVoiding(false); await run(() => api.production.void(r.id, text).then(() => router.back()), 'Record voided'); }}
      />
    </Screen>
  );
}
