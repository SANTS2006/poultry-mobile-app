import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { NotificationCategory } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateNested,
} from 'class-validator';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CurrentUser, Meta } from '../auth/decorators/current-user.decorator';
import { AnyAuthenticated, RequirePermissions } from '../auth/decorators/permissions.decorator';
import { SettingsService } from '../domain/settings.service';
import { ALL_CATEGORIES } from './notification.types';
import { ListNotificationsQuery, NotificationsService } from './notifications.service';
import { PageQuery } from '../common/pagination';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

class ListQuery extends PageQuery implements ListNotificationsQuery {
  @IsOptional() @IsIn(['unread', 'read', 'all']) status?: 'unread' | 'read' | 'all';
  @IsOptional() @IsIn(ALL_CATEGORIES as string[]) category?: NotificationCategory;
}
class MarkAllDto { @IsOptional() @IsIn(ALL_CATEGORIES as string[]) category?: NotificationCategory; }
class PreferenceItem {
  @IsIn(ALL_CATEGORIES as string[]) category!: NotificationCategory;
  @IsBoolean() enabled!: boolean;
}
class PreferencesDto { @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => PreferenceItem) preferences!: PreferenceItem[]; }
class DeviceDto {
  @Transform(trim) @IsString() @MaxLength(100) pushToken!: string;
  @IsIn(['ios', 'android']) platform!: 'ios' | 'android';
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) deviceName?: string;
}
class UnregisterDto { @Transform(trim) @IsString() @MaxLength(100) pushToken!: string; }
class ReminderDto {
  @IsIn(['MORNING', 'AFTERNOON', 'EVENING']) shift!: string;
  @Matches(HM, { message: 'time must be HH:MM (24 hour, business time zone)' }) time!: string;
}
class ConfigDto {
  @IsOptional() @IsBoolean() dailySummaryEnabled?: boolean;
  @IsOptional() @Matches(HM, { message: 'dailySummaryTime must be HH:MM' }) dailySummaryTime?: string;
  @IsOptional() @IsBoolean() dailySummaryEmail?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => ReminderDto) productionReminders?: ReminderDto[];
  /** null clears the threshold */
  @IsOptional() @Matches(MONEY, { message: 'largeSaleThreshold must be a decimal with at most 2 decimals' }) largeSaleThreshold?: string | null;
  @IsOptional() @Matches(MONEY, { message: 'monthlyExpenseThreshold must be a decimal with at most 2 decimals' }) monthlyExpenseThreshold?: string | null;
}

const CONFIG_KEYS = {
  dailySummaryEnabled: 'notifications.dailySummaryEnabled', dailySummaryTime: 'notifications.dailySummaryTime', dailySummaryEmail: 'notifications.dailySummaryEmail',
  productionReminders: 'notifications.productionReminders', largeSaleThreshold: 'notifications.largeSaleThreshold', monthlyExpenseThreshold: 'notifications.monthlyExpenseThreshold',
} as const;

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService, private readonly settings: SettingsService, private readonly audit: AuditService) {}

  // ── notification center: every route only ever touches the caller's own notifications ──

  @AnyAuthenticated() @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListQuery) { return this.notifications.list(user.id, q); }

  @AnyAuthenticated() @Get('unread-count')
  async unread(@CurrentUser() user: AuthUser) { return { unread: await this.notifications.unreadCount(user.id) }; }

  @AnyAuthenticated() @HttpCode(200) @Post('read-all')
  readAll(@CurrentUser() user: AuthUser, @Body() dto: MarkAllDto) { return this.notifications.markAllRead(user.id, dto.category); }

  @AnyAuthenticated() @Get('preferences')
  async prefs(@CurrentUser() user: AuthUser) { return { preferences: await this.notifications.preferences(user.id) }; }

  @AnyAuthenticated() @Put('preferences')
  async setPrefs(@CurrentUser() user: AuthUser, @Body() dto: PreferencesDto) { return { preferences: await this.notifications.setPreferences(user.id, dto.preferences) }; }

  @AnyAuthenticated() @Post('devices')
  registerDevice(@CurrentUser() user: AuthUser, @Body() dto: DeviceDto) { return this.notifications.registerDevice(user.id, dto.pushToken, dto.platform, dto.deviceName); }

  @AnyAuthenticated() @HttpCode(204) @Delete('devices')
  async unregister(@CurrentUser() user: AuthUser, @Body() dto: UnregisterDto): Promise<void> { await this.notifications.unregisterDevice(user.id, dto.pushToken); }

  /** Sends a test notification to the caller's own devices (verifies push setup). */
  @AnyAuthenticated() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @HttpCode(200) @Post('test')
  async test(@CurrentUser() user: AuthUser) {
    const ids = await this.notifications.notify({ category: 'SYSTEM', type: 'system.test', recipients: [user.id], title: 'Test notification', body: 'Push notifications are working on this device.', push: { title: 'Makarifor', body: 'Test notification.' } });
    return { sent: ids.length, provider: this.notifications.pushProvider };
  }

  // ── administrator configuration ──

  @RequirePermissions('notifications.manage') @Get('config')
  async config() {
    return Object.fromEntries(await Promise.all(Object.entries(CONFIG_KEYS).map(async ([k, key]) => [k, await this.settings.get(key)])));
  }

  @RequirePermissions('notifications.manage') @Put('config')
  async setConfig(@CurrentUser() user: AuthUser, @Body() dto: ConfigDto, @Meta() meta: RequestMeta) {
    const changes = Object.entries(dto).filter(([, v]) => v !== undefined);
    if (changes.length === 0) throw new BadRequestException('Nothing to change.');
    const before: Record<string, unknown> = {}; const after: Record<string, unknown> = {};
    for (const [k, v] of changes) {
      const key = CONFIG_KEYS[k as keyof typeof CONFIG_KEYS];
      before[k] = await this.settings.get(key);
      await this.settings.set(key, v, user.id);
      after[k] = v;
    }
    await this.audit.record({ action: 'settings.notifications_changed', userId: user.id, userName: user.fullName, entityType: 'settings', before, after, ip: meta.ip, requestId: meta.requestId });
    return this.config();
  }

  // ── keep `:id` routes last so they never shadow the fixed ones above ──

  @AnyAuthenticated() @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.notifications.get(user.id, id); }

  @AnyAuthenticated() @HttpCode(200) @Post(':id/read')
  read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.notifications.markRead(user.id, id); }

  @AnyAuthenticated() @HttpCode(200) @Post(':id/opened')
  opened(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.notifications.markOpened(user.id, id); }
}
