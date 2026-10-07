import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ProblemList } from '../../../features/ProblemList';
import { useRecord, useSavedToast } from '../../../queries/use-record';
import { Button, Field, Screen, Segmented } from '../../../ui/components';

export default function NewCustomer() {
  const router = useRouter();
  const rec = useRecord('customer.create');
  const saved = useSavedToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [type, setType] = useState<'REGULAR' | 'WHOLESALE'>('REGULAR');
  const [address, setAddress] = useState('');

  async function save() {
    const result = await rec.submit({
      name: name.trim(), type, ...(phone.trim() ? { phone: phone.trim() } : {}), ...(address.trim() ? { address: address.trim() } : {}),
    });
    if (result) {
      saved(result, `${name.trim()} added`);
      router.back();
    }
  }

  return (
    <Screen>
      <Field label="Name" value={name} onChangeText={setName} autoCapitalize="words" />
      <Field label="Phone (optional)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      <Segmented label="Type" value={type} onChange={setType} options={[{ value: 'REGULAR', label: 'Regular' }, { value: 'WHOLESALE', label: 'Wholesale' }]} />
      <Field label="Address (optional)" value={address} onChangeText={setAddress} multiline />
      <ProblemList problems={rec.problems} error={rec.error} />
      <Button title="Save customer" onPress={() => void save()} busy={rec.busy} />
    </Screen>
  );
}
