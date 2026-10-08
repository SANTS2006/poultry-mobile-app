import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { describeError } from '../../../lib/errors';
import { fullName, required, useForm } from '../../../lib/validation';
import { pickAvatar } from '../../../lib/avatar';
import { useApp, useEndpoints } from '../../../state/app';
import { useDialog } from '../../../ui/dialog';
import { useAppStore } from '../../../state/store';
import { Avatar, Button, Card, Field, Text } from '../../../ui/components';
import { SheetScreen } from '../../../ui/sheet-screen';
import { Icon } from '../../../ui/icon';
import { radius, space, useColors } from '../../../ui/theme';
import { useToast } from '../../../ui/toast';

/** Photo and name. Both are saved on the server and shown everywhere the app greets you. */
export default function EditProfile() {
  const api = useEndpoints();
  const { services } = useApp();
  const c = useColors();
  const toast = useToast();
  const dialog = useDialog();
  const user = useAppStore((s) => s.user);
  const form = useForm({ name: user?.fullName ?? '' }, { name: [required('Enter your name.'), fullName] });
  const [busy, setBusy] = useState<'photo' | 'name' | null>(null);

  async function savePhoto(source: 'library' | 'camera') {
    const r = await pickAvatar(source);
    if (!r.ok) {
      if (r.reason === 'permission_denied') void dialog.notify({ title: 'Permission needed', tone: 'warn', message: source === 'camera' ? 'Allow camera access in your phone settings to take a photo.' : 'Allow photo access in your phone settings to choose a picture.' });
      else if (r.reason === 'error') void dialog.notify({ title: 'Could not use that photo', message: r.detail ?? 'Try a different picture.', tone: 'danger' });
      return;
    }
    await run('photo', () => api.account.updateProfile({ avatar: r.dataUrl }), 'Photo updated');
  }

  async function run(kind: 'photo' | 'name', fn: () => Promise<unknown>, done: string) {
    setBusy(kind);
    try { await fn(); await services.session.refreshProfile(); toast.show(done); }
    catch (e) { toast.show(describeError(e), 'error'); }
    finally { setBusy(null); }
  }

  async function choose() {
    const pick = await dialog.ask<'camera' | 'library' | 'remove' | 'cancel'>({
      title: 'Profile photo', message: 'Choose where the picture comes from.', tone: 'info', icon: 'camera',
      actions: [
        { label: 'Take a photo', value: 'camera' }, { label: 'Choose from library', value: 'library', variant: 'secondary' },
        ...(user?.avatar ? [{ label: 'Remove photo', value: 'remove' as const, variant: 'danger' as const }] : []),
        { label: 'Cancel', value: 'cancel', variant: 'ghost' },
      ],
    });
    if (pick === 'remove') await run('photo', () => api.account.updateProfile({ avatar: null }), 'Photo removed');
    else if (pick === 'library') await savePhoto('library');
    else if (pick === 'camera') await savePhoto('camera');
  }

  async function saveName() {
    if (!form.submit()) return;
    const v = form.values.name.trim();
    if (v === user?.fullName) return;
    await run('name', () => api.account.updateProfile({ fullName: v }), 'Name updated');
  }

  return (
    <SheetScreen title="Edit profile">
      <View style={{ alignItems: 'center', gap: space.md, paddingVertical: space.md }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Change profile photo" onPress={() => void choose()} disabled={busy === 'photo'}>
          <Avatar name={user?.fullName ?? '?'} uri={user?.avatar} size={112} />
          <View style={{ position: 'absolute', right: 0, bottom: 0, width: 36, height: 36, borderRadius: radius.pill, backgroundColor: c.primary, borderWidth: 3, borderColor: c.bg, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="camera" size="sm" color={c.onPrimary} />
          </View>
        </Pressable>
        <Button title={busy === 'photo' ? 'Saving…' : 'Change photo'} variant="ghost" small onPress={() => void choose()} busy={busy === 'photo'} />
      </View>

      <Card style={{ gap: space.lg }}>
        <Field label="Full name" icon="person-outline" {...form.field('name')} autoCapitalize="words" textContentType="name" autoComplete="name" maxLength={100} returnKeyType="done" onSubmitEditing={() => void saveName()} />
        <Button title="Save name" onPress={() => void saveName()} busy={busy === 'name'} disabled={form.values.name.trim() === user?.fullName} />
      </Card>

      <Text variant="caption" muted style={{ textAlign: 'center' }}>Your name and photo are visible to administrators of this farm.</Text>
    </SheetScreen>
  );
}
