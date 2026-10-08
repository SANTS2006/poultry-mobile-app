import { useState } from 'react';
import { View } from 'react-native';
import { minLength, required, useForm } from '../lib/validation';
import { Button, Field } from './components';
import { DialogShell } from './dialog';
import { space } from './theme';

interface Props {
  visible: boolean; title: string; message?: string; confirmLabel?: string; danger?: boolean; onCancel: () => void; onConfirm: (reason: string) => void | Promise<void>;
}

/**
 * "Type a reason" dialog. Sensitive changes — voids, corrections, disabling users — always need a written reason (5+ characters)
 * because it is stored in the audit log. Mounted only while visible, so every opening starts with an empty form.
 */
export function ReasonModal(props: Props) {
  return (
    <DialogShell visible={props.visible} onClose={props.onCancel} tone={props.danger ? 'danger' : 'warn'} icon="create-outline" title={props.title} message={props.message ?? 'The reason is saved in the audit log.'}>
      {props.visible ? <ReasonBody {...props} /> : null}
    </DialogShell>
  );
}

function ReasonBody({ confirmLabel = 'Confirm', danger, onCancel, onConfirm }: Props) {
  const form = useForm({ reason: '' }, { reason: [required('Please give a reason.'), minLength(5, 'Please explain in at least 5 characters.')] });
  const [busy, setBusy] = useState(false);
  const reason = form.values.reason;
  const ok = reason.trim().length >= 5;
  return (
    <View style={{ gap: space.md }}>
      <Field label="Reason (at least 5 characters)" {...form.field('reason')} maxLength={300} autoFocus />
      <Button pill title={confirmLabel} variant={danger ? 'danger' : 'primary'} disabled={!ok} busy={busy} onPress={async () => { setBusy(true); try { await onConfirm(reason.trim()); } finally { setBusy(false); } }} />
      <Button pill title="Cancel" variant="ghost" onPress={onCancel} />
    </View>
  );
}
