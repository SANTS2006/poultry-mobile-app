import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import type { AdminUser } from '../../../api/types';
import { timeAgo } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { Badge, Button, ListRow, SearchBar } from '../../../ui/components';
import { PagedList } from '../../../ui/paged-list';
import { space } from '../../../ui/theme';

const TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted'> = { ACTIVE: 'ok', INVITED: 'warn', LOCKED: 'danger', DISABLED: 'muted' };

export default function Users() {
  const router = useRouter();
  const api = useEndpoints();
  const [q, setQ] = useState('');
  return (
    <PagedList<AdminUser>
      queryKey={['admin', 'users', q]}
      fetchPage={(page, limit) => api.admin.users({ page, limit, q: q.trim() || undefined })}
      emptyIcon="people-outline" emptyTitle="No users found" emptyHint="Invite your team and give each person only the access they need."
      header={(
        <View style={{ padding: space.lg, gap: space.sm }}>
          <SearchBar value={q} onChangeText={setQ} placeholder="Search by name or email" />
          <Button title="Invite a user" icon="person-add-outline" onPress={() => router.push('/admin/invite')} />
        </View>
      )}
      renderItem={(u) => (
        <ListRow
          icon="person-circle-outline" title={u.fullName ?? u.email} subtitle={`${u.email} · ${u.roles.join(', ').toLowerCase().replace(/_/g, ' ')}${u.lastLoginAt ? ` · last seen ${timeAgo(u.lastLoginAt)}` : ''}`}
          badge={<Badge tone={TONE[u.status] ?? 'muted'} label={u.status.toLowerCase()} />} onPress={() => router.push(`/admin/user/${u.id}`)} 
        />
      )}
    />
  );
}
