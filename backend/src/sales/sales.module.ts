import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({ imports: [CustomersModule], controllers: [SalesController], providers: [SalesService], exports: [SalesService] })
export class SalesModule {}
