import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ProblemList } from '../../../features/ProblemList';
import { addDays, formatDate, formatMoney, isMoneyInput } from '../../../lib/format';
import { fromCents, toCents } from '../../../lib/money';
import { useReference } from '../../../queries/hooks';
import { useRecord, useSavedToast } from '../../../queries/use-record';
import { maxLength, minLength, positiveMoney, quantity as quantityRule, required, useForm } from '../../../lib/validation';
import { Button, Card, Field, Loading, Row, Screen, Segmented, Text } from '../../../ui/components';

const METHODS = [{ value: 'CASH', label: 'Cash' }, { value: 'MOBILE_MONEY', label: 'Mobile money' }, { value: 'BANK_TRANSFER', label: 'Bank' }, { value: 'OTHER', label: 'Other' }] as const;

export default function NewExpense() {
  const router = useRouter();
  const ref = useReference();
  const rec = useRecord('expense.create');
  const saved = useSavedToast();
  const [category, setCategory] = useState<string | null>(null);
  const [byQty, setByQty] = useState(false);
  const form = useForm(
    { description: '', total: '', quantity: '', unitCost: '', notes: '' },
    {
      description: [required('Say what the money was spent on.'), minLength(3, 'Add a few more words about what it was for.'), maxLength(300)],
      total: byQty ? [] : [required('Enter the total amount.'), positiveMoney('total')],
      quantity: byQty ? [required('Enter the quantity.'), quantityRule('quantity')] : [],
      unitCost: byQty ? [required('Enter the price per unit.'), positiveMoney('price')] : [],
      notes: [maxLength(500)],
    },
  );
  const { description, total, quantity, unitCost, notes } = form.values;
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [method, setMethod] = useState<(typeof METHODS)[number]['value']>('CASH');
  const [daysBack, setDaysBack] = useState(0);
  const [catError, setCatError] = useState<string | null>(null);

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
    const ok = form.submit();
    if (!category) { setCatError('Choose what kind of expense this is.'); return; }
    if (!ok) return;
    const payload: Record<string, unknown> = {
      categoryCode: category, description: description.trim(), expenseDate: date, paymentMethod: method,
      ...(supplierId ? { supplierId } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    if (byQty) { payload.quantity = quantity.trim(); payload.unitCost = unitCost.trim(); } else payload.total = total.trim();
    const result = await rec.submit(payload);
    if (result) {
      saved(result, 'Expense recorded');
      router.back();
    }
  }

  if (ref.loading && !ref.data) return <Screen><Loading label="Loading categories" /></Screen>;
  return (
    <Screen>
      <Segmented label="Category" error={catError} value={category} onChange={(v) => { setCategory(v); setCatError(null); }} options={categories.map((c) => ({ value: c.code, label: c.name }))} />
      <Field label="What was it for?" icon="document-text-outline" {...form.field('description')} maxLength={300} />
      <Segmented value={byQty ? 'q' : 't'} onChange={(v) => setByQty(v === 'q')} options={[{ value: 't', label: 'Total amount' }, { value: 'q', label: 'Quantity × price' }]} />
      {byQty ? (
        <>
          <Field label="Quantity" {...form.field('quantity')} keyboardType="decimal-pad" />
          <Field label="Price per unit" icon="cash-outline" {...form.field('unitCost')} keyboardType="decimal-pad" />
          <Card tone="info"><Text muted>Total</Text><Text size="title" bold>{computed ? formatMoney(computed, ref.currency) : '—'}</Text></Card>
        </>
      ) : <Field label="Total amount" icon="cash-outline" {...form.field('total')} keyboardType="decimal-pad" />}
      {suppliers.length ? <Segmented label="Supplier (optional)" value={supplierId} onChange={(v) => setSupplierId(supplierId === v ? null : v)} options={suppliers.map((s) => ({ value: s.id, label: s.name }))} /> : null}
      <Segmented label="Paid by" value={method} onChange={setMethod} options={METHODS.map((m) => ({ value: m.value, label: m.label }))} />
      <Row style={{ justifyContent: 'space-between' }}>
        <Text bold>{formatDate(date)}</Text>
        <Row>
          <Button title="Earlier" variant="secondary" small onPress={() => setDaysBack((d) => Math.min(60, d + 1))} />
          <Button title="Later" variant="secondary" small disabled={daysBack === 0} onPress={() => setDaysBack((d) => Math.max(0, d - 1))} />
        </Row>
      </Row>
      <Field label="Notes (optional)" {...form.field('notes')} multiline maxLength={500} />
      <ProblemList problems={rec.problems} error={rec.error} />
      <Button title="Save expense" onPress={() => void save()} busy={rec.busy} />
    </Screen>
  );
}
