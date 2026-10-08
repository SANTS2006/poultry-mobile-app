import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { describeError } from '../../../../lib/errors';
import { backupLabel, formatBytes, KIND_LABEL } from '../../../../lib/backup-format';
import { formatDateTime } from '../../../../lib/format';
import { useEndpoints } from '../../../../state/app';
import { Badge, Button, Card, ErrorView, Loading, Text } from '../../../../ui/components';
import { useDialog } from '../../../../ui/dialog';
import { SheetScreen } from '../../../../ui/sheet-screen';
import { space, useColors } from '../../../../ui/theme';
import { useToast } from '../../../../ui/toast';

const Fact = ({ label, value }: { label: string; value: string }) => (
  <View style={{ gap: 2 }}><Text variant="caption" muted>{label}</Text><Text selectable>{value}</Text></View>
);

/** Details of one backup, with the integrity check, the restore test and the way into a restore. */
export default function BackupDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useEndpoints();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const dialog = useDialog();
  const c = useColors();
  const q = useQuery({ queryKey: ['admin', 'backups', 'one', id], queryFn: () => api.admin.backups.get(id), refetchInterval: (x) => (x.state.data?.status === 'RUNNING' ? 3000 : false) });
  const verify = useMutation({
    mutationFn: (deep: boolean) => api.admin.backups.verify(id, deep),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['admin', 'backups'] }); void dialog.notify({ title: r.ok ? 'Backup is good' : 'Check failed', tone: r.ok ? 'success' : 'danger', message: r.ok ? (r.level === 'restore' ? 'It was restored into a scratch database and every business check passed.' : 'The file is intact, authentic and readable.') : (r.message ?? 'The backup did not pass its checks.') }); },
    onError: (e) => toast.show(describeError(e), 'error'),
  });
  if (q.isLoading) return <SheetScreen title="Backup"><Loading /></SheetScreen>;
  if (q.error || !q.data) return <SheetScreen title="Backup"><ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /></SheetScreen>;
  const b = q.data; const l = backupLabel(b);
  const ok = b.status === 'SUCCESSFUL' && !b.deleted;

  async function deep() {
    if (await dialog.confirm({ title: 'Test restore?', message: 'The backup is restored into a temporary database on the recovery server, checked, and removed. Production is not touched. This can take several minutes.', confirmLabel: 'Test restore' })) verify.mutate(true);
  }

  return (
    <SheetScreen title={`${KIND_LABEL[b.kind] ?? b.kind} backup`} subtitle={formatDateTime(b.createdAt)}>
      <Card>
        <Badge tone={l.tone} label={l.label} />
        {b.error ? <Text color={c.danger}>{b.error}</Text> : null}
        <Fact label="Size" value={formatBytes(b.sizeBytes)} />
        <Fact label="Stored at" value={`${b.destination ?? '—'}${b.encrypted ? ' · encrypted (AES-256-GCM)' : ''}`} />
        <Fact label="Kept until" value={b.deleted ? 'Expired and removed' : formatDateTime(b.retentionUntil)} />
        <Fact label="Database" value={[b.dbName, b.serverVersion && `PostgreSQL ${b.serverVersion}`, b.environment].filter(Boolean).join(' · ') || '—'} />
        <Fact label="Checksum (SHA-256)" value={b.sha256 ?? '—'} />
        <Fact label="Attempts" value={String(b.attempt)} />
        {b.verifiedAt ? <Fact label="Last checked" value={`${formatDateTime(b.verifiedAt)} · ${b.verificationDetail?.level === 'restore' ? 'restore test' : 'file check'}`} /> : null}
      </Card>

      {b.verificationDetail?.checks?.length ? (
        <Card>
          <Text variant="bodyStrong">Checks</Text>
          {b.verificationDetail.checks.map((k) => <Text key={k.name} color={k.ok ? c.ok : c.danger}>{k.ok ? 'Passed' : 'Failed'}: {k.name}</Text>)}
          {b.verificationDetail.message ? <Text color={c.danger}>{b.verificationDetail.message}</Text> : null}
        </Card>
      ) : null}

      <View style={{ gap: space.sm }}>
        <Button title="Check file integrity" icon="shield-checkmark-outline" variant="secondary" disabled={!ok} busy={verify.isPending && verify.variables === false} onPress={() => verify.mutate(false)} />
        <Button title="Test restore (isolated)" icon="flask-outline" variant="secondary" disabled={!ok} busy={verify.isPending && verify.variables === true} onPress={() => void deep()} />
        <Button title="Restore this backup…" icon="refresh-circle-outline" variant="danger" disabled={!ok || b.verification !== 'VERIFIED'}
          onPress={() => router.replace({ pathname: '/admin/recover', params: { id: b.id } } as never)} />
        {b.verification !== 'VERIFIED' && ok ? <Text variant="caption" muted>Only a verified backup can be restored. Run the integrity check first.</Text> : null}
      </View>
    </SheetScreen>
  );
}
