import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Switch } from 'react-native';
import { describeError } from '../../../lib/errors';
import { money, required, useForm, type Rule } from '../../../lib/validation';
import { useEndpoints } from '../../../state/app';
import { Button, ErrorView, Field, ListRow, Loading, Screen, SectionTitle, Text } from '../../../ui/components';
import { useDialog } from '../../../ui/dialog';
import { useColors } from '../../../ui/theme';
import { useToast } from '../../../ui/toast';

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
  const toast = useToast();
  const dialog = useDialog();
  const [summaryOn, setSummaryOn] = useState(Boolean(initial.dailySummaryEnabled));
  const time24: Rule = (v) => (!v.trim() || HM.test(v.trim()) ? null : 'Use 24-hour time like 18:00.');
  const form = useForm(
    { summaryTime: String(initial.dailySummaryTime ?? '18:00'), large: initial.largeSaleThreshold ? String(initial.largeSaleThreshold) : '', monthly: initial.monthlyExpenseThreshold ? String(initial.monthlyExpenseThreshold) : '' },
    { summaryTime: [required('Enter a time like 18:00.'), time24], large: [money('threshold')], monthly: [money('threshold')] },
  );
  const { summaryTime, large, monthly } = form.values;
  const [reminders, setReminders] = useState<Reminder[]>((initial.productionReminders as Reminder[] | undefined) ?? []);
  const [busy, setBusy] = useState(false);

  async function save() {
    const ok = form.submit();
    if (reminders.some((r) => !HM.test(r.time))) { void dialog.notify({ title: 'Check the reminder times', message: 'Use 24-hour time like 10:00.', tone: 'warn' }); return; }
    if (!ok) return;
    setBusy(true);
    try {
      await api.notifications.setConfig({
        dailySummaryEnabled: summaryOn, dailySummaryTime: summaryTime, productionReminders: reminders,
        largeSaleThreshold: large.trim() || null, monthlyExpenseThreshold: monthly.trim() || null,
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'notification-config'] });
      toast.show('Notification rules saved');
    } catch (e) { void dialog.notify({ title: 'Could not save', message: describeError(e), tone: 'danger' }); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <ListRow title="Daily summary" subtitle="A short end-of-day notification for people who can see the dashboard" right={<Switch value={summaryOn} onValueChange={setSummaryOn} trackColor={{ true: c.primary }} accessibilityLabel="Daily summary" />} />
      <Field label="Summary time (24-hour, business time zone)" icon="time-outline" {...form.field('summaryTime')} keyboardType="numbers-and-punctuation" />
      <SectionTitle>Production reminders</SectionTitle>
      <Text muted>Sent to production staff only if a coop still has no record for that shift.</Text>
      {reminders.map((r, i) => (
        <Field key={r.shift} label={`${r.shift.toLowerCase()} reminder`} icon="alarm-outline" value={r.time} onChangeText={(t) => setReminders(reminders.map((x, j) => (j === i ? { ...x, time: t } : x)))} error={r.time && !HM.test(r.time) ? 'Use 24-hour time like 10:00.' : null} keyboardType="numbers-and-punctuation" />
      ))}
      <SectionTitle>Alerts for the owner</SectionTitle>
      <Field label="Large sale threshold" icon="cash-outline" {...form.field('large')} keyboardType="decimal-pad" hint="Empty = off" />
      <Field label="Monthly expense threshold" icon="cash-outline" {...form.field('monthly')} keyboardType="decimal-pad" hint="Empty = off" />
      <Button title="Save" onPress={() => void save()} busy={busy} />
    </Screen>
  );
}
