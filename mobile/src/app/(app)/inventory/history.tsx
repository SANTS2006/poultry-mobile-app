import type { InventoryTx } from '../../../api/types';
import { formatDateTime, formatInt } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { Badge, ListRow, Text } from '../../../ui/components';
import { PagedList } from '../../../ui/paged-list';

const LABEL: Record<string, string> = {
  OPENING: 'Opening stock', PRODUCTION: 'Production', SALE: 'Sale', USAGE: 'Own use', DAMAGE: 'Damaged', LOSS: 'Lost', ADJUSTMENT: 'Adjustment', TRANSFER: 'Transfer', CORRECTION: 'Correction',
};

export default function StockHistory() {
  const api = useEndpoints();
  return (
    <PagedList<InventoryTx>
      queryKey={['inventory', 'history']} limit={30}
      fetchPage={(page, limit) => api.inventory.transactions({ page, limit })}
      emptyTitle="No stock movements yet"
      renderItem={(t) => (
        <ListRow
          title={`${LABEL[t.type] ?? t.type}: ${t.quantityEggs > 0 ? '+' : ''}${formatInt(t.quantityEggs)} eggs`} subtitle={`${formatDateTime(t.occurredAt)}${t.reason ? ` · ${t.reason}` : ''}`}
          badge={t.needsReview ? <Badge tone="warn" label="Needs review" /> : undefined}
          right={<Text bold color={t.quantityEggs < 0 ? '#B42318' : '#1A7F4B'}>{t.quantityEggs < 0 ? '↓' : '↑'}</Text>}
        />
      )}
    />
  );
}
