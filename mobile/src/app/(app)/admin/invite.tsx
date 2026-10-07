import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { describeError } from '../../../lib/errors';
import { useEndpoints } from '../../../state/app';
import { Button, Card, Field, InlineError, Loading, Screen, Segmented, Text } from '../../../ui/components';
import { useToast } from '../../../ui/toast';

export default function Invite() {
  const api = useEndpoints();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api.admin.roles() });
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!role) return setError('Choose a role.');
    setBusy(true); setError(null);
    try {
      await api.admin.invite({ email: email.trim(), fullName: fullName.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}), roleCodes: [role] });
      await qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast.show(`Invitation sent to ${email.trim()}`);
      router.back();
    } catch (e) { setError(describeError(e)); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <Field label="Full name" value={fullName} onChangeText={setFullName} autoCapitalize="words" />
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoCorrect={false} />
      <Field label="Phone (optional)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      {roles.isLoading ? <Loading /> : <Segmented label="Role" value={role} onChange={setRole} options={(roles.data ?? []).map((r) => ({ value: r.code, label: r.name }))} />}
      <Card tone="info"><Text size="small">Give people only the role they need. Production staff cannot see money; sales staff cannot see expenses. Owners and administrators must use two-step sign-in.</Text></Card>
      <InlineError message={error} />
      <Button title="Send invitation" onPress={() => void send()} busy={busy} />
    </Screen>
  );
}
