import type { PrismaService } from '../prisma/prisma.service';
import type { ReportMeta, ReportRequest } from './report.types';

export interface ReportContext {
  prisma: PrismaService;
  farmId: string;
  tz: string;
  currency: string;
  req: ReportRequest;
  units: { carton: number; crate: number };
  permissions: string[];
  /** display names for user ids appearing in details */
  userName(id: string | null | undefined): string;
  meta(report: string, title: string, filters: Record<string, string>, notes?: string[]): ReportMeta;
}

export const has = (c: ReportContext, permission: string): boolean => c.permissions.includes(permission);

export async function loadUserNames(prisma: PrismaService, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true, profile: { select: { fullName: true } } } });
  return new Map(rows.map((r) => [r.id, r.profile?.fullName ?? r.email]));
}
