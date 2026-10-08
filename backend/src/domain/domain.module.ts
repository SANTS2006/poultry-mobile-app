import { Global, Module } from '@nestjs/common';
import { InventoryService } from '../inventory/inventory.service';
import { DomainEvents } from './events.service';
import { FarmService } from './farm.service';
import { PricingService } from './pricing.service';
import { ReferenceService } from './reference.service';
import { SettingsService } from './settings.service';

@Global()
@Module({
  providers: [DomainEvents, SettingsService, FarmService, PricingService, ReferenceService, InventoryService],
  exports: [DomainEvents, SettingsService, FarmService, PricingService, ReferenceService, InventoryService],
})
export class DomainModule {}
