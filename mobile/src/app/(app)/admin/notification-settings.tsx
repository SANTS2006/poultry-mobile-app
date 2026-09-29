import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Switch } from 'react-native';
import { describeError } from '../../../lib/errors';
import { isMoneyInput } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { Button, ErrorView, Field, ListRow, Loading, Screen, SectionTitle, Text } from '../../../ui/components';
import { useColors } from '../../../ui/theme';

type Reminder = { shift: string; time: string };
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

type Config = Record<string, unknown>;

export default function NotificationRules() {
  const api = useEndpoints();
  const q = useQuery({ queryKey: ['admin', 'notification-config'], queryFn: () => api.notifications.config() });
  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (q.error || !q.data) return <Screen><ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /></Screen>;
  // keyed by the stored values so the form restarts from fresh data after a save
  return <RulesForm key={JSON.stringify(q.data)} initial={q.data} />;
}

function RulesForm({ initial }: { initial: Config }) {
  const api = useEndpoints();
  const qc = useQueryClient();
  const c = useColors();
  const [summaryOn, setSummaryOn] = useState(Boolean(initial.dailySummaryEnabled));
  const [summaryTime, setSummaryTime] = useState(String(initial.dailySummaryTime ?? '18:00'));
  const [large, setLarge] = useState(initial.largeSaleThreshold ? String(initial.largeSaleThreshold) : '');
  const [monthly, setMonthly] = useState(initial.monthlyExpenseThreshold ? String(initial.monthlyExpenseThreshold) : '');
  const [reminders, setReminders] = useState<Reminder[]>((initial.productionReminders as Reminder[] | undefined) ?? []);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!HM.test(summaryTime)) return Alert.alert('Check the time', 'Use 24-hour time like 18:00.');
    if (reminders.some((r) => !HM.test(r.time))) return Alert.alert('Check the reminder times', 'Use 24-hour time like 10:00.');
    if ((large && !isMoneyInput(large)) || (monthly && !isMoneyInput(monthly))) return Alert.alert('Check the thresholds', 'Use numbers only, or leave empty to switch off.');
    setBusy(true);
    try {
      await api.notifications.setConfig({
        dailySummaryEnabled: summaryOn, dailySummaryTime: summaryTime, productionReminders: reminders,
        largeSaleThreshold: large.trim() || null, monthlyExpenseThreshold: monthly.trim() || null,
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'notification-config'] });
      Alert.alert('Saved');
    } catch (e) { Alert.alert('Could not save', describeError(e)); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <ListRow title="Daily summary" subtitle="A short end-of-day notification for people who can see the dashboard" right={<Switch value={summaryOn} onValueChange={setSummaryOn} trackColor={{ true: c.primary }} accessibilityLabel="Daily summary" />} />
      <Field label="Summary time (24-hour, business time zone)" value={summaryTime} onChangeText={setSummaryTime} keyboardType="numbers-and-punctuation" />
      <SectionTitle>Production reminders</SectionTitle>
      <Text muted>Sent to production staff only if a coop still has no record for that shift.</Text>
      {reminders.map((r, i) => (
        <Field key={r.shift} label={`${r.shift.toLowerCase()} reminder`} value={r.time} onChangeText={(t) => setReminders(reminders.map((x, j) => (j === i ? { ...x, time: t } : x)))} keyboardType="numbers-and-punctuation" />
      ))}
      <SectionTitle>Alerts for the owner</SectionTitle>
      <Field label="Large sale threshold" value={large} onChangeText={setLarge} keyboardType="decimal-pad" hint="Empty = off" />
      <Field label="Monthly expense threshold" value={monthly} onChangeText={setMonthly} keyboardType="decimal-pad" hint="Empty = off" />
      <Button title="Save" onPress={() => void save()} busy={busy} />
    </Screen>
  );
}
