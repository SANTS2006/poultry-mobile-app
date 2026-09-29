import { Module } from '@nestjs/common';
import { ExpensesController, SuppliersController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

@Module({ controllers: [ExpensesController, SuppliersController], providers: [ExpensesService] })
export class ExpensesModule {}
