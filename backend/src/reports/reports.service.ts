import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { isValidDate } from '../common/dates';
import { FarmService } from '../domain/farm.service';
import { PricingService } from '../domain/pricing.service';
import { SettingsService } from '../domain/settings.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ReportContext } from './context';
import { toCsv } from './csv';
import { expensesReport } from './expenses.report';
import { financialReport } from './financial.report';
import { inventoryReport } from './inventory.report';
import { toPdf } from './pdf';
import { spanDays } from './period';
import { productionReport } from './production.report';
import type { GroupBy, ReportMeta, ReportRequest, ReportResult } from './report.types';
import { salesReport } from './sales.report';

export type ReportName = 'production' | 'sales' | 'expenses' | 'inventory' | 'financial';

/** Data permissions a caller needs, on top of `reports.read` (view) or `reports.export` (download). A report can only ever contain data the caller may already see. */
export const REPORT_DATA_PERMISSIONS: Record<ReportName, string[]> = {
  production: ['production.read'],
  sales: ['sales.read'],
  expenses: ['expenses.read'],
  inventory: ['inventory.read'],
  financial: ['sales.read', 'expenses.read', 'payments.read'],
};

const MAX_SPAN_DAYS = 366;
const MAX_EXPORT_ROWS = 100_000;
const MAX_JSON_DETAIL_ROWS = 5_000;

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService, private readonly settings: SettingsService, private readonly farms: FarmService,
    private readonly pricing: PricingService, private readonly audit: AuditService,
  ) {}

  private validate(q: { from: string; to: string; groupBy?: GroupBy; detail?: boolean }, filters: ReportRequest['filters'], detail: boolean): ReportRequest {
    if (!isValidDate(q.from) || !isValidDate(q.to)) throw new BadRequestException('from and to must be valid dates (YYYY-MM-DD).');
    if (q.from > q.to) throw new BadRequestException('from must not be after to.');
    if (q.from < '2000-01-01') throw new BadRequestException('from is too far in the past.');
    if (spanDays(q.from, q.to) > MAX_SPAN_DAYS) throw new BadRequestException(`A report can cover at most ${MAX_SPAN_DAYS} days. Choose a shorter period.`);
    return { from: q.from, to: q.to, groupBy: q.groupBy ?? 'day', detail, filters };
  }

  async run(user: AuthUser, name: ReportName, q: { from: string; to: string; groupBy?: GroupBy; detail?: boolean }, filters: ReportRequest['filters'], forExport = false): Promise<ReportResult> {
    const missing = REPORT_DATA_PERMISSIONS[name].filter((p) => !user.permissions.includes(p));
    if (missing.length) throw new ForbiddenException('You do not have permission to see this report.');
    const req = this.validate(q, filters, forExport || q.detail === true);
    const tz = await this.settings.get<string>('business.timezone');
    const currency = await this.settings.get<string>('business.currency');
    const units = await this.pricing.unitsFor();
    const farmId = await this.farms.resolve();
    const generatedAt = new Date().toISOString();
    const ctx: ReportContext = {
      prisma: this.prisma, farmId, tz, currency, req, permissions: user.permissions,
      units: { carton: units.get('CARTON')?.eggsPerUnit ?? 360, crate: units.get('CRATE')?.eggsPerUnit ?? 30 },
      userName: () => '',
      meta: (report, title, f, notes = []): ReportMeta => ({ report, title, from: req.from, to: req.to, groupBy: req.groupBy, filters: f, generatedAt, currency, timezone: tz, notes }),
    };
    const result = await ({ production: productionReport, sales: salesReport, expenses: expensesReport, inventory: inventoryReport, financial: financialReport })[name](ctx);
    const rows = result.tables.reduce((a, t) => a + t.rows.length, 0);
    if (forExport ? rows > MAX_EXPORT_ROWS : false) throw new BadRequestException('This export is too large. Choose a shorter period or add filters.');
    if (!forExport && req.detail && result.tables.some((t) => t.rows.length > MAX_JSON_DETAIL_ROWS)) {
      throw new BadRequestException('Too many rows to return as JSON. Use the export or choose a shorter period.');
    }
    return result;
  }

  /** Builds a downloadable file. Requires reports.export (checked by the controller) and the same data permissions as viewing. Every export is audited. */
  async export(user: AuthUser, name: ReportName, q: { from: string; to: string; groupBy?: GroupBy }, filters: ReportRequest['filters'], format: 'csv' | 'pdf', table: string | undefined, meta: RequestMeta) {
    const result = await this.run(user, name, q, filters, true);
    if (table && format === 'csv' && !result.tables.some((t) => t.name === table)) throw new BadRequestException(`Unknown table "${table}" for this report.`);
    const body = format === 'csv' ? Buffer.from(toCsv(result, table), 'utf8') : await toPdf(result, user.fullName);
    const rows = result.tables.reduce((a, t) => a + t.rows.length, 0);
    await this.audit.record({
      action: 'report.exported', userId: user.id, userName: user.fullName, entityType: 'report', entityId: name,
      after: { report: name, format, from: q.from, to: q.to, groupBy: q.groupBy ?? 'day', filters: result.meta.filters, table: table ?? null, rows, bytes: body.length },
      ip: meta.ip, requestId: meta.requestId,
    });
    const filename = `makarifor-${name}-${q.from}_${q.to}${table ? `-${table}` : ''}.${format}`;
    return { body, filename, contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf' };
  }
}
