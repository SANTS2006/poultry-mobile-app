import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ProblemList } from '../../../features/ProblemList';
import { formatMoney, isMoneyInput } from '../../../lib/format';
import { useRecord, useSavedToast } from '../../../queries/use-record';
import { Button, Card, Field, Screen, Segmented, Text } from '../../../ui/components';

const METHODS = [{ value: 'CASH', label: 'Cash' }, { value: 'MOBILE_MONEY', label: 'Mobile money' }, { value: 'BANK_TRANSFER', label: 'Bank' }, { value: 'OTHER', label: 'Other' }] as const;

/** A later payment against a sale (saleId) or a customer's oldest debts (customerId). Works offline like the other records. */
export default function NewPayment() {
  const params = useLocalSearchParams<{ saleId?: string; customerId?: string; owed?: string; label?: string }>();
  const router = useRouter();
  const rec = useRecord('payment.create');
  const saved = useSavedToast();
  const [amount, setAmount] = useState(params.owed ?? '');
  const [method, setMethod] = useState<(typeof METHODS)[number]['value']>('CASH');
  const [reference, setReference] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);

  async function save() {
    if (!isMoneyInput(amount)) { setAmountError('Enter the amount using numbers only, for example 500 or 500.50.'); return; }
    const payload: Record<string, unknown> = { amount: amount.trim(), method, ...(reference.trim() ? { reference: reference.trim() } : {}) };
    if (params.saleId) payload.saleId = params.saleId; else if (params.customerId) payload.customerId = params.customerId;
    const result = await rec.submit(payload);
    if (result) {
      saved(result, `Payment of ${formatMoney(amount)} recorded`);
      router.back();
    }
  }

  return (
    <Screen>
      <Card tone="info">
        <Text bold>{params.saleId ? `Payment for sale ${params.label ?? ''}` : 'Payment from customer'}</Text>
        {params.owed ? <Text muted>Still owed: {formatMoney(params.owed)}</Text> : null}
        {params.customerId ? <Text muted>The payment settles this customer&apos;s oldest unpaid sales first.</Text> : null}
      </Card>
      <Field label="Amount received" icon="cash-outline" value={amount} onChangeText={(t) => { setAmount(t); setAmountError(null); }} error={amountError} keyboardType="decimal-pad" autoFocus />
      <Segmented label="Paid by" value={method} onChange={setMethod} options={METHODS.map((m) => ({ value: m.value, label: m.label }))} />
      <Field label="Reference (optional)" value={reference} onChangeText={setReference} maxLength={100} hint="Mobile-money or bank reference" />
      <ProblemList problems={rec.problems} error={rec.error} />
      <Button title="Record payment" onPress={() => void save()} busy={rec.busy} />
    </Screen>
  );
}
