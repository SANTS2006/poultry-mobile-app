import type { ApiClient } from '../services/api-client';
import type {
  AdminUser, AppNotification, AuditEntry, Coop, Customer, Dashboard, Expense, InventorySnapshot, InventoryTx, NotificationPage, NotificationPreference, Page,
  PayMethod, PriceRow, ProductionRecord, ReportResult, Role, Sale, SessionInfo, Supplier, Unit, UnitInfo,
} from './types';

type Params = Record<string, string | number | boolean | null | undefined>;

/** Builds a query string, skipping empty values. */
export function qs(params: Params = {}): string {
  const parts = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Every authenticated REST call the app makes, in one typed place. The server re-checks every permission; hiding a button is only a convenience. */
export function createEndpoints(api: ApiClient) {
  const get = <T>(path: string, params?: Params) => api.request<T>('GET', `/v1${path}${qs(params)}`);
  const post = <T>(path: string, body?: unknown) => api.request<T>('POST', `/v1${path}`, body ?? {});
  const put = <T>(path: string, body: unknown) => api.request<T>('PUT', `/v1${path}`, body);
  const patch = <T>(path: string, body: unknown) => api.request<T>('PATCH', `/v1${path}`, body);
  const del = <T>(path: string, body?: unknown) => api.request<T>('DELETE', `/v1${path}`, body);

  return {
    dashboard: () => get<Dashboard>('/dashboard'),

    coops: () => get<Coop[]>('/coops'),
    units: () => get<UnitInfo[]>('/units'),
    prices: () => get<PriceRow[]>('/prices'),
    setPrice: (unit: Unit, amount: string, reason: string) => post('/prices', { unit, amount, reason }),

    production: {
      list: (p: Params) => get<Page<ProductionRecord>>('/production', p),
      get: (id: string) => get<ProductionRecord>(`/production/${id}`),
      correct: (id: string, body: { entries: { unit: Unit; quantity: number }[]; version: number; reason: string; notes?: string }) => patch<ProductionRecord>(`/production/${id}`, body),
      void: (id: string, reason: string) => post<ProductionRecord>(`/production/${id}/void`, { reason }),
    },
    sales: {
      list: (p: Params) => get<Page<Sale>>('/sales', p),
      get: (id: string) => get<Sale>(`/sales/${id}`),
      void: (id: string, reason: string) => post<Sale>(`/sales/${id}/void`, { reason }),
    },
    payments: {
      create: (body: { saleId?: string; customerId?: string; amount: string; method?: PayMethod; reference?: string; clientId?: string }) => post('/payments', body),
      list: (p: Params) => get<Page<{ id: string; saleId: string | null; customerId: string | null; amount: string; method: PayMethod; paidAt: string; status: string }>>('/payments', p),
      void: (id: string, reason: string) => post(`/payments/${id}/void`, { reason }),
    },
    customers: {
      list: (p: Params) => get<Page<Customer>>('/customers', p),
      get: (id: string) => get<Customer>(`/customers/${id}`),
      update: (id: string, body: Record<string, unknown>) => patch<Customer>(`/customers/${id}`, body),
    },
    expenses: {
      list: (p: Params) => get<Page<Expense>>('/expenses', p),
      get: (id: string) => get<Expense>(`/expenses/${id}`),
      void: (id: string, reason: string) => post(`/expenses/${id}/void`, { reason }),
      categories: () => get<{ code: string; name: string }[]>('/expense-categories'),
      suppliers: () => get<Supplier[]>('/suppliers'),
    },
    inventory: {
      current: () => get<InventorySnapshot>('/inventory'),
      transactions: (p: Params) => get<Page<InventoryTx>>('/inventory/transactions', p),
      reconciliation: () => get<{ balanceEggs: number; ledgerSumEggs: number; consistent: boolean }>('/inventory/reconciliation'),
      adjust: (body: { type: 'ADJUSTMENT' | 'DAMAGE' | 'LOSS' | 'USAGE'; direction?: 'INCREASE' | 'DECREASE'; unit: Unit; quantity: number; reason: string; clientId?: string }) => post('/inventory/adjustments', body),
    },

    reports: {
      run: (name: string, p: Params) => get<ReportResult>(`/reports/${name}`, p),
      exportPath: (name: string, p: Params) => `/v1/reports/${name}/export${qs(p)}`,
    },

    notifications: {
      list: (p: Params) => get<NotificationPage>('/notifications', p),
      unread: () => get<{ unread: number }>('/notifications/unread-count'),
      read: (id: string) => post<AppNotification>(`/notifications/${id}/read`),
      opened: (id: string) => post(`/notifications/${id}/opened`),
      readAll: (category?: string) => post<{ updated: number; unread: number }>('/notifications/read-all', category ? { category } : {}),
      preferences: () => get<{ preferences: NotificationPreference[] }>('/notifications/preferences'),
      setPreferences: (preferences: { category: string; enabled: boolean }[]) => put<{ preferences: NotificationPreference[] }>('/notifications/preferences', { preferences }),
      registerDevice: (pushToken: string, platform: 'ios' | 'android', deviceName?: string) => post('/notifications/devices', { pushToken, platform, deviceName }),
      unregisterDevice: (pushToken: string) => del('/notifications/devices', { pushToken }),
      test: () => post<{ sent: number; provider: string }>('/notifications/test'),
      config: () => get<Record<string, unknown>>('/notifications/config'),
      setConfig: (body: Record<string, unknown>) => put<Record<string, unknown>>('/notifications/config', body),
    },

    account: {
      me: () => get('/auth/me'),
      sessions: () => get<SessionInfo[]>('/auth/sessions'),
      revokeSession: (id: string) => del(`/auth/sessions/${id}`),
      logoutAll: () => post('/auth/logout-all'),
      changePassword: (currentPassword: string, newPassword: string) => post('/auth/change-password', { currentPassword, newPassword }),
      mfaEnroll: () => post<{ secret: string; otpauthUri: string; qrCodeDataUrl: string }>('/auth/mfa/enroll'),
      mfaConfirm: (code: string) => post<{ status: string; recoveryCodes: string[] }>('/auth/mfa/confirm', { code }),
      mfaDisable: (password: string, code: string) => post('/auth/mfa/disable', { password, code }),
      newRecoveryCodes: (password: string, code: string) => post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { password, code }),
    },

    admin: {
      users: (p: Params) => get<Page<AdminUser>>('/users', p),
      user: (id: string) => get<AdminUser>(`/users/${id}`),
      invite: (body: { email: string; fullName: string; phone?: string; roleCodes: string[] }) => post('/users/invite', body),
      resendInvite: (id: string) => post(`/users/${id}/resend-invite`),
      setRoles: (id: string, roleCodes: string[], reason: string) => put<AdminUser>(`/users/${id}/roles`, { roleCodes, reason }),
      disable: (id: string, reason: string) => post<AdminUser>(`/users/${id}/disable`, { reason }),
      reactivate: (id: string, reason: string) => post<AdminUser>(`/users/${id}/reactivate`, { reason }),
      userSessions: (id: string) => get<SessionInfo[]>(`/users/${id}/sessions`),
      revokeUserSessions: (id: string, reason: string) => del(`/users/${id}/sessions`, { reason }),
      resetMfa: (id: string, reason: string) => post(`/users/${id}/reset-mfa`, { reason }),
      roles: () => get<Role[]>('/roles'),
      audit: (p: Params) => get<Page<AuditEntry>>('/audit', p),
      verifyAudit: () => get<{ intact: boolean; firstInconsistentId: string | null; checked: number; total: number }>('/audit/verify'),
    },
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
