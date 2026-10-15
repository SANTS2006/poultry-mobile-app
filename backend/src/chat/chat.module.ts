import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { CallService } from './call.service';
import { CallController, ChatController } from './chat.controller';
import { ChatPush } from './chat-push.service';
import { ChatScheduler } from './chat.scheduler';
import { ChatService } from './chat.service';
import { IceService } from './ice.service';
import { DisabledMediaStorage, MEDIA_STORAGE, R2MediaStorage } from './media.storage';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [ChatController, CallController],
  providers: [
    ChatService, CallService, ChatPush, IceService, ChatScheduler,
    {
      provide: MEDIA_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const g = <K extends keyof Env>(k: K) => config.get(k, { infer: true }) as Env[K];
        if (!(g('MEDIA_R2_BUCKET') && g('MEDIA_R2_ACCESS_KEY_ID') && g('MEDIA_R2_SECRET_ACCESS_KEY') && (g('MEDIA_R2_ENDPOINT') || g('MEDIA_R2_ACCOUNT_ID')))) return new DisabledMediaStorage();
        return new R2MediaStorage({
          accountId: g('MEDIA_R2_ACCOUNT_ID'), bucket: g('MEDIA_R2_BUCKET'), endpoint: g('MEDIA_R2_ENDPOINT') || `https://${g('MEDIA_R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
          accessKeyId: g('MEDIA_R2_ACCESS_KEY_ID'), secretAccessKey: g('MEDIA_R2_SECRET_ACCESS_KEY'),
        });
      },
    },
  ],
  exports: [ChatService, CallService],
})
export class ChatModule {}
