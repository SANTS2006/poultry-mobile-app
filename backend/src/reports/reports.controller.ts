import { Controller, Get, StreamableFile, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CurrentUser, Meta } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import {
  ExpensesExportQuery, ExpensesQuery, ProductionExportQuery, ProductionQuery, RangeExportQuery, RangeQuery, SalesExportQuery, SalesQuery,
} from './reports.dto';
import { ReportName, ReportsService } from './reports.service';

type Base = { from: string; to: string; groupBy?: 'day' | 'week' | 'month'; detail?: boolean };
const split = (q: object) => {
  const { from, to, groupBy, detail, format: _f, table: _t, ...filters } = q as Base & { format?: string; table?: string } & Record<string, string | boolean | undefined>;
  void _f; void _t;
  return { range: { from, to, groupBy, detail }, filters, format: (q as { format?: 'csv' | 'pdf' }).format, table: (q as { table?: string }).table };
};
const EXPORT_LIMIT = { default: { limit: 10, ttl: 60_000 } };

/**
 * Viewing needs `reports.read` + the data permissions of the report; downloading additionally needs `reports.export`.
 * The data permissions are checked inside the service for BOTH paths, so a report or an export can never contain more than the caller may already see.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  private view(u: AuthUser, name: ReportName, q: object) { const s = split(q); return this.reports.run(u, name, s.range, s.filters); }

  private async file(u: AuthUser, name: ReportName, q: object, meta: RequestMeta): Promise<StreamableFile> {
    const s = split(q);
    const out = await this.reports.export(u, name, s.range, s.filters, s.format as 'csv' | 'pdf', s.table, meta);
    return new StreamableFile(out.body, { type: out.contentType, disposition: `attachment; filename="${out.filename}"` });
  }

  @RequirePermissions('reports.read') @Get('production') production(@CurrentUser() u: AuthUser, @Query() q: ProductionQuery) { return this.view(u, 'production', q); }
  @RequirePermissions('reports.read') @Get('sales') sales(@CurrentUser() u: AuthUser, @Query() q: SalesQuery) { return this.view(u, 'sales', q); }
  @RequirePermissions('reports.read') @Get('expenses') expenses(@CurrentUser() u: AuthUser, @Query() q: ExpensesQuery) { return this.view(u, 'expenses', q); }
  @RequirePermissions('reports.read') @Get('inventory') inventory(@CurrentUser() u: AuthUser, @Query() q: RangeQuery) { return this.view(u, 'inventory', q); }
  @RequirePermissions('reports.read') @Get('financial') financial(@CurrentUser() u: AuthUser, @Query() q: RangeQuery) { return this.view(u, 'financial', q); }

  @RequirePermissions('reports.export') @Throttle(EXPORT_LIMIT) @Get('production/export')
  exportProduction(@CurrentUser() u: AuthUser, @Query() q: ProductionExportQuery, @Meta() m: RequestMeta) { return this.file(u, 'production', q, m); }
  @RequirePermissions('reports.export') @Throttle(EXPORT_LIMIT) @Get('sales/export')
  exportSales(@CurrentUser() u: AuthUser, @Query() q: SalesExportQuery, @Meta() m: RequestMeta) { return this.file(u, 'sales', q, m); }
  @RequirePermissions('reports.export') @Throttle(EXPORT_LIMIT) @Get('expenses/export')
  exportExpenses(@CurrentUser() u: AuthUser, @Query() q: ExpensesExportQuery, @Meta() m: RequestMeta) { return this.file(u, 'expenses', q, m); }
  @RequirePermissions('reports.export') @Throttle(EXPORT_LIMIT) @Get('inventory/export')
  exportInventory(@CurrentUser() u: AuthUser, @Query() q: RangeExportQuery, @Meta() m: RequestMeta) { return this.file(u, 'inventory', q, m); }
  @RequirePermissions('reports.export') @Throttle(EXPORT_LIMIT) @Get('financial/export')
  exportFinancial(@CurrentUser() u: AuthUser, @Query() q: RangeExportQuery, @Meta() m: RequestMeta) { return this.file(u, 'financial', q, m); }
}
