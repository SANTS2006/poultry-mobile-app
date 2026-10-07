import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert } from 'react-native';
import { ProblemList } from '../../../features/ProblemList';
import { addDays, formatDate, formatMoney, isMoneyInput } from '../../../lib/format';
import { fromCents, toCents } from '../../../lib/money';
import { useReference } from '../../../queries/hooks';
import { useRecord } from '../../../queries/use-record';
import { Button, Card, Field, Loading, Row, Screen, Segmented, Text } from '../../../ui/components';

const METHODS = [{ value: 'CASH', label: 'Cash' }, { value: 'MOBILE_MONEY', label: 'Mobile money' }, { value: 'BANK_TRANSFER', label: 'Bank' }, { value: 'OTHER', label: 'Other' }] as const;

export default function NewExpense() {
  const router = useRouter();
  const ref = useReference();
  const rec = useRecord('expense.create');
  const [category, setCategory] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [byQty, setByQty] = useState(false);
  const [total, setTotal] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [method, setMethod] = useState<(typeof METHODS)[number]['value']>('CASH');
  const [daysBack, setDaysBack] = useState(0);
  const [notes, setNotes] = useState('');

  const categories = ref.data?.expenseCategories ?? [];
  const suppliers = ref.data?.suppliers ?? [];
  const date = addDays(ref.today, -daysBack);

  const computed = useMemo(() => {
    if (!byQty || !/^\d{1,9}(\.\d{1,3})?$/.test(quantity) || !isMoneyInput(unitCost)) return null;
    // quantity has up to 3 decimals: work in thousandths of a cent-safe integer math
    const [w, f = ''] = quantity.split('.');
    const milli = BigInt(w) * 1000n + BigInt(f.padEnd(3, '0'));
    const cents = (milli * toCents(unitCost) + 500n) / 1000n;
    return fromCents(cents);
  }, [byQty, quantity, unitCost]);

  async function save() {
    if (!category) return Alert.alert('Choose a category', 'What kind of expense is this?');
    const payload: Record<string, unknown> = {
      categoryCode: category, description: description.trim(), expenseDate: date, paymentMethod: method,
      ...(supplierId ? { supplierId } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    if (byQty) { payload.quantity = quantity.trim(); payload.unitCost = unitCost.trim(); } else payload.total = total.trim();
    const result = await rec.submit(payload);
    if (result) {
      Alert.alert(result.sentNow ? 'Expense recorded' : 'Saved on this phone', result.sentNow ? description.trim() : 'It will be sent when you are back online.');
      router.back();
    }
  }

  if (ref.loading && !ref.data) return <Screen><Loading label="Loading categories" /></Screen>;
  return (
    <Screen>
      <Segmented label="Category" value={category} onChange={setCategory} options={categories.map((c) => ({ value: c.code, label: c.name }))} />
      <Field label="What was it for?" value={description} onChangeText={setDescription} maxLength={300} />
      <Segmented value={byQty ? 'q' : 't'} onChange={(v) => setByQty(v === 'q')} options={[{ value: 't', label: 'Total amount' }, { value: 'q', label: 'Quantity × price' }]} />
      {byQty ? (
        <>
          <Field label="Quantity" value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad" />
          <Field label="Price per unit" value={unitCost} onChangeText={setUnitCost} keyboardType="decimal-pad" />
          <Card tone="info"><Text muted>Total</Text><Text size="title" bold>{computed ? formatMoney(computed, ref.currency) : '—'}</Text></Card>
        </>
      ) : <Field label="Total amount" value={total} onChangeText={setTotal} keyboardType="decimal-pad" />}
      {suppliers.length ? <Segmented label="Supplier (optional)" value={supplierId} onChange={(v) => setSupplierId(supplierId === v ? null : v)} options={suppliers.map((s) => ({ value: s.id, label: s.name }))} /> : null}
      <Segmented label="Paid by" value={method} onChange={setMethod} options={METHODS.map((m) => ({ value: m.value, label: m.label }))} />
      <Row style={{ justifyContent: 'space-between' }}>
        <Text bold>{formatDate(date)}</Text>
        <Row>
          <Button title="Earlier" variant="secondary" small onPress={() => setDaysBack((d) => Math.min(60, d + 1))} />
          <Button title="Later" variant="secondary" small disabled={daysBack === 0} onPress={() => setDaysBack((d) => Math.max(0, d - 1))} />
        </Row>
      </Row>
      <Field label="Notes (optional)" value={notes} onChangeText={setNotes} multiline maxLength={500} />
      <ProblemList problems={rec.problems} error={rec.error} />
      <Button title="Save expense" onPress={() => void save()} busy={rec.busy} />
    </Screen>
  );
}
