import { Global, Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { RealtimeEmitter } from './realtime-emitter.service';
import { RealtimeGateway } from './realtime.gateway';

@Global()
@Module({ imports: [ChatModule], providers: [RealtimeGateway, RealtimeEmitter], exports: [RealtimeEmitter] })
export class RealtimeModule {}
