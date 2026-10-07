import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProductionModule } from '../production/production.module';
import { SalesModule } from '../sales/sales.module';
import { ReferenceService } from './reference.service';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [ProductionModule, SalesModule, ExpensesModule, PaymentsModule, CustomersModule],
  controllers: [SyncController],
  providers: [SyncService, ReferenceService],
})
export class SyncModule {}
