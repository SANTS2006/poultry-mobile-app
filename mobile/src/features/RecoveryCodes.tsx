import { useState } from 'react';
import { View } from 'react-native';
import { Button, Card, Screen, Text } from '../ui/components';
import { space, useColors } from '../ui/theme';

/**
 * Recovery codes are shown exactly once (the server keeps only hashes). The user must confirm they saved them before continuing.
 * Codes are selectable so they can be copied into a password manager; we deliberately do not write them to disk or the clipboard.
 */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const c = useColors();
  const [saved, setSaved] = useState(false);
  return (
    <Screen>
      <Text size="h1" bold accessibilityRole="header">Save your recovery codes</Text>
      <Card tone="warn">
        <Text bold>Each code works once.</Text>
        <Text>If you lose your phone, these codes are the only way to sign in without your authenticator app. Write them down or store them in a password manager. They will not be shown again.</Text>
      </Card>
      <Card>
        <View style={{ gap: space.sm }}>
          {codes.map((code) => <Text key={code} selectable size="title" bold style={{ fontVariant: ['tabular-nums'], color: c.text }}>{code}</Text>)}
        </View>
      </Card>
      <Button title={saved ? 'Saved — continue' : 'I have saved these codes'} variant={saved ? 'primary' : 'secondary'} onPress={() => (saved ? onDone() : setSaved(true))} />
    </Screen>
  );
}
