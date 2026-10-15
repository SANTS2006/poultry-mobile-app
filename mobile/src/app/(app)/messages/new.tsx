import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { describeError } from '../../../lib/errors';
import { useEndpoints } from '../../../state/app';
import { useCan } from '../../../state/store';
import { Icon } from '../../../ui/icon';
import { Text } from '../../../ui/components';
import { UserPicker } from '../../../ui/chat/user-picker';
import { SheetScreen } from '../../../ui/sheet-screen';
import { useDialog } from '../../../ui/dialog';
import { space, radius, useColors } from '../../../ui/theme';

/** Choose a colleague to message (or start a group). The one-to-one conversation is created on first use and reused after. */
export default function NewMessage() {
  const api = useEndpoints();
  const router = useRouter();
  const dialog = useDialog();
  const c = useColors();
  const canGroups = useCan('chat.groups.create');
  const [busy, setBusy] = useState(false);
  async function open(userId: string) {
    if (busy) return;
    setBusy(true);
    try { const conv = await api.chat.openDirect(userId); router.replace({ pathname: '/messages/[id]', params: { id: conv.id } } as never); }
    catch (e) { void dialog.notify({ title: 'Could not start the chat', message: describeError(e), tone: 'danger' }); setBusy(false); }
  }
  return (
    <SheetScreen title="New message" scroll={false}>
      <UserPicker onPick={(u) => void open(u.id)}
        header={canGroups ? (
          <Pressable accessibilityRole="button" accessibilityLabel="New group" onPress={() => router.replace('/messages/group-new' as never)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, minHeight: 60, backgroundColor: pressed ? c.primarySoft : 'transparent' })}>
            <View style={{ width: 44, height: 44, borderRadius: radius.pill, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="people" size="md" color={c.onPrimarySoft} /></View>
            <Text variant="bodyStrong">New group</Text>
          </Pressable>
        ) : undefined} />
    </SheetScreen>
  );
}
