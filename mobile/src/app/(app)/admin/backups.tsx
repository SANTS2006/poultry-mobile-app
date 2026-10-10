import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { describeError } from '../../../lib/errors';
import { backupLabel, formatBytes, HEALTH_TEXT, KIND_LABEL } from '../../../lib/backup-format';
import { formatDateTime, timeAgo } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { Badge, Button, Card, EmptyState, ErrorView, ListRow, Loading, Row, Screen, SectionHeader, StatTile, Text } from '../../../ui/components';
import { useDialog } from '../../../ui/dialog';
import { space, useColors } from '../../../ui/theme';
import { useToast } from '../../../ui/toast';

/** Super Admin only: whether the daily backup really ran, the history, a manual backup, and the way into a restore. */
export default function Backups() {
  const api = useEndpoints();
  const router = useRouter();
  const qc = useQueryClient();
  const c = useColors();
  const toast = useToast();
  const dialog = useDialog();
  const status = useQuery({ queryKey: ['admin', 'backups', 'status'], queryFn: () => api.admin.backups.status(), refetchInterval: (q) => (q.state.data?.running ? 3000 : 30_000) });
  const list = useQuery({ queryKey: ['admin', 'backups', 'list'], queryFn: () => api.admin.backups.list({ limit: 20 }), refetchInterval: () => (status.data?.running ? 3000 : false) });
  const recoveries = useQuery({ queryKey: ['admin', 'recoveries'], queryFn: () => api.admin.backups.recoveries(), refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'RUNNING') ? 3000 : false) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['admin', 'backups'] }); void qc.invalidateQueries({ queryKey: ['admin', 'recoveries'] }); };
  const run = useMutation({ mutationFn: () => api.admin.backups.runNow(), onSuccess: () => { toast.show('Backup started'); refresh(); }, onError: (e) => toast.show(describeError(e), 'error') });

  if (status.isLoading) return <Screen><Loading /></Screen>;
  if (status.error && !status.data) return <Screen><ErrorView message={describeError(status.error)} onRetry={() => void status.refetch()} /></Screen>;
  const s = status.data!;
  const h = HEALTH_TEXT[s.health] ?? HEALTH_TEXT.ok;
  const last = s.latestSuccess;

  async function confirmRun() {
    if (await dialog.confirm({ title: 'Back up now?', message: 'This takes an encrypted copy of the whole database. It is safe to do while people are working.', confirmLabel: 'Back up now' })) run.mutate();
  }

  return (
    <Screen refreshing={status.isRefetching} onRefresh={() => { void status.refetch(); void list.refetch(); void recoveries.refetch(); }}>
      <Card tone={h.tone === 'ok' ? 'ok' : h.tone === 'danger' ? 'danger' : 'warn'}>
        <Text variant="heading">{h.title}</Text>
        <Text>{last ? `Last successful backup ${timeAgo(last.finishedAt ?? last.createdAt)} (${formatDateTime(last.finishedAt ?? last.createdAt)}).` : 'There is no successful backup yet.'}</Text>
        {s.running ? <Text>A backup is running now…</Text> : null}
        {s.latestFailure && (!last || s.latestFailure.createdAt > last.createdAt) ? <Text>Latest failure: {s.latestFailure.error ?? 'unknown error'}</Text> : null}
      </Card>

      {s.warnings.length ? (
        <Card>{s.warnings.map((w) => <Text key={w} variant="caption" color={c.warn}>• {w}</Text>)}</Card>
      ) : null}

      <Row style={{ gap: space.md, alignItems: 'stretch' }}>
        <StatTile icon="time-outline" label="Next daily backup" value={s.enabled ? s.scheduleTime : 'Off'} hint={s.timezone} />
        <StatTile icon="cloud-outline" label="Stored at" value={s.destination} hint={s.storageOk ? 'Off this server' : 'Not reachable'} tone={s.storageOk ? undefined : 'warn'} />
      </Row>
      <Row style={{ gap: space.md, alignItems: 'stretch' }}>
        <StatTile icon="archive-outline" label="Kept for" value={`${s.retentionDays} days`} hint={s.keepMonthly ? `+ ${s.keepMonthly} monthly` : undefined} />
        <StatTile icon="shield-checkmark-outline" label="Last copy" value={last ? (backupLabel(last).label) : '—'} hint={last ? formatBytes(last.sizeBytes) : undefined} />
      </Row>

      <Button title="Back up now" icon="cloud-upload-outline" onPress={() => void confirmRun()} busy={run.isPending || !!s.running} disabled={!s.enabled} />

      <View style={{ gap: space.md }}>
        <SectionHeader title="Backup history" />
        {list.isLoading ? <Loading /> : (list.data?.items.length ?? 0) === 0 ? <EmptyState icon="archive-outline" title="No backups yet" hint="The first daily backup runs at the scheduled time, or tap “Back up now”." /> : (
          <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
            {list.data!.items.map((b) => {
              const l = backupLabel(b);
              return (
                <ListRow
                  key={b.id} icon={b.status === 'FAILED' ? 'alert-circle-outline' : 'archive-outline'} title={`${KIND_LABEL[b.kind] ?? b.kind} · ${formatDateTime(b.createdAt)}`}
                  subtitle={b.status === 'FAILED' ? (b.error ?? 'Failed') : [formatBytes(b.sizeBytes), b.deleted ? 'expired' : b.destination].filter(Boolean).join(' · ')}
                  badge={<Badge tone={l.tone} label={l.label} />} onPress={() => router.push({ pathname: '/admin/backup/[id]', params: { id: b.id } } as never)}
                />
              );
            })}
          </Card>
        )}
      </View>

      <View style={{ gap: space.md }}>
        <SectionHeader title="Recent recoveries" />
        {(recoveries.data?.length ?? 0) === 0 ? <Text muted>No recovery has been run.</Text> : (
          <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
            {recoveries.data!.slice(0, 5).map((r) => (
              <ListRow key={r.id} icon="refresh-circle-outline" title={`${r.requestedBy} · ${formatDateTime(r.startedAt)}`} subtitle={r.error ?? r.report?.database ?? 'Working…'}
                badge={<Badge tone={r.status === 'SUCCEEDED' ? 'ok' : r.status === 'FAILED' ? 'danger' : 'info'} label={r.status === 'SUCCEEDED' ? 'Restored' : r.status === 'FAILED' ? 'Failed' : 'Running'} />} />
            ))}
          </Card>
        )}
      </View>
    </Screen>
  );
}
