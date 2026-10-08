import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { renderEmail, type Brand, type EmailContent } from './email-template';
import { MailService } from './mail.service';

export const SYSTEM_NAME = 'Poultry Management System';
export const DEFAULT_BUSINESS = 'Makarifor Agriculture';

/** Builds branded messages with the business's own name (from the farm record) and hands them to Brevo. */
@Injectable()
export class MailComposer {
  private cached: { name: string; at: number } | null = null;
  constructor(private readonly mail: MailService, private readonly prisma: PrismaService) {}

  /** The poultry business's name. Cached for a minute: it changes rarely and is read by every e-mail. */
  async businessName(): Promise<string> {
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached.name;
    const farm = await this.prisma.farm.findFirst({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { name: true } });
    const name = farm?.name?.trim() || DEFAULT_BUSINESS;
    this.cached = { name, at: Date.now() };
    return name;
  }

  async brand(): Promise<Brand> { return { businessName: await this.businessName(), systemName: SYSTEM_NAME }; }

  async send(to: string, subject: string, content: EmailContent): Promise<boolean> {
    const { html, text } = renderEmail(await this.brand(), content);
    return this.mail.send({ to, subject, text, html });
  }
}
