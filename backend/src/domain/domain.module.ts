import { Global, Module } from '@nestjs/common';
import { InventoryService } from '../inventory/inventory.service';
import { DomainEvents } from './events.service';
import { FarmService } from './farm.service';
import { PricingService } from './pricing.service';
import { SettingsService } from './settings.service';

@Global()
@Module({
  providers: [DomainEvents, SettingsService, FarmService, PricingService, InventoryService],
  exports: [DomainEvents, SettingsService, FarmService, PricingService, InventoryService],
})
export class DomainModule {}
