import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'react-native';
import { describeError } from '../../../lib/errors';
import { formatDateTime } from '../../../lib/format';
import { useApp, useEndpoints } from '../../../state/app';
import { Badge, Button, Card, ErrorView, Loading, Row, Screen, Text } from '../../../ui/components';

export default function Sessions() {
  const api = useEndpoints();
  const { services } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['account', 'sessions'], queryFn: () => api.account.sessions() });

  async function revoke(id: string) {
    try { await api.account.revokeSession(id); await qc.invalidateQueries({ queryKey: ['account', 'sessions'] }); }
    catch (e) { Alert.alert('Could not sign that device out', describeError(e)); }
  }
  async function everywhere() {
    try { await api.account.logoutAll(); await services.session.sessionEnded(); } catch (e) { Alert.alert('Could not sign out', describeError(e)); }
  }

  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /> : null}
      {q.data?.map((s) => (
        <Card key={s.id}>
          <Row style={{ justifyContent: 'space-between' }}><Text bold>{s.deviceName ?? 'Unknown device'}</Text>{s.current ? <Badge tone="ok" label="This device" /> : null}</Row>
          <Text muted>{s.platform ?? ''}{s.ip ? ` · ${s.ip}` : ''}</Text>
          <Text size="small" muted>Signed in {formatDateTime(s.createdAt)}{s.lastUsedAt ? ` · last active ${formatDateTime(s.lastUsedAt)}` : ''}</Text>
          {!s.current ? <Button title="Sign this device out" variant="secondary" small onPress={() => void revoke(s.id)} /> : null}
        </Card>
      ))}
      <Button title="Sign out everywhere" variant="danger" onPress={() => Alert.alert('Sign out everywhere?', 'Every device, including this one, will need to sign in again.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: () => void everywhere() }])} />
    </Screen>
  );
}
