import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { describeError } from '../../../../lib/errors';
import { formatDateTime } from '../../../../lib/format';
import { useEndpoints } from '../../../../state/app';
import { useAppStore } from '../../../../state/store';
import { Badge, Button, Card, ErrorView, Loading, Row, Screen, SectionTitle, Segmented, Text } from '../../../../ui/components';
import { ReasonModal } from '../../../../ui/reason-modal';

type Action = 'disable' | 'reactivate' | 'revoke' | 'resetMfa' | 'roles';

/** Every change here needs a written reason, is refused for your own account where that could lock you out, and lands in the audit log. */
export default function UserDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useEndpoints();
  const qc = useQueryClient();
  const me = useAppStore((s) => s.user);
  const q = useQuery({ queryKey: ['admin', 'user', id], queryFn: () => api.admin.user(id) });
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api.admin.roles() });
  const sessions = useQuery({ queryKey: ['admin', 'user', id, 'sessions'], queryFn: () => api.admin.userSessions(id) });
  const [action, setAction] = useState<Action | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const u = q.data;

  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (!u) return <Screen><ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /></Screen>;
  const self = me?.id === u.id;

  async function confirm(reason: string) {
    try {
      if (action === 'disable') await api.admin.disable(id, reason);
      if (action === 'reactivate') await api.admin.reactivate(id, reason);
      if (action === 'revoke') await api.admin.revokeUserSessions(id, reason);
      if (action === 'resetMfa') await api.admin.resetMfa(id, reason);
      if (action === 'roles' && role) await api.admin.setRoles(id, [role], reason);
      setAction(null);
      await qc.invalidateQueries({ queryKey: ['admin'] });
      Alert.alert('Done');
    } catch (e) { setAction(null); Alert.alert('Could not do that', describeError(e)); }
  }

  const TITLE: Record<Action, string> = { disable: 'Disable this account?', reactivate: 'Re-enable this account?', revoke: 'Sign this user out everywhere?', resetMfa: 'Reset two-step sign-in?', roles: 'Change role?' };
  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); void sessions.refetch(); }}>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}><Text size="title" bold>{u.fullName ?? u.email}</Text><Badge tone={u.status === 'ACTIVE' ? 'ok' : 'warn'} label={u.status.toLowerCase()} /></Row>
        <Text muted>{u.email}{u.phone ? ` · ${u.phone}` : ''}</Text>
        <Text>Roles: {u.roles.join(', ').toLowerCase().replace(/_/g, ' ')}</Text>
        <Text muted>Two-step sign-in: {u.mfaEnabled ? 'on' : 'off'} · email {u.emailVerified ? 'verified' : 'not verified'}</Text>
        <Text size="small" muted>Last sign-in: {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'never'}</Text>
      </Card>

      <SectionTitle>Role</SectionTitle>
      <Segmented value={role ?? (u.roles[0] ?? null)} onChange={(v) => { setRole(v); }} options={(roles.data ?? []).map((r) => ({ value: r.code, label: r.name }))} />
      <Button title="Save role" variant="secondary" disabled={!role || role === u.roles[0] || self} onPress={() => setAction('roles')} />
      {self ? <Text size="small" muted>You cannot change your own role.</Text> : null}

      <SectionTitle>Access</SectionTitle>
      {u.status === 'DISABLED' ? <Button title="Re-enable account" onPress={() => setAction('reactivate')} /> : <Button title="Disable account" variant="danger" disabled={self} onPress={() => setAction('disable')} />}
      <Button title="Sign out everywhere" variant="secondary" onPress={() => setAction('revoke')} />
      <Button title="Reset two-step sign-in" variant="secondary" disabled={!u.mfaEnabled || self} onPress={() => setAction('resetMfa')} />

      <SectionTitle>Active devices</SectionTitle>
      {sessions.data?.length ? sessions.data.map((s) => <Card key={s.id}><Text bold>{s.deviceName ?? 'Unknown device'}</Text><Text size="small" muted>{s.platform ?? ''}{s.ip ? ` · ${s.ip}` : ''} · signed in {formatDateTime(s.createdAt)}</Text></Card>) : <Text muted>No active sessions.</Text>}

      <ReasonModal visible={action !== null} title={action ? TITLE[action] : ''} message="The reason is saved in the audit log." confirmLabel="Confirm" danger={action === 'disable'} onCancel={() => setAction(null)} onConfirm={confirm} />
    </Screen>
  );
}
