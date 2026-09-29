import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * SMTP mailer. When EMAIL_HOST is unset (development/test only — production config validation forbids it) messages are
 * captured in memory instead of sent. Message bodies contain single-use tokens and are never logged.
 */
@Injectable()
export class MailService {
  readonly outbox: MailMessage[] = [];
  private readonly transport: Transporter | null;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>, private readonly logger: PinoLogger) {
    this.logger.setContext(MailService.name);
    const host = config.get<string>('EMAIL_HOST');
    this.from = config.get<string>('EMAIL_FROM') || 'no-reply@localhost';
    this.transport = host
      ? createTransport({
          host,
          port: config.get<number>('EMAIL_PORT'),
          secure: config.get<number>('EMAIL_PORT') === 465,
          requireTLS: config.get<number>('EMAIL_PORT') !== 465,
          auth: config.get<string>('EMAIL_USER')
            ? { user: config.get<string>('EMAIL_USER'), pass: config.get<string>('EMAIL_PASSWORD') }
            : undefined,
        })
      : null;
  }

  /** Never throws to callers: a mail outage must not break (or reveal anything about) the auth flow. */
  async send(msg: MailMessage): Promise<boolean> {
    try {
      if (!this.transport) {
        this.outbox.push(msg);
        if (this.outbox.length > 200) this.outbox.shift();
        this.logger.warn('EMAIL_HOST not configured; message captured in memory (development only)');
        return true;
      }
      await this.transport.sendMail({ from: this.from, ...msg });
      return true;
    } catch (err) {
      this.logger.error({ err }, 'Failed to send email');
      return false;
    }
  }
}
