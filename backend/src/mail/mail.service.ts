import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain-text version (always sent; also what tests read). */
  text: string;
  /** Branded HTML version. */
  html?: string;
}

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const TIMEOUT_MS = 10_000;

/**
 * Sends every e-mail through Brevo's transactional API (https://developers.brevo.com). When BREVO_API_KEY is unset (development/test
 * only; production config validation forbids it) messages are captured in memory instead of sent. Message bodies contain passwords and
 * single-use tokens and are never logged.
 */
@Injectable()
export class MailService {
  readonly outbox: MailMessage[] = [];
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fromName: string;

  constructor(config: ConfigService<Env, true>, private readonly logger: PinoLogger) {
    this.logger.setContext(MailService.name);
    this.apiKey = config.get<string>('BREVO_API_KEY');
    this.from = config.get<string>('EMAIL_FROM') || 'no-reply@localhost';
    this.fromName = config.get<string>('EMAIL_FROM_NAME');
  }

  get enabled(): boolean { return !!this.apiKey; }

  /** Never throws to callers: a mail outage must not break (or reveal anything about) the auth flow. */
  async send(msg: MailMessage): Promise<boolean> {
    try {
      if (!this.apiKey) {
        this.outbox.push(msg);
        if (this.outbox.length > 200) this.outbox.shift();
        this.logger.warn('BREVO_API_KEY not configured; message captured in memory (development only)');
        return true;
      }
      const res = await fetch(BREVO_URL, {
        method: 'POST',
        headers: { 'api-key': this.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: this.fromName, email: this.from }, to: [{ email: msg.to }], subject: msg.subject,
          textContent: msg.text, ...(msg.html ? { htmlContent: msg.html } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        // Brevo explains rejections (unverified sender, bad key, quota) in the JSON body; it never echoes our content back.
        const detail = await res.text().catch(() => '');
        this.logger.error({ status: res.status, detail: detail.slice(0, 300) }, 'Brevo rejected the email');
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error({ err }, 'Failed to send email');
      return false;
    }
  }
}
