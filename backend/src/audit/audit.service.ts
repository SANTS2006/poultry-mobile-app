import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  action: string; // e.g. "auth.login.success", "user.role_changed"
  userId?: string | null;
  userName?: string | null;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ip?: string;
  deviceInfo?: string;
  requestId?: string;
}

type Tx = Prisma.TransactionClient;

const SENSITIVE_KEY = /pass(word)?|secret|token|hash|code|authorization|cookie/i;

/** Removes credential-like fields from before/after snapshots so the log itself can never leak secrets. */
export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Append-only audit trail. Each row carries hash = SHA-256(prevHash | canonical row content), forming a chain that
 * makes silent edits or deletions detectable even for someone with database access (verified by `verifyChain`).
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass `tx` to write the audit row atomically with the business change (rolls back together). */
  async record(entry: AuditEntry, tx?: Tx): Promise<void> {
    if (tx) return this.write(tx, entry);
    await this.prisma.$transaction((t) => this.write(t, entry));
  }

  private async write(tx: Tx, e: AuditEntry): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(748201)`; // serialise chain appends
    const last = await tx.auditLog.findFirst({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { hash: true } });
    const createdAt = new Date();
    const data = {
      userId: e.userId ?? null,
      userName: e.userName ?? null,
      action: e.action,
      entityType: e.entityType ?? null,
      entityId: e.entityId ?? null,
      before: (scrub(e.before) ?? null) as Prisma.InputJsonValue | null,
      after: (scrub(e.after) ?? null) as Prisma.InputJsonValue | null,
      reason: e.reason ?? null,
      ip: e.ip ?? null,
      deviceInfo: e.deviceInfo?.slice(0, 200) ?? null,
      requestId: e.requestId ?? null,
    };
    const prevHash = last?.hash ?? null;
    const hash = AuditService.computeHash(prevHash, data, createdAt);
    await tx.auditLog.create({
      data: {
        ...data,
        before: data.before ?? Prisma.JsonNull,
        after: data.after ?? Prisma.JsonNull,
        createdAt,
        prevHash,
        hash,
      },
    });
  }

  static computeHash(prevHash: string | null, d: Record<string, unknown>, createdAt: Date): string {
    const canonical = JSON.stringify([
      prevHash, d.userId, d.userName, d.action, d.entityType, d.entityId, d.before, d.after, d.reason, d.ip,
      d.deviceInfo, d.requestId, createdAt.toISOString(),
    ]);
    return createHash('sha256').update(canonical).digest('hex');
  }

  /** Recomputes the chain in order; returns the id of the first inconsistent row or null when intact. */
  async verifyChain(limit = 10_000): Promise<string | null> {
    const rows = await this.prisma.auditLog.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit });
    let prev: string | null = null;
    for (const r of rows) {
      const expected = AuditService.computeHash(
        prev,
        { userId: r.userId, userName: r.userName, action: r.action, entityType: r.entityType, entityId: r.entityId,
          before: r.before ?? null, after: r.after ?? null, reason: r.reason, ip: r.ip, deviceInfo: r.deviceInfo, requestId: r.requestId },
        r.createdAt,
      );
      if (r.prevHash !== prev || r.hash !== expected) return r.id;
      prev = r.hash;
    }
    return null;
  }
}
