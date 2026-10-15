import type { ChatMessage, ConversationDetail, ConversationSummary } from '../lib/chat/types';
import type { CallApi, CallView, IceServer } from '../services/call-manager';
import type { ApiClient } from '../services/api-client';
import type { UserSummary } from '../services/session-manager';
import type {
  AdminUser, AppNotification, AuditEntry, BackupJob, BackupStatus, RecoveryOp, Coop, Customer, Dashboard, Expense, InventorySnapshot, InventoryTx, InventoryTxDetail, NotificationPage, NotificationPreference, Page,
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
    createCoop: (body: { name: string; capacity?: number; notes?: string }) => post<Coop>('/coops', body),
    updateCoop: (id: string, body: { name?: string; active?: boolean; capacity?: number | null; notes?: string | null }) => patch<Coop>(`/coops/${id}`, body),
    units: () => get<UnitInfo[]>('/units'),
    prices: () => get<PriceRow[]>('/prices'),
    setPrice: (unit: Unit, amount: string, reason: string) => post('/prices', { unit, amount, reason }),

    chat: {
      config: () => get<{ attachments: boolean; maxAttachmentBytes: number; maxMessageChars: number; maxGroupMembers: number; allowedTypes: string[] }>('/chat/config'),
      users: (p: Params) => get<Page<ChatUser>>('/chat/users', p),
      conversations: (p: Params) => get<Page<ConversationSummary>>('/chat/conversations', p),
      conversation: (id: string) => get<ConversationDetail>(`/chat/conversations/${id}`),
      openDirect: (userId: string) => post<ConversationDetail>('/chat/conversations/direct', { userId }),
      createGroup: (body: { title: string; description?: string; avatar?: string; memberIds: string[] }) => post<ConversationDetail>('/chat/conversations/group', body),
      updateGroup: (id: string, body: { title?: string; description?: string | null; avatar?: string | null }) => patch<ConversationDetail>(`/chat/conversations/${id}`, body),
      addMembers: (id: string, userIds: string[]) => post<ConversationDetail>(`/chat/conversations/${id}/members`, { userIds }),
      removeMember: (id: string, userId: string) => del(`/chat/conversations/${id}/members/${userId}`),
      setRole: (id: string, userId: string, role: 'ADMIN' | 'MEMBER') => put<ConversationDetail>(`/chat/conversations/${id}/members/${userId}/role`, { role }),
      mute: (id: string, muted: boolean, hours?: number) => put(`/chat/conversations/${id}/mute`, { muted, hours }),
      messages: (id: string, p: Params) => get<{ items: ChatMessage[]; hasMore: boolean; nextBefore: number | null }>(`/chat/conversations/${id}/messages`, p),
      send: (id: string, body: { clientId: string; kind: 'TEXT' | 'IMAGE' | 'FILE'; body?: string; replyToId?: string; attachmentId?: string }) => post<ChatMessage>(`/chat/conversations/${id}/messages`, body),
      edit: (messageId: string, body: string) => patch<ChatMessage>(`/chat/messages/${messageId}`, { body }),
      remove: (messageId: string) => del<ChatMessage>(`/chat/messages/${messageId}`),
      report: (messageId: string, reason: string) => post(`/chat/messages/${messageId}/report`, { reason }),
      markRead: (id: string, upToSeq: number) => post(`/chat/conversations/${id}/read`, { upToSeq }),
      createUpload: (body: { conversationId: string; fileName: string; mimeType: string; sizeBytes: number }) => post<{ attachmentId: string; uploadUrl: string; headers: Record<string, string> }>('/chat/attachments', body),
      completeUpload: (id: string) => post<{ attachmentId: string; status: string }>(`/chat/attachments/${id}/complete`),
      downloadUrl: (id: string) => get<{ url: string; fileName: string; mimeType: string; sizeBytes: number }>(`/chat/attachments/${id}/url`),
      blocks: () => get<{ userId: string; name: string }[]>('/chat/blocks'),
      block: (userId: string) => post('/chat/blocks', { userId }),
      unblock: (userId: string) => del(`/chat/blocks/${userId}`),
      settings: () => get<ChatSettings>('/chat/settings'),
      setSettings: (body: Partial<ChatSettings>) => put<ChatSettings>('/chat/settings', body),
    },
    calls: {
      ice: () => get<{ iceServers: IceServer[]; turn: boolean }>('/calls/ice'),
      history: (p: Params) => get<Page<CallHistoryItem>>('/calls', p),
      current: () => get<{ call: CallView | null }>('/calls/current'),
    },

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
      transaction: (id: string) => get<InventoryTxDetail>(`/inventory/transactions/${id}`),
      reconciliation: () => get<{ balanceEggs: number; ledgerSumEggs: number; consistent: boolean }>('/inventory/reconciliation'),
      adjust: (body: { type: 'ADJUSTMENT' | 'DAMAGE' | 'LOSS' | 'USAGE'; direction?: 'INCREASE' | 'DECREASE'; unit: Unit; quantity: number; reason: string; clientId?: string }) => post('/inventory/adjustments', body),
    },

    reports: {
      run: (name: string, p: Params) => get<ReportResult>(`/reports/${name}`, p),
      exportPath: (name: string, p: Params) => `/v1/reports/${name}/export${qs(p)}`,
    },

    notifications: {
      list: (p: Params) => get<NotificationPage>('/notifications', p),
      get: (id: string) => get<AppNotification>(`/notifications/${id}`),
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
      me: () => get<UserSummary>('/auth/me'),
      updateProfile: (body: { fullName?: string; avatar?: string | null }) => api.request<UserSummary>('PATCH', '/v1/auth/profile', body),
      changeEmail: (newEmail: string, currentPassword: string) => post<UserSummary>('/auth/change-email', { newEmail, currentPassword }),
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
      invite: (body: { email: string; fullName: string; phone?: string; roleCodes: string[] }) => post<AdminUser & { emailSent: boolean }>('/users/invite', body),
      resendInvite: (id: string) => post<{ emailSent: boolean }>(`/users/${id}/resend-invite`),
      setRoles: (id: string, roleCodes: string[], reason: string) => put<AdminUser>(`/users/${id}/roles`, { roleCodes, reason }),
      disable: (id: string, reason: string) => post<AdminUser>(`/users/${id}/disable`, { reason }),
      reactivate: (id: string, reason: string) => post<AdminUser>(`/users/${id}/reactivate`, { reason }),
      userSessions: (id: string) => get<SessionInfo[]>(`/users/${id}/sessions`),
      revokeUserSessions: (id: string, reason: string) => del(`/users/${id}/sessions`, { reason }),
      resetMfa: (id: string, reason: string) => post(`/users/${id}/reset-mfa`, { reason }),
      roles: () => get<Role[]>('/roles'),
      audit: (p: Params) => get<Page<AuditEntry>>('/audit', p),
      backups: {
        status: () => get<BackupStatus>('/backups/status'),
        list: (p: Params) => get<Page<BackupJob>>('/backups', p),
        get: (id: string) => get<BackupJob>(`/backups/${id}`),
        runNow: () => post<BackupJob>('/backups'),
        verify: (id: string, deep: boolean) => post<{ ok: boolean; level: string; message?: string }>(`/backups/${id}/verify`, { deep }),
        settings: (body: { enabled?: boolean; scheduleTime?: string; retentionDays?: number; keepMonthly?: number }) => patch<BackupStatus>('/backups/settings', body),
        recoveries: () => get<RecoveryOp[]>('/recoveries'),
        recovery: (id: string) => get<RecoveryOp>(`/recoveries/${id}`),
        recover: (body: { backupId: string; password: string; code: string; confirm: string }) => post<RecoveryOp>('/recoveries', body),
      },
      verifyAudit: () => get<{ intact: boolean; firstInconsistentId: string | null; checked: number; total: number }>('/audit/verify'),
    },
  };
}

export interface ChatUser { id: string; name: string; role: string | null; hasAvatar: boolean; avatarVersion: number; online: boolean }
export interface ChatSettings { showPreviews: boolean; pushMessages: boolean; pushCalls: boolean }
export interface CallHistoryItem {
  id: string; conversationId: string; kind: 'AUDIO' | 'VIDEO'; status: string; endReason: string | null; peerId: string; peerName: string; direction: 'outgoing' | 'incoming';
  createdAt: string; answeredAt: string | null; endedAt: string | null; durationSeconds: number;
}

export type Endpoints = ReturnType<typeof createEndpoints>;

/** The REST half of the call engine (the socket half is in services/call-bridge). */
export const callApiFrom = (api: ApiClient): CallApi => {
  const post = <T>(path: string, body?: unknown) => api.request<T>('POST', `/v1${path}`, body ?? {});
  return {
    start: (conversationId, kind) => post('/calls', { conversationId, kind }),
    accept: (id) => post(`/calls/${id}/accept`), reject: (id) => post(`/calls/${id}/reject`), cancel: (id) => post(`/calls/${id}/cancel`), end: (id) => post(`/calls/${id}/end`),
  };
};
