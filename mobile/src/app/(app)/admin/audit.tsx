import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';
import type { AuditEntry } from '../../../api/types';
import { describeError } from '../../../lib/errors';
import { formatDateTime } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { Badge, Button, Card, ListRow, Segmented, Text } from '../../../ui/components';
import { PagedList } from '../../../ui/paged-list';
import { space } from '../../../ui/theme';
import { useToast } from '../../../ui/toast';

const FILTERS = [{ value: 'all', label: 'Everything' }, { value: 'auth.*', label: 'Sign-ins' }, { value: 'user.*', label: 'Users' }, { value: 'sale.*', label: 'Sales' }, { value: 'production.*', label: 'Production' }, { value: 'report.exported', label: 'Exports' }] as const;

/** Read-only. Entries are chained with hashes, so a silent edit or deletion is detectable; "Check integrity" recomputes the chain on the server. */
export default function Audit() {
  const api = useEndpoints();
  const toast = useToast();
  const [filter, setFilter] = useState<string>('all');
  const [open, setOpen] = useState<string | null>(null);
  const verify = useQuery({ queryKey: ['admin', 'audit', 'verify'], queryFn: () => api.admin.verifyAudit(), enabled: false });

  async function check() {
    const r = await verify.refetch();
    if (r.error) toast.show(describeError(r.error), 'error');
  }

  return (
    <PagedList<AuditEntry>
      queryKey={['admin', 'audit', filter]} limit={30}
      fetchPage={(page, limit) => api.admin.audit({ page, limit, action: filter === 'all' ? undefined : filter })}
      emptyIcon="document-text-outline" emptyTitle="Nothing logged for this filter" emptyHint="Try another filter."
      header={(
        <View style={{ padding: space.lg, gap: space.md }}>
          <Segmented value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
          <Button title="Check integrity of the log" variant="secondary" onPress={() => void check()} busy={verify.isFetching} />
          {verify.data ? (
            <Card tone={verify.data.intact ? 'ok' : 'danger'}>
              <Text bold>{verify.data.intact ? 'Log is intact' : 'Log has been altered'}</Text>
              <Text size="small">{verify.data.intact ? `Checked the oldest ${verify.data.checked} of ${verify.data.total} entries.` : `First inconsistent entry: ${verify.data.firstInconsistentId}`}</Text>
            </Card>
          ) : null}
        </View>
      )}
      renderItem={(e) => (
        <ListRow
          icon="document-text-outline" title={e.action} subtitle={`${e.userName ?? 'system'} · ${formatDateTime(e.at)}${e.reason ? `\nReason: ${e.reason}` : ''}${open === e.id ? `\n${e.entityType ?? ''} ${e.entityId ?? ''}\nIP ${e.ip ?? '—'} · ${e.deviceInfo ?? ''}\nBefore: ${JSON.stringify(e.before)}\nAfter: ${JSON.stringify(e.after)}` : ''}`}
          badge={e.action.includes('failed') || e.action.includes('locked') ? <Badge tone="warn" label="security" /> : undefined}
          onPress={() => setOpen(open === e.id ? null : e.id)}
        />
      )}
    />
  );
}
