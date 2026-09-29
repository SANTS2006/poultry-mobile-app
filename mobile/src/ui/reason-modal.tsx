import { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { Button, Field, Row, Text } from './components';
import { radius, space, useColors } from './theme';

interface Props {
  visible: boolean; title: string; message?: string; confirmLabel?: string; danger?: boolean; onCancel: () => void; onConfirm: (reason: string) => void | Promise<void>;
}

/**
 * Cross-platform "type a reason" dialog (Alert.prompt exists on iOS only). Sensitive changes — voids, corrections, disabling users —
 * always need a written reason (5+ characters) because it is stored in the audit log.
 */
export function ReasonModal(props: Props) {
  const c = useColors();
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onCancel}>
      <Pressable style={{ flex: 1, backgroundColor: c.overlay, justifyContent: 'center', padding: space.lg }} onPress={props.onCancel}>
        {/* mounted only while visible, so every opening starts with an empty form */}
        {props.visible ? <ReasonBody {...props} /> : null}
      </Pressable>
    </Modal>
  );
}

function ReasonBody({ title, message, confirmLabel = 'Confirm', danger, onCancel, onConfirm }: Props) {
  const c = useColors();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = reason.trim().length >= 5;
  return (
    <Pressable style={{ backgroundColor: c.card, borderRadius: radius.lg, padding: space.lg, gap: space.md }} onPress={() => undefined}>
      <Text size="title" bold accessibilityRole="header">{title}</Text>
      {message ? <Text muted>{message}</Text> : null}
      <Field label="Reason (at least 5 characters)" value={reason} onChangeText={setReason} maxLength={300} autoFocus />
      <View style={{ gap: space.sm }}>
        <Row style={{ justifyContent: 'flex-end' }}>
          <Button title="Cancel" variant="ghost" onPress={onCancel} />
          <Button title={confirmLabel} variant={danger ? 'danger' : 'primary'} disabled={!ok} busy={busy} onPress={async () => { setBusy(true); try { await onConfirm(reason.trim()); } finally { setBusy(false); } }} />
        </Row>
      </View>
    </Pressable>
  );
}
