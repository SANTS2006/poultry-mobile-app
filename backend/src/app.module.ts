import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { HttpThrottlerGuard } from './common/http-throttler.guard';
import { LoggerModule } from 'nestjs-pino';
import { parseEnv } from './config/env';
import { loggerParams } from './common/logging/logger.config';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './auth/guards/permissions.guard';
import { MailModule } from './mail/mail.module';
import { RolesModule } from './roles/roles.module';
import { UsersModule } from './users/users.module';
import { CatalogModule } from './catalog/catalog.module';
import { CustomersModule } from './customers/customers.module';
import { DomainModule } from './domain/domain.module';
import { ExpensesModule } from './expenses/expenses.module';
import { InventoryModule } from './inventory/inventory.module';
import { PaymentsModule } from './payments/payments.module';
import { ProductionModule } from './production/production.module';
import { SalesModule } from './sales/sales.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { SyncModule } from './sync/sync.module';
import { RealtimeModule } from './realtime/realtime.module';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: false, validate: parseEnv }),
    LoggerModule.forRootAsync({
      useFactory: () => {
        const env = parseEnv(process.env);
        return loggerParams(env);
      },
    }),
    // Global baseline: 120 requests/min per client. Auth endpoints get stricter limits in Phase 4.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
      // Test-suites that create many logins set THROTTLE_OFF=1; never set in staging/production (see env validation).
      skipIf: () => process.env.THROTTLE_OFF === '1',
    }),
    PrismaModule,
    AuditModule,
    MailModule,
    AuthModule,
    UsersModule,
    RolesModule,
    DomainModule,
    CatalogModule,
    ProductionModule,
    InventoryModule,
    CustomersModule,
    SalesModule,
    PaymentsModule,
    ExpensesModule,
    DashboardModule,
    SyncModule,
    RealtimeModule,
    HealthModule,
  ],
  providers: [
    // Order matters: rate-limit → authenticate → authorize. Authorization is deny-by-default (see PermissionsGuard).
    { provide: APP_GUARD, useClass: HttpThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
