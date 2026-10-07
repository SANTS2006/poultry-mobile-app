import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { ProblemList } from '../../../features/ProblemList';
import { formatInt, formatMoney, isMoneyInput } from '../../../lib/format';
import { eggsOf, previewSale } from '../../../lib/money';
import { useReference } from '../../../queries/hooks';
import { pendingCustomers, useRecord, useSavedToast } from '../../../queries/use-record';
import { useApp } from '../../../state/app';
import { useCan } from '../../../state/store';
import { estimateStockEggs } from '../../../sync';
import { Button, Card, Field, InlineError, ListRow, Loading, Screen, Segmented, Stepper, Text } from '../../../ui/components';
import { space } from '../../../ui/theme';

type Pay = 'FULL' | 'PART' | 'CREDIT';
const METHODS = [{ value: 'CASH', label: 'Cash' }, { value: 'MOBILE_MONEY', label: 'Mobile money' }, { value: 'BANK_TRANSFER', label: 'Bank' }] as const;

/**
 * Works offline. The phone shows an ESTIMATE from cached prices; the server prices the sale itself (the client never sends prices or totals)
 * and may refuse it later, e.g. if stock ran out — such sales wait in Sync for a decision instead of disappearing.
 */
export default function NewSale() {
  const router = useRouter();
  const { services } = useApp();
  const ref = useReference();
  const rec = useRecord('sale.create');
  const saved = useSavedToast();
  const canDiscount = useCan('sales.update');
  const [customer, setCustomer] = useState<{ id?: string; clientId?: string; name: string } | null>(null);
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState<{ clientId: string; name: string }[]>([]);
  const [cartons, setCartons] = useState(0);
  const [crates, setCrates] = useState(0);
  const [eggs, setEggs] = useState(0);
  const [discount, setDiscount] = useState('');
  const [pay, setPay] = useState<Pay>('FULL');
  const [paidNow, setPaidNow] = useState('');
  const [method, setMethod] = useState<(typeof METHODS)[number]['value']>('CASH');
  const [outboxTick, setOutboxTick] = useState(0);
  const [errs, setErrs] = useState<{ items?: string; customer?: string; paid?: string }>({});
  const [unsentStock, setUnsentStock] = useState<number | null>(null);

  useEffect(() => { void pendingCustomers(services).then(setPending); }, [services]);
  useEffect(() => {
    // stock estimate = last known stock + unsent production − unsent sales
    const unitEggs = Object.fromEntries((ref.data?.units ?? []).map((u) => [u.code, u.eggsPerUnit]));
    if (ref.data?.inventory) void services.engine.list().then((all) => setUnsentStock(estimateStockEggs(ref.data!.inventory!.quantityEggs, unitEggs, all)));
  }, [ref.data, services, outboxTick]);

  const price = (unit: string) => ref.data?.prices?.find((p) => p.unit === unit)?.amount;
  const lines = [{ unit: 'CARTON', quantity: cartons }, { unit: 'CRATE', quantity: crates }, { unit: 'EGG', quantity: eggs }];
  const preview = previewSale(lines.map((l) => ({ ...l, unitPrice: price(l.unit) })), canDiscount && isMoneyInput(discount) ? discount : '0');
  const unitEggs = useMemo(() => ({ CARTON: 360, CRATE: 30, EGG: 1, ...Object.fromEntries((ref.data?.units ?? []).map((u) => [u.code, u.eggsPerUnit])) }), [ref.data]);
  const soldEggs = eggsOf(lines, unitEggs);
  const overStock = unsentStock !== null && soldEggs > unsentStock;
  const cur = ref.currency;

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    return (ref.data?.customers ?? []).filter((c) => c.name.toLowerCase().includes(q) || (c.phone ?? '').includes(q)).slice(0, 6);
  }, [search, ref.data]);

  async function save() {
    const items = lines.filter((l) => l.quantity > 0).map((l) => ({ unit: l.unit, quantity: l.quantity }));
    const next = {
      items: items.length ? undefined : 'Enter how many cartons, crates or eggs to sell.',
      customer: pay !== 'FULL' && !customer ? 'Choose a registered customer to sell on credit or take a part payment.' : undefined,
      paid: pay === 'PART' && !isMoneyInput(paidNow) ? 'Enter the amount paid now, for example 500 or 500.50.' : undefined,
    };
    setErrs(next);
    if (next.items || next.customer || next.paid) return;
    const payload: Record<string, unknown> = { items, paymentMethod: method };
    if (customer?.id) payload.customerId = customer.id;
    if (customer?.clientId) payload.customerClientId = customer.clientId;
    if (pay === 'CREDIT') payload.amountPaid = '0';
    if (pay === 'PART') payload.amountPaid = paidNow.trim();
    if (canDiscount && isMoneyInput(discount) && Number(discount) > 0) payload.discount = discount.trim();
    const result = await rec.submit(payload);
    if (result) {
      setOutboxTick((t) => t + 1);
      saved(result, `Sale recorded · about ${formatMoney(preview.total, cur)}`);
      router.back();
    }
  }

  if (ref.loading && !ref.data) return <Screen><Loading label="Loading prices" /></Screen>;

  return (
    <Screen>
      <View style={{ gap: space.sm }}>
        <Text variant="label" muted>Customer</Text>
        <Segmented value={customer ? 'reg' : 'walk'} onChange={(v) => { if (v === 'walk') setCustomer(null); }} options={[{ value: 'walk', label: 'Walk-in' }, { value: 'reg', label: customer ? customer.name : 'Registered customer' }]} />
        {!customer ? (
          <>
            <Field label="Find a customer (name or phone)" value={search} onChangeText={setSearch} autoCorrect={false} />
            {matches.map((c) => <ListRow key={c.id} title={c.name} subtitle={c.phone ?? undefined} onPress={() => { setCustomer({ id: c.id, name: c.name }); setSearch(''); }} />)}
            {pending.map((c) => <ListRow key={c.clientId} title={`${c.name} (new, not sent yet)`} onPress={() => setCustomer({ clientId: c.clientId, name: c.name })} />)}
            <Button title="Add a new customer" variant="ghost" small onPress={() => router.push('/customers/new')} />
          </>
        ) : <Button title={`Remove ${customer.name}`} variant="ghost" small onPress={() => setCustomer(null)} />}
      </View>

      <InlineError message={errs.customer} />

      <Stepper label={`Cartons (360 eggs) ${price('CARTON') ? `· ${formatMoney(price('CARTON'), cur)} each` : ''}`} value={cartons} onChange={setCartons} max={100000} />
      <Stepper label={`Crates (30 eggs) ${price('CRATE') ? `· ${formatMoney(price('CRATE'), cur)} each` : ''}`} value={crates} onChange={setCrates} max={100000} />
      <Stepper label={`Single eggs ${price('EGG') ? `· ${formatMoney(price('EGG'), cur)} each` : ''}`} value={eggs} onChange={setEggs} max={100000} />
      <InlineError message={errs.items} />

      {canDiscount ? <Field label="Discount (optional)" value={discount} onChangeText={setDiscount} keyboardType="decimal-pad" hint="Managers only" /> : null}

      <Card tone="info">
        <Text muted>Estimated total</Text>
        <Text size="big" bold>{preview.missing.length ? '—' : formatMoney(preview.total, cur)}</Text>
        {preview.missing.length ? <Text>No price is known for {preview.missing.join(', ').toLowerCase()} yet. Connect to the internet to load prices.</Text> : <Text size="small" muted>The server sets the final price when the sale is recorded.</Text>}
        <Text muted>{formatInt(soldEggs)} eggs</Text>
      </Card>
      {overStock ? <Card tone="warn"><Text bold>This may be more than the stock we know about</Text><Text>Estimated stock is {formatInt(unsentStock)} eggs. You can still save; if the server cannot cover it, the sale will wait in Sync for your decision.</Text></Card> : null}

      <Segmented label="Payment" value={pay} onChange={(v) => { setPay(v); setErrs((e) => ({ ...e, customer: undefined, paid: undefined })); }} options={[{ value: 'FULL', label: 'Paid in full' }, { value: 'PART', label: 'Part payment' }, { value: 'CREDIT', label: 'On credit' }]} />
      {pay === 'PART' ? <Field label="Amount paid now" icon="cash-outline" value={paidNow} onChangeText={(t) => { setPaidNow(t); setErrs((e) => ({ ...e, paid: undefined })); }} error={errs.paid} keyboardType="decimal-pad" /> : null}
      {pay !== 'CREDIT' ? <Segmented label="Paid by" value={method} onChange={setMethod} options={METHODS.map((m) => ({ value: m.value, label: m.label }))} /> : null}
      {pay !== 'FULL' ? <Text size="small" muted>Credit must be switched on by an administrator and allowed for this customer; otherwise the server will refuse the sale.</Text> : null}

      <ProblemList problems={rec.problems} error={rec.error} />
      <Button title="Save sale" onPress={() => void save()} busy={rec.busy} />
    </Screen>
  );
}
