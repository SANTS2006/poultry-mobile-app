import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { describeError } from '../../../lib/errors';
import { email, fullName, phone, required, useForm } from '../../../lib/validation';
import { useEndpoints } from '../../../state/app';
import { Button, Card, Field, InlineError, Loading, Screen, Segmented, Text } from '../../../ui/components';
import { useToast } from '../../../ui/toast';

export default function Invite() {
  const api = useEndpoints();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api.admin.roles() });
  const form = useForm(
    { fullName: '', email: '', phone: '' },
    { fullName: [required('Enter the person’s full name.'), fullName], email: [required('Enter their email address.'), email], phone: [phone] },
  );
  const [role, setRole] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const ok = form.submit();
    if (!role) setRoleError('Choose a role.');
    if (!ok || !role) return;
    setBusy(true); setError(null);
    try {
      const { fullName: n, email: e, phone: p } = form.values;
      const res = await api.admin.invite({ email: e.trim(), fullName: n.trim(), ...(p.trim() ? { phone: p.trim() } : {}), roleCodes: [role] });
      await qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      if (res.emailSent) toast.show(`Invitation emailed to ${e.trim()}`);
      else toast.show('Account created, but the email could not be sent. Open the user and choose “Resend invitation”.', 'error');
      router.back();
    } catch (err) { setError(describeError(err)); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <Field label="Full name" icon="person-outline" {...form.field('fullName')} autoCapitalize="words" textContentType="name" maxLength={100} />
      <Field label="Email address" icon="mail-outline" {...form.field('email')} autoCapitalize="none" keyboardType="email-address" autoCorrect={false} textContentType="emailAddress" />
      <Field label="Phone (optional)" icon="call-outline" {...form.field('phone')} keyboardType="phone-pad" textContentType="telephoneNumber" maxLength={30} />
      {roles.isLoading ? <Loading /> : <Segmented label="Role" error={roleError} value={role} onChange={(v) => { setRole(v); setRoleError(null); }} options={(roles.data ?? []).map((r) => ({ value: r.code, label: r.name }))} />}
      <Card tone="info"><Text size="small">We email them a temporary password (valid 72 hours) with their role and how to sign in. They choose their own password the first time they sign in. Give people only the role they need: production staff cannot see money; sales staff cannot see expenses. Owners and administrators must use two-step sign-in.</Text></Card>
      <InlineError message={error} />
      <Button title="Send invitation" icon="paper-plane-outline" onPress={() => void send()} busy={busy} />
    </Screen>
  );
}
