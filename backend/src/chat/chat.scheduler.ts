import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env';
import { CallService } from './call.service';
import { ChatService } from './chat.service';

/** Housekeeping: ring time-outs and stuck calls every 15 s; retention and abandoned uploads hourly. Everything it does is idempotent (safe on restart). */
@Injectable()
export class ChatScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastHour = -1;

  constructor(private readonly calls: CallService, private readonly chat: ChatService, private readonly logger: PinoLogger, @Inject(ConfigService) private readonly config: ConfigService<Env, true>) {
    this.logger.setContext(ChatScheduler.name);
  }

  onModuleInit(): void {
    if (this.config.get('APP_ENV', { infer: true }) === 'test') return;
    this.timer = setInterval(() => { void this.tick().catch((e) => this.logger.error({ err: e }, 'Chat housekeeping failed')); }, 15_000);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async tick(now = new Date()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.calls.sweep(now);
      const hour = Math.floor(now.getTime() / 3_600_000);
      if (hour !== this.lastHour) {
        this.lastHour = hour;
        await this.chat.purgeOrphanUploads(now);
        await this.chat.purgeOlderThan(this.config.get('CHAT_RETENTION_DAYS', { infer: true }), now);
      }
    } finally { this.busy = false; }
  }
}
