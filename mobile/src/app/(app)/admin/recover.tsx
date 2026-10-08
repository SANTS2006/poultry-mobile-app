import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { describeError } from '../../../lib/errors';
import { confirmPhrase, formatBytes } from '../../../lib/backup-format';
import { formatDateTime } from '../../../lib/format';
import { required, useForm } from '../../../lib/validation';
import { useEndpoints } from '../../../state/app';
import { Badge, Button, Card, ErrorView, Field, InlineError, Loading, Screen, Text } from '../../../ui/components';
import { space, useColors } from '../../../ui/theme';

/**
 * Restore a verified backup. Deliberately several steps: the warning, the password, a fresh authenticator code and a typed phrase.
 * The server never overwrites the live database: it restores into a NEW database and reports; going live with it is a separate operator step.
 */
export default function Recover() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useEndpoints();
  const qc = useQueryClient();
  const c = useColors();
  const backup = useQuery({ queryKey: ['admin', 'backups', 'one', id], queryFn: () => api.admin.backups.get(id) });
  const [opId, setOpId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ password: '', code: '', confirm: '' }, {
    password: [required('Enter your password.')], code: [required('Enter the 6-digit code from your authenticator app.')],
    confirm: [required('Type the confirmation phrase.'), (v) => (v.trim().toUpperCase() === confirmPhrase(id) ? null : `Type exactly: ${confirmPhrase(id)}`)],
  });
  const start = useMutation({
    mutationFn: () => api.admin.backups.recover({ backupId: id, password: form.values.password, code: form.values.code.trim(), confirm: form.values.confirm.trim().toUpperCase() }),
    onSuccess: (op) => { setOpId(op.id); setError(null); void qc.invalidateQueries({ queryKey: ['admin', 'recoveries'] }); },
    onError: (e) => setError(describeError(e)),
  });
  const op = useQuery({ queryKey: ['admin', 'recoveries', opId], enabled: !!opId, queryFn: () => api.admin.backups.recovery(opId!), refetchInterval: (q) => (q.state.data?.status === 'RUNNING' ? 2500 : false) });

  if (backup.isLoading) return <Screen><Loading /></Screen>;
  if (!backup.data) return <Screen><ErrorView message={describeError(backup.error)} onRetry={() => void backup.refetch()} /></Screen>;
  const b = backup.data;

  if (opId) {
    const o = op.data;
    return (
      <Screen>
        <Card tone={o?.status === 'SUCCEEDED' ? 'ok' : o?.status === 'FAILED' ? 'danger' : undefined}>
          <Badge tone={o?.status === 'SUCCEEDED' ? 'ok' : o?.status === 'FAILED' ? 'danger' : 'info'} label={o?.status === 'SUCCEEDED' ? 'Restored and checked' : o?.status === 'FAILED' ? 'Recovery failed' : 'Working…'} />
          {o?.error ? <Text color={c.danger}>{o.error}</Text> : null}
          {(o?.report?.steps ?? []).map((s) => <Text key={s.step} color={s.ok ? c.ok : c.danger}>{s.ok ? 'Done' : 'Failed'}: {s.step}{s.detail ? ` — ${s.detail}` : ''}</Text>)}
          {(o?.report?.checks ?? []).map((k) => <Text key={k.name} color={k.ok ? c.ok : c.danger}>{k.ok ? 'Passed' : 'Failed'}: {k.name}</Text>)}
          {o?.status === 'SUCCEEDED' ? (
            <>
              <Text bold>The restored copy is in the database “{o.report?.database}”.</Text>
              <Text>The live system was not changed, and a safety snapshot of it was taken first. To go live with the restored data, follow “Promote a recovery database” in the recovery runbook, or ask your technical operator.</Text>
            </>
          ) : null}
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Card tone="danger">
        <Text variant="heading">Read this first</Text>
        <Text>You are restoring the backup taken {formatDateTime(b.createdAt)} ({formatBytes(b.sizeBytes)}). Everything recorded after that moment is not in it.</Text>
        <Text>A fresh safety snapshot of the current data is taken first. The restored copy is created as a separate database and checked; the live system keeps running unchanged until an operator switches to it.</Text>
      </Card>
      <Card>
        <Field label="Your password" icon="lock-closed-outline" secureTextEntry {...form.field('password')} autoComplete="current-password" textContentType="password" />
        <Field label="Authenticator code" icon="keypad-outline" keyboardType="number-pad" maxLength={8} {...form.field('code')} />
        <Field label={`Type ${confirmPhrase(id)} to confirm`} icon="warning-outline" autoCapitalize="characters" autoCorrect={false} {...form.field('confirm')} />
        <InlineError message={error} />
      </Card>
      <View style={{ gap: space.sm }}>
        <Button title="Restore this backup" variant="danger" icon="refresh-circle-outline" busy={start.isPending} onPress={() => { if (form.submit()) start.mutate(); }} />
      </View>
    </Screen>
  );
}
