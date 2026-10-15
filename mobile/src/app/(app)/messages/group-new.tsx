import { useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { pickAvatar } from '../../../lib/avatar';
import { describeError } from '../../../lib/errors';
import { maxLength, required, useForm } from '../../../lib/validation';
import { useEndpoints } from '../../../state/app';
import { chatKeys } from '../../../services/chat-events';
import { Avatar, Button, Field, InlineError, Text } from '../../../ui/components';
import { UserPicker } from '../../../ui/chat/user-picker';
import { useDialog } from '../../../ui/dialog';
import { space, useColors } from '../../../ui/theme';

/** Create a group: name, optional description and picture, and the people to add (full-screen because it is a longer form). */
export default function NewGroup() {
  const api = useEndpoints();
  const router = useRouter();
  const qc = useQueryClient();
  const dialog = useDialog();
  const c = useColors();
  const form = useForm({ title: '', description: '' }, { title: [required('Give the group a name.'), maxLength(80)], description: [maxLength(300)] });
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choosePhoto() {
    const r = await pickAvatar('library');
    if (r.ok) setPhoto(r.dataUrl);
    else if (r.reason === 'permission_denied') void dialog.notify({ title: 'Permission needed', message: 'Allow photo access in your phone settings to choose a picture.', tone: 'warn' });
  }
  async function create() {
    if (!form.submit()) return;
    if (members.size === 0) return setError('Choose at least one person to add.');
    setBusy(true); setError(null);
    try {
      const g = await api.chat.createGroup({ title: form.values.title.trim(), description: form.values.description.trim() || undefined, avatar: photo ?? undefined, memberIds: [...members] });
      await qc.invalidateQueries({ queryKey: chatKeys.conversations });
      router.replace({ pathname: '/messages/[id]', params: { id: g.id } } as never);
    } catch (e) { setError(describeError(e)); setBusy(false); }
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ title: 'New group' }} />
      <UserPicker
        selected={members} onPick={(u) => setMembers((m) => { const n = new Set(m); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n; })}
        header={(
          <View style={{ paddingHorizontal: space.lg, gap: space.md, paddingBottom: space.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <Avatar name={form.values.title || 'Group'} size={64} uri={photo} />
              <View style={{ flex: 1 }}><Field label="Group name" icon="people-outline" {...form.field('title')} maxLength={80} returnKeyType="next" /></View>
            </View>
            <Field label="Description (optional)" {...form.field('description')} maxLength={300} multiline />
            <Button title={photo ? 'Change picture' : 'Add picture (optional)'} variant="ghost" small icon="image-outline" onPress={() => void choosePhoto()} />
            <Text variant="bodyStrong">Add people ({members.size} chosen)</Text>
            <InlineError message={error} />
            <Button title="Create group" icon="checkmark-circle-outline" busy={busy} onPress={() => void create()} />
          </View>
        )}
      />
    </View>
  );
}
