import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ProblemList } from '../../../features/ProblemList';
import { useRecord, useSavedToast } from '../../../queries/use-record';
import { maxLength, minLength, phone, required, useForm } from '../../../lib/validation';
import { Button, Field, Screen, Segmented } from '../../../ui/components';

export default function NewCustomer() {
  const router = useRouter();
  const rec = useRecord('customer.create');
  const saved = useSavedToast();
  const form = useForm({ name: '', phone: '', address: '' }, { name: [required('Enter the customer’s name.'), minLength(2, 'The name needs at least 2 letters.'), maxLength(100)], phone: [phone], address: [maxLength(300)] });
  const [type, setType] = useState<'REGULAR' | 'WHOLESALE'>('REGULAR');

  async function save() {
    if (!form.submit()) return;
    const { name, phone, address } = form.values;
    const result = await rec.submit({
      name: name.trim(), type, ...(phone.trim() ? { phone: phone.trim() } : {}), ...(address.trim() ? { address: address.trim() } : {}),
    });
    if (result) {
      saved(result, `${form.values.name.trim()} added`);
      router.back();
    }
  }

  return (
    <Screen>
      <Field label="Name" icon="person-outline" {...form.field('name')} autoCapitalize="words" maxLength={100} />
      <Field label="Phone (optional)" icon="call-outline" {...form.field('phone')} keyboardType="phone-pad" maxLength={30} />
      <Segmented label="Type" value={type} onChange={setType} options={[{ value: 'REGULAR', label: 'Regular' }, { value: 'WHOLESALE', label: 'Wholesale' }]} />
      <Field label="Address (optional)" icon="location-outline" {...form.field('address')} multiline maxLength={300} />
      <ProblemList problems={rec.problems} error={rec.error} />
      <Button title="Save customer" onPress={() => void save()} busy={rec.busy} />
    </Screen>
  );
}
