import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { DashboardService } from '../dashboard/dashboard.service';
import { SettingsService } from '../domain/settings.service';
import { fmtEggs, fmtMoney } from './format';
import { RecipientsService } from './recipients.service';

export interface ComposedSummary { title: string; lines: string[]; body: string }

/** Builds the daily summary from live database figures, limited to what the recipient is allowed to see. */
@Injectable()
export class SummaryService {
  constructor(private readonly dashboard: DashboardService, private readonly recipients: RecipientsService, private readonly settings: SettingsService) {}

  async compose(userId: string): Promise<ComposedSummary | null> {
    const permissions = await this.recipients.permissionsOf(userId);
    const user = { id: userId, permissions } as AuthUser;
    const d = (await this.dashboard.build(user)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cur = await this.settings.get<string>('business.currency');
    const lines: string[] = [];
    if (d.production) lines.push(`Production: ${fmtEggs(d.production.todayEggs)}`);
    if (d.sales) lines.push(`Sales: ${fmtMoney(cur, d.sales.todayRevenue)}`);
    if (d.expenses) lines.push(`Expenses: ${fmtMoney(cur, d.expenses.todayTotal)}`);
    if (d.inventory) lines.push(`Current stock: ${fmtEggs(d.inventory.quantityEggs)}`);
    if (d.receivables) lines.push(`Outstanding customer balances: ${fmtMoney(cur, d.receivables.outstandingTotal)}`);
    if (lines.length === 0) return null;
    return { title: `Daily poultry summary — ${d.businessDate}`, lines, body: lines.join('\n') };
  }
}
