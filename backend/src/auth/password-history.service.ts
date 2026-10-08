import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PasswordService } from '../common/crypto/password.service';
import { PrismaService } from '../prisma/prisma.service';

export const PASSWORD_HISTORY_DEPTH = 5;

/** Remembers the last few password hashes per user so a password cannot be recycled straight away. Hashes only; never the passwords. */
@Injectable()
export class PasswordHistoryService {
  constructor(private readonly prisma: PrismaService, private readonly passwords: PasswordService) {}

  /** Throws if `plain` matches the current hash or one of the last remembered ones. */
  async assertNotReused(userId: string, plain: string, currentHash: string | null): Promise<void> {
    const old = await this.prisma.passwordHistory.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: PASSWORD_HISTORY_DEPTH });
    const hashes = [...(currentHash ? [currentHash] : []), ...old.map((o) => o.hash)];
    for (const h of hashes) {
      if (await this.passwords.verify(h, plain)) throw new BadRequestException(`Choose a password you have not used recently (your last ${PASSWORD_HISTORY_DEPTH} cannot be reused).`);
    }
  }

  /** Stores the hash being replaced and trims the list. Call inside the same transaction that sets the new password. */
  async remember(tx: Prisma.TransactionClient, userId: string, replacedHash: string | null): Promise<void> {
    if (!replacedHash) return;
    await tx.passwordHistory.create({ data: { userId, hash: replacedHash } });
    const keep = await tx.passwordHistory.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: PASSWORD_HISTORY_DEPTH, select: { id: true } });
    await tx.passwordHistory.deleteMany({ where: { userId, id: { notIn: keep.map((k) => k.id) } } });
  }
}
