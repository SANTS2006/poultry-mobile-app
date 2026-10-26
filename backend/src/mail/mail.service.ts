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
const TIMEOUT_MS = 6_000;
const RETRIES = 2; // one quick second try for network blips, timeouts, 429 and 5xx (a rejected sender or key is not retried)

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
    if (!this.apiKey && process.env.JEST_WORKER_ID === undefined) this.logger.warn('BREVO_API_KEY is not set: NO email is sent (password reset codes, invitations and notices stay in memory). Set BREVO_API_KEY and a verified EMAIL_FROM.');
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
      for (let attempt = 1; ; attempt++) {
        let status = 0; let detail = '';
        try {
          const res = await fetch(BREVO_URL, {
            method: 'POST',
            headers: { 'api-key': this.apiKey, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              sender: { name: this.fromName, email: this.from }, to: [{ email: msg.to }], subject: msg.subject,
              textContent: msg.text, ...(msg.html ? { htmlContent: msg.html } : {}),
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (res.ok) return true;
          status = res.status;
          // Brevo explains rejections (unverified sender, bad key, quota) in the JSON body; it never echoes our content back.
          detail = (await res.text().catch(() => '')).slice(0, 300);
        } catch (err) {
          this.logger.warn({ err: err instanceof Error ? err.message : 'network error', attempt }, 'Brevo could not be reached');
        }
        const transient = status === 0 || status === 429 || status >= 500;
        if (!transient || attempt >= RETRIES) {
          this.logger.error({ status, detail }, 'The email could not be sent (check BREVO_API_KEY and that EMAIL_FROM is a verified sender in Brevo)');
          return false;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to send email');
      return false;
    }
  }
}
