import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Switch, View } from 'react-native';
import { describeError } from '../../../lib/errors';
import { useEndpoints } from '../../../state/app';
import { Button, Card, EmptyState, ErrorView, ListRow, Loading, SectionHeader, Text } from '../../../ui/components';
import { SheetScreen } from '../../../ui/sheet-screen';
import { space, useColors } from '../../../ui/theme';
import { useToast } from '../../../ui/toast';

function Toggle({ title, hint, value, onChange }: { title: string; hint: string; value: boolean; onChange: (v: boolean) => void }) {
  const c = useColors();
  return (
    <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <View style={{ flex: 1 }}><Text variant="bodyStrong">{title}</Text><Text variant="caption" muted>{hint}</Text></View>
      <Switch accessibilityLabel={title} value={value} onValueChange={onChange} trackColor={{ true: c.primary }} />
    </Card>
  );
}

/** Message and call notification preferences, lock-screen privacy and the blocked list. */
export default function MessageSettings() {
  const api = useEndpoints();
  const qc = useQueryClient();
  const toast = useToast();
  const s = useQuery({ queryKey: ['chat', 'settings'], queryFn: () => api.chat.settings() });
  const blocks = useQuery({ queryKey: ['chat', 'blocks'], queryFn: () => api.chat.blocks() });
  const set = async (patch: Partial<{ showPreviews: boolean; pushMessages: boolean; pushCalls: boolean }>) => {
    try { qc.setQueryData(['chat', 'settings'], await api.chat.setSettings(patch)); } catch (e) { toast.show(describeError(e), 'error'); void s.refetch(); }
  };
  if (s.isLoading) return <SheetScreen title="Message settings"><Loading /></SheetScreen>;
  if (s.error || !s.data) return <SheetScreen title="Message settings"><ErrorView message={describeError(s.error)} onRetry={() => void s.refetch()} /></SheetScreen>;
  return (
    <SheetScreen title="Message settings">
      <Toggle title="Message notifications" hint="Get a notification when you receive a message and the app is closed." value={s.data.pushMessages} onChange={(v) => void set({ pushMessages: v })} />
      <Toggle title="Call notifications" hint="Get a notification for incoming and missed calls." value={s.data.pushCalls} onChange={(v) => void set({ pushCalls: v })} />
      <Toggle title="Show message text on the lock screen" hint="Off by default: notifications only say “New message”, so nobody who sees your phone can read your chats. Turn on to see who wrote and what." value={s.data.showPreviews} onChange={(v) => void set({ showPreviews: v })} />
      <View style={{ gap: space.md }}>
        <SectionHeader title="Blocked people" />
        {(blocks.data?.length ?? 0) === 0 ? <EmptyState icon="ban-outline" title="No one is blocked" hint="You can block someone from their conversation details." /> : (
          <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
            {blocks.data!.map((b) => <ListRow key={b.userId} title={b.name} right={<Button title="Unblock" small variant="secondary" onPress={() => void api.chat.unblock(b.userId).then(() => qc.invalidateQueries({ queryKey: ['chat', 'blocks'] })).catch((e) => toast.show(describeError(e), 'error'))} />} />)}
          </Card>
        )}
      </View>
    </SheetScreen>
  );
}
