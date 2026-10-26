import { View } from 'react-native';
import { passwordRules, passwordStrength } from '../lib/password';
import { Text } from './components';
import { Icon } from './icon';
import { radius, space, useColors } from './theme';

/**
 * The password rules as a live checklist: each line turns green as soon as the password satisfies it, with a strength bar on top.
 * Pass `confirm` on the screens that ask to repeat the password to add a "both match" line.
 */
export function PasswordRules({ password, email, confirm }: { password: string; email?: string; confirm?: string }) {
  const c = useColors();
  const rules = passwordRules(password, email);
  const strength = passwordStrength(password, email);
  const typed = password.length > 0;
  const barColor = strength.level <= 1 ? c.danger : strength.level === 2 ? c.warn : c.ok;
  const row = (key: string, label: string, ok: boolean, hint?: string, note?: boolean) => {
    const bad = typed && !ok && !note;
    const icon = note ? 'information-circle-outline' : ok ? 'checkmark-circle' : bad ? 'close-circle' : 'ellipse-outline';
    const tone = note ? c.muted : ok ? c.ok : bad ? c.danger : c.muted;
    return (
      <View key={key} accessible accessibilityLabel={`${label}. ${note ? 'Checked when you save.' : ok ? 'Done.' : 'Not met yet.'}`} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
        <Icon name={icon} size={20} color={tone} />
        <View style={{ flex: 1 }}>
          <Text variant="label" color={ok ? c.text : c.textSecondary} style={{ fontWeight: ok ? '600' : '400' }}>{label}</Text>
          {hint && !ok ? <Text variant="caption" muted>{hint}</Text> : null}
        </View>
      </View>
    );
  };
  return (
    <View accessibilityLabel="Password rules" style={{ gap: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: c.card, borderWidth: 1, borderColor: c.border }}>
      <View style={{ gap: space.xs }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text variant="bodyStrong">Your password must</Text>
          <Text variant="caption" bold color={typed ? barColor : c.muted}>{strength.label}</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {[1, 2, 3, 4].map((i) => <View key={i} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: strength.level >= i ? barColor : c.border }} />)}
        </View>
      </View>
      <View style={{ gap: space.sm }}>
        {rules.map((r) => row(r.id, r.label, r.ok, r.hint))}
        {row('names', 'Does not contain your name or the business name', false, 'Checked when you save.', true)}
        {confirm !== undefined ? row('match', 'Both passwords match', typed && password === confirm, 'Type the same password in the second box.') : null}
      </View>
    </View>
  );
}
