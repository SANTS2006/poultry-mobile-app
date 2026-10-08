import { useQuery } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import type { Cell, ReportTable } from '../../../api/types';
import { describeError } from '../../../lib/errors';
import { formatDate, formatDateTime, formatMoney } from '../../../lib/format';
import { defaultGroupBy, PERIOD_LABELS, periodRange, type PeriodKey } from '../../../lib/periods';
import { useReference } from '../../../queries/hooks';
import { downloadAndShare } from '../../../services/export-file';
import { useApp, useEndpoints } from '../../../state/app';
import { useCan } from '../../../state/store';
import { useDialog } from '../../../ui/dialog';
import { Button, Card, ErrorView, Loading, Row, Screen, Segmented, SectionTitle, Text } from '../../../ui/components';
import { space } from '../../../ui/theme';

const TITLES: Record<string, string> = { production: 'Production report', sales: 'Sales report', expenses: 'Expenses report', inventory: 'Stock report', financial: 'Cash flow report' };

const label = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
function show(v: Cell, type: string | undefined, currency: string): string {
  if (v === null || v === undefined) return '—';
  if (type === 'money') return formatMoney(String(v), '');
  if (type === 'percent') return `${v}%`;
  return typeof v === 'number' ? String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(v);
}

function TableView({ t, currency }: { t: ReportTable; currency: string }) {
  const cols = t.columns.slice(0, 4); // phone width: first columns only; the export has everything
  return (
    <Card>
      <Text bold>{t.title}</Text>
      <Row style={{ borderBottomWidth: 1, borderColor: '#8884', paddingBottom: 4 }}>{cols.map((c) => <Text key={c.key} size="small" bold muted style={{ flex: 1 }} numberOfLines={1}>{c.label}</Text>)}</Row>
      {t.rows.slice(0, 40).map((r, i) => (
        <Row key={i}>{cols.map((c) => <Text key={c.key} size="small" style={{ flex: 1 }} numberOfLines={1}>{show(r[c.key], c.type, currency)}</Text>)}</Row>
      ))}
      {t.rows.length > 40 ? <Text size="small" muted>Showing 40 of {t.rows.length} rows. Export the report to see everything.</Text> : null}
      {t.totals ? <Row>{cols.map((c) => <Text key={c.key} size="small" bold style={{ flex: 1 }} numberOfLines={1}>{show(t.totals?.[c.key] ?? null, c.type, currency)}</Text>)}</Row> : null}
    </Card>
  );
}

export default function ReportScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const api = useEndpoints();
  const { services } = useApp();
  const dialog = useDialog();
  const ref = useReference();
  const canExport = useCan('reports.export');
  const [period, setPeriod] = useState<PeriodKey>('thisMonth');
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);
  const range = periodRange(period, ref.today);
  const groupBy = defaultGroupBy(range.from, range.to);
  const q = useQuery({ queryKey: ['reports', name, range, groupBy], queryFn: () => api.reports.run(name, { ...range, groupBy }) });
  const r = q.data;

  async function exportAs(format: 'csv' | 'pdf') {
    setExporting(format);
    try {
      await downloadAndShare(services.api, api.reports.exportPath(name, { ...range, groupBy, format }), `makarifor-${name}-${range.from}_${range.to}.${format}`, format === 'pdf' ? 'application/pdf' : 'text/csv');
    } catch (e) {
      void dialog.notify({ title: 'Could not export', message: describeError(e), tone: 'danger' });
    } finally {
      setExporting(null);
    }
  }

  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      <Stack.Screen options={{ title: TITLES[name] ?? 'Report' }} />
      <Segmented<PeriodKey> value={period} onChange={setPeriod} options={(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => ({ value: k, label: PERIOD_LABELS[k] }))} />
      <Text muted>{formatDate(range.from)} → {formatDate(range.to)}</Text>
      {q.isLoading ? <Loading label="Building report" /> : null}
      {q.error && !r ? <ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /> : null}
      {r ? (
        <>
          {r.meta.notes.map((n) => <Card key={n} tone="info"><Text size="small">{n}</Text></Card>)}
          <Card>
            <SectionTitle>Summary</SectionTitle>
            {Object.entries(r.summary).map(([k, v]) => (
              <Row key={k} style={{ justifyContent: 'space-between' }}>
                <Text muted style={{ flex: 1 }}>{label(k)}</Text>
                <Text bold>{/^\d+\.\d{2}$|^-\d+\.\d{2}$/.test(String(v)) ? formatMoney(String(v), r.meta.currency) : v === null ? '—' : String(v)}</Text>
              </Row>
            ))}
          </Card>
          {r.tables.map((t) => <TableView key={t.name} t={t} currency={r.meta.currency} />)}
          <Text size="small" muted>Generated {formatDateTime(r.meta.generatedAt)} · business time zone {r.meta.timezone}</Text>
          {canExport ? (
            <View style={{ gap: space.sm }}>
              <Button title="Share as PDF" onPress={() => void exportAs('pdf')} busy={exporting === 'pdf'} disabled={exporting !== null} />
              <Button title="Share as CSV (opens in Excel)" variant="secondary" onPress={() => void exportAs('csv')} busy={exporting === 'csv'} disabled={exporting !== null} />
              <Text size="small" muted>Exports are recorded in the audit log.</Text>
            </View>
          ) : <Text size="small" muted>Downloading reports needs the export permission.</Text>}
        </>
      ) : null}
      <View />
    </Screen>
  );
}

