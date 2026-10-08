import { useQuery, useQueryClient } from '@tanstack/react-query';
import { describeError } from '../../../lib/errors';
import { formatDateTime } from '../../../lib/format';
import { useApp, useEndpoints } from '../../../state/app';
import { useDialog } from '../../../ui/dialog';
import { Badge, Button, Card, ErrorView, Loading, Row, Screen, Text } from '../../../ui/components';

export default function Sessions() {
  const api = useEndpoints();
  const { services } = useApp();
  const qc = useQueryClient();
  const dialog = useDialog();
  const q = useQuery({ queryKey: ['account', 'sessions'], queryFn: () => api.account.sessions() });

  async function revoke(id: string) {
    try { await api.account.revokeSession(id); await qc.invalidateQueries({ queryKey: ['account', 'sessions'] }); }
    catch (e) { void dialog.notify({ title: 'Could not sign that device out', message: describeError(e), tone: 'danger' }); }
  }
  async function everywhere() {
    try { await api.account.logoutAll(); await services.session.sessionEnded(); } catch (e) { void dialog.notify({ title: 'Could not sign out', message: describeError(e), tone: 'danger' }); }
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
      <Button title="Sign out everywhere" variant="danger" onPress={() => { void dialog.confirm({ title: 'Sign out everywhere?', message: 'Every device, including this one, will need to sign in again.', confirmLabel: 'Sign out', destructive: true }).then((ok) => { if (ok) void everywhere(); }); }} />
    </Screen>
  );
}
