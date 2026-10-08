import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import type { Unit } from '../../../api/types';
import { describeError } from '../../../lib/errors';
import { minLength, required, useForm } from '../../../lib/validation';
import { newId } from '../../../services/platform';
import { useEndpoints } from '../../../state/app';
import { Button, Card, Field, InlineError, Screen, Segmented, Stepper, Text } from '../../../ui/components';
import { useToast } from '../../../ui/toast';

type Kind = 'DAMAGE' | 'LOSS' | 'USAGE' | 'INCREASE' | 'DECREASE';

/** Online-only by design: stock corrections are audited manager actions and must never be queued blindly. */
export default function AdjustStock() {
  const api = useEndpoints();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>('DAMAGE');
  const [unit, setUnit] = useState<Unit>('EGG');
  const [qty, setQty] = useState(0);
  const form = useForm({ reason: '' }, { reason: [required('Please explain why.'), minLength(5, 'Please explain in at least 5 characters.')] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId] = useState(newId); // retrying the same form never applies it twice

  async function save() {
    const ok = form.submit();
    if (qty < 1) return setError('Enter how many.');
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      await api.inventory.adjust({
        type: kind === 'INCREASE' || kind === 'DECREASE' ? 'ADJUSTMENT' : kind, ...(kind === 'INCREASE' || kind === 'DECREASE' ? { direction: kind } : {}),
        unit, quantity: qty, reason: form.values.reason.trim(), clientId,
      });
      await qc.invalidateQueries();
      toast.show('Stock updated');
      router.back();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Card tone="warn"><Text bold>This changes stock and is written to the audit log with your name and reason.</Text></Card>
      <Segmented<Kind> label="What happened?" value={kind} onChange={setKind} options={[
        { value: 'DAMAGE', label: 'Broken / damaged' }, { value: 'LOSS', label: 'Lost / stolen' }, { value: 'USAGE', label: 'Own use' },
        { value: 'INCREASE', label: 'Count: add' }, { value: 'DECREASE', label: 'Count: remove' },
      ]} />
      <Segmented<Unit> label="Unit" value={unit} onChange={setUnit} options={[{ value: 'EGG', label: 'Eggs' }, { value: 'CRATE', label: 'Crates' }, { value: 'CARTON', label: 'Cartons' }]} />
      <Stepper label="How many" value={qty} onChange={setQty} />
      <Field label="Reason" icon="chatbox-ellipses-outline" {...form.field('reason')} maxLength={300} />
      {error ? <InlineError message={error} /> : null}
      <Button title="Save adjustment" onPress={() => void save()} busy={busy} />
    </Screen>
  );
}
