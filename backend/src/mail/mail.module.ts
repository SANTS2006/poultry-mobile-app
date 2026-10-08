import { Global, Module } from '@nestjs/common';
import { MailComposer } from './mail-composer.service';
import { MailService } from './mail.service';

@Global()
@Module({ providers: [MailService, MailComposer], exports: [MailService, MailComposer] })
export class MailModule {}
