import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BackupController, RecoveryController } from './backup.controller';
import { BackupScheduler } from './backup.scheduler';
import { BackupService } from './backup.service';
import { RecoveryService } from './recovery.service';

@Module({
  imports: [AuthModule],
  controllers: [BackupController, RecoveryController],
  providers: [BackupService, BackupScheduler, RecoveryService],
  exports: [BackupService, BackupScheduler, RecoveryService],
})
export class BackupModule {}
