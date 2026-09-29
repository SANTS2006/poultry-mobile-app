import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { DashboardModule } from '../dashboard/dashboard.module';
import { NotificationScheduler } from './notification.scheduler';
import { NotificationRules } from './notification.rules';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { ExpoPushProvider } from './push/expo.provider';
import { NoopPushProvider } from './push/noop.provider';
import { PUSH_PROVIDER } from './push/push.provider';
import { RecipientsService } from './recipients.service';
import { SummaryService } from './summary.service';

@Module({
  imports: [DashboardModule],
  controllers: [NotificationsController],
  providers: [
    {
      provide: PUSH_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        // Never push from development/test unless explicitly asked to.
        const env = config.get('APP_ENV', { infer: true });
        const choice = config.get('PUSH_PROVIDER', { infer: true }) ?? (env === 'production' || env === 'staging' ? 'expo' : 'none');
        return choice === 'expo' ? new ExpoPushProvider(config.get<string>('PUSH_NOTIFICATION_CONFIG')) : new NoopPushProvider();
      },
    },
    RecipientsService, NotificationsService, SummaryService, NotificationRules, NotificationScheduler,
  ],
  exports: [NotificationsService, RecipientsService],
})
export class NotificationsModule {}
