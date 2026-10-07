import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ProblemList } from '../../../features/ProblemList';
import { addDays, eggBreakdown, formatDate, formatInt } from '../../../lib/format';
import { eggsOf } from '../../../lib/money';
import { useReference } from '../../../queries/hooks';
import { useRecord, useSavedToast } from '../../../queries/use-record';
import { Button, Card, Field, Loading, Row, Screen, Segmented, Stepper, Text } from '../../../ui/components';

const SHIFTS = [{ value: 'MORNING', label: 'Morning' }, { value: 'AFTERNOON', label: 'Afternoon' }, { value: 'EVENING', label: 'Evening' }] as const;

/** Works offline: the record is stored on the phone and sent when a connection is available. Totals are computed by the server too. */
export default function NewProduction() {
  const router = useRouter();
  const ref = useReference();
  const rec = useRecord('production.create');
  const saved = useSavedToast();
  const [coopId, setCoopId] = useState<string | null>(null);
  const [shift, setShift] = useState<(typeof SHIFTS)[number]['value'] | null>(null);
  const [daysBack, setDaysBack] = useState(0);
  const [cartons, setCartons] = useState(0);
  const [crates, setCrates] = useState(0);
  const [eggs, setEggs] = useState(0);
  const [notes, setNotes] = useState('');
  const [errs, setErrs] = useState<{ coop?: string; shift?: string }>({});

  const unitEggs = useMemo(() => Object.fromEntries((ref.data?.units ?? []).map((u) => [u.code, u.eggsPerUnit])), [ref.data]);
  const lines = [{ unit: 'CARTON', quantity: cartons }, { unit: 'CRATE', quantity: crates }, { unit: 'EGG', quantity: eggs }];
  const total = eggsOf(lines, { CARTON: 360, CRATE: 30, EGG: 1, ...unitEggs });
  const date = addDays(ref.today, -daysBack);
  const coops = ref.data?.coops ?? [];

  async function save() {
    const next = { coop: coopId ? undefined : 'Choose the coop these eggs came from.', shift: shift ? undefined : 'Choose the morning, afternoon or evening collection.' };
    setErrs(next);
    if (next.coop || next.shift || !coopId || !shift) return;
    const entries = lines.filter((l) => l.quantity > 0).map((l) => ({ unit: l.unit, quantity: l.quantity }));
    const result = await rec.submit({
      coopId, shift, productionDate: date, entries: entries.length ? entries : [{ unit: 'EGG', quantity: 0 }], ...(notes.trim() ? { notes: notes.trim() } : {}),
    });
    if (result) {
      saved(result, `${formatInt(total)} eggs recorded`);
      router.back();
    }
  }

  if (ref.loading && !ref.data) return <Screen><Loading label="Loading coops" /></Screen>;
  if (!coops.length) return <Screen><Card tone="warn"><Text bold>No coops found</Text><Text>Connect to the internet once so the app can load your coops, or ask a manager to add them.</Text></Card></Screen>;

  return (
    <Screen>
      <Segmented label="Coop" error={errs.coop} value={coopId} onChange={(v) => { setCoopId(v); setErrs((e) => ({ ...e, coop: undefined })); }} options={coops.map((c) => ({ value: c.id, label: c.name }))} />
      <Segmented label="Shift" error={errs.shift} value={shift} onChange={(v) => { setShift(v); setErrs((e) => ({ ...e, shift: undefined })); }} options={SHIFTS.map((s) => ({ value: s.value, label: s.label }))} />
      <Row style={{ justifyContent: 'space-between' }}>
        <Text bold>{formatDate(date)}</Text>
        <Row>
          <Button title="Earlier" variant="secondary" small onPress={() => setDaysBack((d) => Math.min(30, d + 1))} />
          <Button title="Later" variant="secondary" small disabled={daysBack === 0} onPress={() => setDaysBack((d) => Math.max(0, d - 1))} />
        </Row>
      </Row>
      <Stepper label="Cartons (360 eggs)" value={cartons} onChange={setCartons} max={1000} />
      <Stepper label="Crates (30 eggs)" value={crates} onChange={setCrates} max={10000} />
      <Stepper label="Single eggs" value={eggs} onChange={setEggs} max={100000} />
      <Card tone="info">
        <Text muted>Total</Text>
        <Text size="title" bold>{formatInt(total)} eggs</Text>
        <Text muted>{eggBreakdown(total)}</Text>
      </Card>
      <Field label="Notes (optional)" value={notes} onChangeText={setNotes} multiline maxLength={500} />
      <ProblemList problems={rec.problems} error={rec.error} />
      <Button title="Save production" onPress={() => void save()} busy={rec.busy} />
    </Screen>
  );
}
