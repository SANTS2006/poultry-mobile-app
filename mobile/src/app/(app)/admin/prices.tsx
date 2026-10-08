import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Unit } from '../../../api/types';
import { describeError } from '../../../lib/errors';
import { formatDateTime, formatMoney } from '../../../lib/format';
import { positiveMoney, required, useForm } from '../../../lib/validation';
import { useEndpoints } from '../../../state/app';
import { Button, Card, ErrorView, Field, Loading, Screen, SectionTitle, Segmented, Text } from '../../../ui/components';
import { ReasonModal } from '../../../ui/reason-modal';
import { useToast } from '../../../ui/toast';

const UNITS: { value: Unit; label: string }[] = [{ value: 'CARTON', label: 'Carton (360)' }, { value: 'CRATE', label: 'Crate (30)' }, { value: 'EGG', label: 'Single egg' }];

/** Prices are append-only: a new price closes the old one; past sales keep the price they were sold at. */
export default function Prices() {
  const api = useEndpoints();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'prices'], queryFn: () => api.prices() });
  const [unit, setUnit] = useState<Unit>('CRATE');
  const form = useForm({ amount: '' }, { amount: [required('Enter the new price.'), positiveMoney('price')] });
  const [asking, setAsking] = useState(false);
  const current = (u: Unit) => q.data?.find((p) => p.unit === u && p.effectiveTo === null);

  async function save(reason: string) {
    try {
      await api.setPrice(unit, form.values.amount.trim(), reason);
      setAsking(false); form.reset();
      await qc.invalidateQueries({ queryKey: ['admin', 'prices'] });
      toast.show('Price saved. New sales use it straight away.');
    } catch (e) { setAsking(false); toast.show(describeError(e), 'error'); }
  }

  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /> : null}
      {UNITS.map((u) => <Card key={u.value}><Text muted>{u.label}</Text><Text size="title" bold>{current(u.value) ? formatMoney(current(u.value)!.amount) : 'No price set'}</Text></Card>)}
      <SectionTitle>Set a new price</SectionTitle>
      <Segmented value={unit} onChange={setUnit} options={UNITS} />
      <Field label="New price" icon="pricetag-outline" {...form.field('amount')} keyboardType="decimal-pad" />
      <Button title="Change price" onPress={() => { if (form.submit()) setAsking(true); }} />
      <SectionTitle>History</SectionTitle>
      {q.data?.slice(0, 15).map((p) => <Card key={p.id}><Text bold>{p.unit.toLowerCase()} · {formatMoney(p.amount)}</Text><Text size="small" muted>from {formatDateTime(p.effectiveFrom)}{p.reason ? ` · ${p.reason}` : ''}</Text></Card>)}
      <ReasonModal visible={asking} title={`Change ${unit.toLowerCase()} price?`} message="The reason is saved in the audit log." confirmLabel="Change price" onCancel={() => setAsking(false)} onConfirm={save} />
    </Screen>
  );
}
