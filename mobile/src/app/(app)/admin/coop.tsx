import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import type { Coop } from '../../../api/types';
import { describeError } from '../../../lib/errors';
import { maxLength, required, useForm, wholeNumber, type Rule } from '../../../lib/validation';
import { refreshReference } from '../../../services/container';
import { useApp, useEndpoints } from '../../../state/app';
import { Button, ErrorView, Field, InlineError, Loading, Screen, Text } from '../../../ui/components';
import { space } from '../../../ui/theme';
import { useToast } from '../../../ui/toast';

const capacityRange: Rule = (v) => (!v.trim() || (Number(v) >= 1 && Number(v) <= 1_000_000) ? null : 'Enter a number between 1 and 1,000,000.');

/** Add a coop, or edit/retire an existing one (when opened with ?id=). */
export default function CoopForm() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const api = useEndpoints();
  const q = useQuery({ queryKey: ['admin', 'coops'], queryFn: () => api.coops(), enabled: !!id });
  if (id && q.isLoading) return <Screen><Loading /></Screen>;
  const existing = id ? q.data?.find((c) => c.id === id) : undefined;
  if (id && !existing) return <Screen><ErrorView message={q.error ? describeError(q.error) : 'This coop no longer exists.'} onRetry={() => void q.refetch()} /></Screen>;
  return <Form coop={existing} />;
}

function Form({ coop }: { coop?: Coop }) {
  const api = useEndpoints();
  const { services } = useApp();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const form = useForm(
    { name: coop?.name ?? '', capacity: coop?.capacity ? String(coop.capacity) : '', notes: coop?.notes ?? '' },
    { name: [required('Give the coop a name, e.g. “Coop 3”.'), maxLength(60)], capacity: [wholeNumber('number of birds'), capacityRange], notes: [maxLength(300)] },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function done(message: string) {
    await qc.invalidateQueries({ queryKey: ['admin', 'coops'] });
    await qc.invalidateQueries({ queryKey: ['dashboard'] });
    void refreshReference(services); // recording screens pick the change up straight away
    toast.show(message);
    router.back();
  }

  async function save() {
    if (!form.submit()) return;
    const { name, capacity, notes } = form.values;
    setBusy(true); setError(null);
    try {
      if (coop) await api.updateCoop(coop.id, { name: name.trim(), capacity: capacity.trim() ? Number(capacity) : null, notes: notes.trim() || null });
      else await api.createCoop({ name: name.trim(), ...(capacity.trim() ? { capacity: Number(capacity) } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) });
      await done(coop ? 'Coop updated' : `${name.trim()} added`);
    } catch (e) { setError(describeError(e)); } finally { setBusy(false); }
  }

  function toggleActive() {
    if (!coop) return;
    const retire = coop.active !== false;
    Alert.alert(retire ? `Retire ${coop.name}?` : `Reactivate ${coop.name}?`, retire
      ? 'It will no longer appear on the daily recording checklist. Its past records stay exactly as they are.'
      : 'It will appear on the daily recording checklist again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: retire ? 'Retire' : 'Reactivate', style: retire ? 'destructive' : 'default', onPress: () => {
        setBusy(true);
        api.updateCoop(coop.id, { active: !retire }).then(() => done(retire ? 'Coop retired' : 'Coop reactivated')).catch((e) => setError(describeError(e))).finally(() => setBusy(false));
      } },
    ]);
  }

  return (
    <Screen>
      <View style={{ gap: space.lg }}>
        <Field label="Coop name" icon="home-outline" {...form.field('name')} maxLength={60} autoCapitalize="words" />
        <Field label="Bird capacity (optional)" icon="egg-outline" {...form.field('capacity')} keyboardType="number-pad" maxLength={7} hint="How many birds the house is built for. Used for planning only." />
        <Field label="Notes (optional)" {...form.field('notes')} multiline maxLength={300} />
        <InlineError message={error} />
        <Button title={coop ? 'Save changes' : 'Add coop'} icon="checkmark" onPress={() => void save()} busy={busy} />
        {coop ? (
          <>
            <Button title={coop.active === false ? 'Reactivate this coop' : 'Retire this coop'} variant={coop.active === false ? 'secondary' : 'danger'} onPress={toggleActive} disabled={busy} />
            <Text variant="caption" muted>Retiring keeps all past production records. Coops are never deleted.</Text>
          </>
        ) : null}
      </View>
    </Screen>
  );
}
